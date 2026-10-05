-- Independent review follow-ups for 0042 (field encryption, work authorization).
--
-- R1 (MED-HIGH) The worker could mint data keys under any unused past month
--    label and then "rotate" a row to any plaintext sealed under that key,
--    silently replacing a visa number. Now:
--    a. authz.field_key_rotate accepts only the current UTC month, and the
--       field_key guard refuses a rotation key whose label is not the month
--       it is created in (at most one rotation key per class and real month).
--    b. work_authorization.number_mac = HMAC(blind index key, class, row id,
--       plaintext), computed by the API (KMS GenerateMac; the worker has no
--       right to it) and never changed by rotation. The reveal verifies it and
--       alerts on a mismatch, so a forged rotation is detected.
--    c. Every rotation swap is logged in eureka.field_rotation_log (row, from
--       key, to key, time); authz.field_rotation_alerts reports more than one
--       rotation key per class this month and rows rotated more than once this
--       month, which the job logs as alerts.
-- R2 (MED) A bogus newest key (any provider, key_ref, wrapped bytes) would
--    break every API write. field_key_first and field_key_rotate now validate
--    provider and key_ref format and the wrapped length, require the same
--    provider and key as the existing keys, and rotation needs an existing key
--    of the class. field_rotation_apply and the API write functions check
--    that the ciphertext header names the key's version (bytes 18-21).
-- R5 (LOW) The reveal rate limit was per API task, in memory. Now
--    authz.work_auth_reveal re-checks scope, counts the caller's reveal audit
--    rows (20 per minute, 200 per day) and writes the audit row itself.
-- Every IF is NULL-safe (see 0012/0015).
SET search_path = eureka, public;

SET ROLE eureka_owner;

-- ---------- R1b: integrity MAC ----------
-- Pre-production: no environment holds work authorization numbers yet, so the
-- constraint is validated (a local database with test rows needs a reseed).
ALTER TABLE eureka.work_authorization
  ADD COLUMN number_mac bytea,
  ADD CONSTRAINT work_authorization_number_mac CHECK (
    (number_enc IS NULL) = (number_mac IS NULL) AND (number_mac IS NULL OR octet_length(number_mac) = 32));

-- Rotation (no user) may change only the ciphertext and its key, never the MAC.
CREATE OR REPLACE FUNCTION eureka.work_authorization_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'work authorization rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'work authorization rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF actor IS NULL THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.row_version := 1;
    NEW.created_by := actor;
    NEW.updated_by := actor;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.person_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.person_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF actor IS NULL THEN
    IF (NEW.auth_type, NEW.valid_from, NEW.valid_to, NEW.status, NEW.row_version, NEW.updated_by, NEW.updated_at, NEW.number_mac)
       IS DISTINCT FROM (OLD.auth_type, OLD.valid_from, OLD.valid_to, OLD.status, OLD.row_version, OLD.updated_by, OLD.updated_at, OLD.number_mac)
       OR NEW.number_enc IS NULL OR OLD.number_enc IS NULL THEN
      RAISE EXCEPTION 'key rotation changes only the ciphertext' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_by := actor;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;

-- ---------- R1a: one rotation key per class and real month ----------
CREATE OR REPLACE FUNCTION eureka.field_key_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IS DISTINCT FROM 'INSERT' OR current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'field keys are only added, through definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := pg_catalog.now();
  IF NEW.rotation_key IS NOT NULL
     AND NEW.rotation_key IS DISTINCT FROM pg_catalog.to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM') THEN
    RAISE EXCEPTION 'a rotation key is labelled with the month it is created in' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------- R1c: rotation log ----------
CREATE TABLE eureka.field_rotation_log (
  seq         bigserial PRIMARY KEY,
  field_class text NOT NULL CHECK (field_class IN ('work_auth_number', 'dob')),
  row_id      uuid NOT NULL,
  from_key    uuid NOT NULL REFERENCES eureka.field_key(id),
  to_key      uuid NOT NULL REFERENCES eureka.field_key(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_rotation_log_row ON eureka.field_rotation_log (field_class, row_id, at);
CREATE INDEX field_rotation_log_at ON eureka.field_rotation_log (at);

CREATE FUNCTION eureka.field_rotation_log_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IS DISTINCT FROM 'INSERT' OR current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'the rotation log is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER field_rotation_log_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.field_rotation_log
  FOR EACH ROW EXECUTE FUNCTION eureka.field_rotation_log_guard();
CREATE TRIGGER field_rotation_log_no_truncate BEFORE TRUNCATE ON eureka.field_rotation_log
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.field_rotation_log_guard();

ALTER TABLE eureka.field_rotation_log ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.field_rotation_log FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_read   ON eureka.field_rotation_log FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.field_rotation_log FOR INSERT TO authz_definer WITH CHECK (true);

-- ---------- R5: reveal rate limit from the audit log ----------
CREATE INDEX audit_event_work_auth_reveal ON eureka.audit_event (actor_id, at)
  WHERE action = 'work_authorization.number_revealed';
CREATE POLICY work_auth_reveal_read ON eureka.audit_event FOR SELECT TO authz_definer
  USING (action = 'work_authorization.number_revealed');
CREATE POLICY work_auth_reveal_insert ON eureka.audit_event FOR INSERT TO authz_definer
  WITH CHECK (action = 'work_authorization.number_revealed' AND entity_type = 'work_authorization'
              AND actor_id IS NOT NULL AND actor_id = (SELECT authz.current_user_id()));

RESET ROLE;

REVOKE ALL ON eureka.field_rotation_log FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.field_rotation_log_guard() FROM PUBLIC;
GRANT SELECT, INSERT ON eureka.field_rotation_log TO authz_definer;
GRANT USAGE ON SEQUENCE eureka.field_rotation_log_seq_seq TO authz_definer;
GRANT UPDATE (number_mac) ON eureka.work_authorization TO authz_definer;
GRANT SELECT (actor_id, at) ON eureka.audit_event TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- R2: a well-formed key from the provider and key every existing key uses.
CREATE FUNCTION authz.field_key_valid(p_provider text, p_key_ref text, p_wrapped bytea) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    CASE p_provider
      WHEN 'kms' THEN p_key_ref ~ '^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-zA-Z-]+$'
                      AND octet_length(p_wrapped) BETWEEN 64 AND 512
      WHEN 'local' THEN p_key_ref ~ '^local:[0-9a-f]{16}$' AND octet_length(p_wrapped) = 60
      ELSE false
    END, false)
  AND NOT EXISTS (SELECT 1 FROM eureka.field_key k
                   WHERE (k.provider, k.key_ref) IS DISTINCT FROM (p_provider, p_key_ref))
$$;

CREATE OR REPLACE FUNCTION authz.field_key_first(p_id uuid, p_class text, p_provider text, p_key_ref text, p_wrapped bytea)
RETURNS TABLE (id uuid, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL OR p_class IS NULL THEN
    RAISE EXCEPTION 'invalid_key' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('field_key:' || p_class, 0));
  IF NOT EXISTS (SELECT 1 FROM eureka.field_key k WHERE k.field_class = p_class) THEN
    IF NOT coalesce(authz.field_key_valid(p_provider, p_key_ref, p_wrapped), false) THEN
      RAISE EXCEPTION 'invalid_key' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO eureka.field_key (id, field_class, version, provider, key_ref, wrapped_key, rotation_key)
    VALUES (p_id, p_class, 1, p_provider, p_key_ref, p_wrapped, NULL);
  END IF;
  RETURN QUERY SELECT k.id, k.version FROM eureka.field_key k
    WHERE k.field_class = p_class ORDER BY k.version DESC LIMIT 1;
END $$;

-- Worker: the current UTC month's key of a class (R1a). Returns no row when
-- the class has no key yet (nothing to rotate). Idempotent within the month.
CREATE OR REPLACE FUNCTION authz.field_key_rotate(p_id uuid, p_class text, p_provider text, p_key_ref text, p_wrapped bytea, p_rotation_key text)
RETURNS TABLE (id uuid, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_id IS NULL OR p_class IS NULL OR p_rotation_key IS NULL
     OR NOT coalesce(p_rotation_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$', false) THEN
    RAISE EXCEPTION 'invalid_key' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rotation_key IS DISTINCT FROM pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM') THEN
    RAISE EXCEPTION 'rotation key is not the current month' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('field_key:' || p_class, 0));
  IF NOT EXISTS (SELECT 1 FROM eureka.field_key k WHERE k.field_class = p_class) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.field_key k WHERE k.field_class = p_class AND k.rotation_key = p_rotation_key) THEN
    IF NOT coalesce(authz.field_key_valid(p_provider, p_key_ref, p_wrapped), false) THEN
      RAISE EXCEPTION 'invalid_key' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO eureka.field_key (id, field_class, version, provider, key_ref, wrapped_key, rotation_key)
    VALUES (p_id, p_class,
            (SELECT coalesce(pg_catalog.max(k.version), 0) + 1 FROM eureka.field_key k WHERE k.field_class = p_class),
            p_provider, p_key_ref, p_wrapped, p_rotation_key);
  END IF;
  RETURN QUERY SELECT k.id, k.version FROM eureka.field_key k
    WHERE k.field_class = p_class AND k.rotation_key = p_rotation_key;
END $$;

-- The ciphertext header names this key and its version (bytes 2-17, 18-21).
CREATE FUNCTION authz.field_header_matches(p_enc bytea, p_key uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((
    SELECT pg_catalog.get_byte(p_enc, 0) = 1
       AND substring(p_enc FROM 2 FOR 16) = pg_catalog.uuid_send(k.id)
       AND substring(p_enc FROM 18 FOR 4) = pg_catalog.int4send(k.version)
      FROM eureka.field_key k WHERE k.id = p_key), false)
$$;

CREATE OR REPLACE FUNCTION authz.field_rotation_apply(p_class text, p_row uuid, p_old_enc bytea, p_new_enc bytea, p_new_key uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE new_version integer; old_version integer; old_key uuid;
BEGIN
  IF p_class IS DISTINCT FROM 'work_auth_number' THEN
    RAISE EXCEPTION 'unsupported field class' USING ERRCODE = 'check_violation';
  END IF;
  IF p_row IS NULL OR p_old_enc IS NULL OR p_new_enc IS NULL
     OR p_new_key IS NULL OR p_new_key IS DISTINCT FROM authz.field_key_newest(p_class) THEN
    RAISE EXCEPTION 'not_current_key' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(authz.field_header_matches(p_new_enc, p_new_key), false) THEN
    RAISE EXCEPTION 'invalid_ciphertext' USING ERRCODE = 'check_violation';
  END IF;
  SELECT k.version INTO new_version FROM eureka.field_key k WHERE k.id = p_new_key;
  SELECT k.version, k.id INTO old_version, old_key FROM eureka.field_key k
    JOIN eureka.work_authorization w ON w.number_key_id = k.id WHERE w.id = p_row;
  IF old_version IS NULL OR NOT coalesce(new_version > old_version, false) THEN
    RETURN false;
  END IF;
  UPDATE eureka.work_authorization w SET number_enc = p_new_enc, number_key_id = p_new_key
   WHERE w.id = p_row AND w.number_enc = p_old_enc;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO eureka.field_rotation_log (field_class, row_id, from_key, to_key) VALUES (p_class, p_row, old_key, p_new_key);
  RETURN true;
END $$;

-- Worker: anomalies of the current UTC month for a class (logged as alerts by the job).
CREATE FUNCTION authz.field_rotation_alerts(p_class text)
RETURNS TABLE (rotation_keys_this_month integer, keys_this_month integer, rows_rotated_more_than_once integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH month AS (SELECT pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start)
  SELECT
    (SELECT pg_catalog.count(*)::integer FROM eureka.field_key k, month
      WHERE k.field_class = p_class AND k.rotation_key IS NOT NULL AND k.created_at >= month.start),
    (SELECT pg_catalog.count(*)::integer FROM eureka.field_key k, month
      WHERE k.field_class = p_class AND k.created_at >= month.start),
    (SELECT pg_catalog.count(*)::integer FROM (
       SELECT l.row_id FROM eureka.field_rotation_log l, month
        WHERE l.field_class = p_class AND l.at >= month.start
        GROUP BY l.row_id HAVING pg_catalog.count(*) > 1) x)
$$;

-- A new number: a work_auth_number key, a header naming that key's version, a 32-byte MAC.
CREATE FUNCTION authz.work_auth_check_number(p_enc bytea, p_key uuid, p_mac bytea) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (p_enc IS NULL) IS DISTINCT FROM (p_key IS NULL) OR (p_enc IS NULL) IS DISTINCT FROM (p_mac IS NULL) THEN
    RAISE EXCEPTION 'invalid_number' USING ERRCODE = 'check_violation';
  END IF;
  IF p_key IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM eureka.field_key k WHERE k.id = p_key AND k.field_class = 'work_auth_number')
       OR NOT coalesce(authz.field_header_matches(p_enc, p_key), false)
       OR octet_length(p_mac) IS DISTINCT FROM 32) THEN
    RAISE EXCEPTION 'invalid_number' USING ERRCODE = 'check_violation';
  END IF;
END $$;

DROP FUNCTION authz.work_auth_create(uuid, uuid, text, bytea, uuid, date, date, text);
DROP FUNCTION authz.work_auth_update(uuid, uuid, integer, text, boolean, bytea, uuid, date, date, text);
DROP FUNCTION authz.work_auth_check_key(bytea, uuid);

CREATE FUNCTION authz.work_auth_create(
  p_id uuid, p_candidate uuid, p_type text, p_number_enc bytea, p_number_key uuid, p_number_mac bytea,
  p_valid_from date, p_valid_to date, p_status text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_person uuid;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_candidate IS NULL
     OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false)
     OR NOT coalesce(authz.candidate_owned(p_candidate, 'visa:read'), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_owned(p_candidate, 'visa:update'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL OR p_type IS NULL OR p_status IS NULL THEN
    RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM authz.work_auth_check_number(p_number_enc, p_number_key, p_number_mac);
  SELECT c.person_id INTO v_person FROM eureka.candidate c WHERE c.id = p_candidate;
  INSERT INTO eureka.work_authorization (id, person_id, auth_type, number_enc, number_key_id, number_mac,
                                         valid_from, valid_to, status, created_by, updated_by)
  VALUES (p_id, v_person, p_type, p_number_enc, p_number_key, p_number_mac, p_valid_from, p_valid_to, p_status,
          authz.current_user_id(), authz.current_user_id());
  RETURN 1;
END $$;

CREATE FUNCTION authz.work_auth_update(
  p_id uuid, p_candidate uuid, p_row_version integer, p_type text, p_set_number boolean,
  p_number_enc bytea, p_number_key uuid, p_number_mac bytea,
  p_valid_from date, p_valid_to date, p_status text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w eureka.work_authorization%ROWTYPE; out_version integer;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_candidate IS NULL
     OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false)
     OR NOT coalesce(authz.candidate_owned(p_candidate, 'visa:read'), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT x.* INTO w FROM eureka.work_authorization x
    JOIN eureka.candidate c ON c.person_id = x.person_id
   WHERE x.id = p_id AND c.id = p_candidate
   FOR UPDATE OF x;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_owned(p_candidate, 'visa:update'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_row_version IS NULL OR p_row_version IS DISTINCT FROM w.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  IF p_type IS NULL OR p_status IS NULL OR p_set_number IS NULL THEN
    RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'check_violation';
  END IF;
  IF p_set_number THEN
    PERFORM authz.work_auth_check_number(p_number_enc, p_number_key, p_number_mac);
    UPDATE eureka.work_authorization x
       SET auth_type = p_type, number_enc = p_number_enc, number_key_id = p_number_key, number_mac = p_number_mac,
           valid_from = p_valid_from, valid_to = p_valid_to, status = p_status
     WHERE x.id = p_id RETURNING x.row_version INTO out_version;
  ELSE
    UPDATE eureka.work_authorization x
       SET auth_type = p_type, valid_from = p_valid_from, valid_to = p_valid_to, status = p_status
     WHERE x.id = p_id RETURNING x.row_version INTO out_version;
  END IF;
  RETURN out_version;
END $$;

-- API: records one reveal (R5). Scope re-checked (visa:read over the
-- candidate, the record belongs to it and holds a number); at most 20 reveals
-- per user per minute and 200 per day across all API tasks; writes the audit
-- row (ids only, including the step-up grant the API checked with
-- requireStepUp in this transaction, migration 0043). The API decrypts only
-- after this succeeds.
CREATE FUNCTION authz.work_auth_reveal(p_id uuid, p_candidate uuid, p_step_up_grant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_user_id();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_step_up_grant IS NULL THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL OR p_candidate IS NULL
     OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false)
     OR NOT coalesce(authz.candidate_owned(p_candidate, 'visa:read'), false)
     OR NOT EXISTS (SELECT 1 FROM eureka.work_authorization w JOIN eureka.candidate c ON c.person_id = w.person_id
                     WHERE w.id = p_id AND c.id = p_candidate AND w.number_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('work_auth_reveal:' || me::text, 0));
  IF (SELECT pg_catalog.count(*) FROM eureka.audit_event a
       WHERE a.actor_id = me AND a.action = 'work_authorization.number_revealed'
         AND a.at > pg_catalog.now() - interval '1 minute') >= 20
     OR (SELECT pg_catalog.count(*) FROM eureka.audit_event a
       WHERE a.actor_id = me AND a.action = 'work_authorization.number_revealed'
         AND a.at > pg_catalog.now() - interval '1 day') >= 200 THEN
    RAISE EXCEPTION 'too_many_reveals' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (me, 'work_authorization.number_revealed', 'work_authorization', p_id,
          pg_catalog.jsonb_build_object('candidateId', p_candidate, 'stepUpGrantId', p_step_up_grant));
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.field_key_valid(text, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.field_header_matches(bytea, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.field_rotation_alerts(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.work_auth_check_number(bytea, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.work_auth_create(uuid, uuid, text, bytea, uuid, bytea, date, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.work_auth_update(uuid, uuid, integer, text, boolean, bytea, uuid, bytea, date, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.work_auth_reveal(uuid, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION authz.work_auth_create(uuid, uuid, text, bytea, uuid, bytea, date, date, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.work_auth_update(uuid, uuid, integer, text, boolean, bytea, uuid, bytea, date, date, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.work_auth_reveal(uuid, uuid, uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.field_rotation_alerts(text) TO eureka_worker;
-- field_key_valid, field_header_matches and work_auth_check_number are called from definer functions only.
