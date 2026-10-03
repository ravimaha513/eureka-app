-- Paperwork and compliance documents, restricted documents and step-up
-- (FR-PPR-01 to 03; design A6.1 "Step-up", A6.3, A6.4, A6.5 "Uploads",
-- B2.4 `document` / `file_object`, B4.4 "Documents", B5 flow 5).
--
--   * authz.document_type: the document types (stable keys the paperwork
--     checklist's doc_type refers to) and their classification. Restricted
--     per A6.3: I-9, driving license, work-authorization copies. Owned by
--     authz_definer; the app reads it. packages/shared DOCUMENT_TYPES holds
--     the same list (a test compares them).
--   * eureka.file_object: one uploaded file and its malware-scan state, on the
--     resume pipeline (0036): presigned POST into quarantine/documents/<id>,
--     GuardDuty tag polled by the worker (document-scan), content inspection,
--     create-only promotion to clean/documents/<id> or, for restricted files,
--     restricted/documents/<id> under the restricted KMS key.
--   * eureka.document: a typed document about a candidate (the person),
--     optionally filed on one of the candidate's placements. Deviation from
--     B2.4 ("candidate_id or placement_id, exactly one"): candidate_id is
--     always set (the placement's candidate for placement documents) so
--     visibility is one rule over the candidate, as for resumes (B4.4
--     "document:read scope over the owning candidate"), and Immigration and
--     the Documents Team, who hold no placement:read, still reach them.
--     The classification is copied from the type when the row is created and
--     never changes (it decides the storage prefix and KMS key).
--   * eureka.document_access: append-only access log; one row per download
--     link issued (restricted or not), written with the audit row in the same
--     definer call. Restricted rows carry the step-up grant that allowed them.
--   * eureka.step_up_challenge / eureka.step_up_grant: Google re-
--     authentication (A6.1). A challenge (hashed OIDC state and nonce) is bound
--     to the session and consumed once; a grant is bound to the session's
--     hashed id and the user, lives at most 15 minutes and dies with the
--     session. Dev-mode grants need authz.policy_setting dev_step_up = 'on',
--     which no migration sets (the dev seed and tests do), so production
--     refuses them in the database as well as in the API.
--
-- Visibility (B4.4): document:read covering the candidate (ownership, team,
-- hierarchy, location, org; never the all-teams rule) and the candidate
-- readable; restricted documents also need document.restricted:read over the
-- candidate (HR, Accounts, Immigration). Downloads of restricted documents
-- also need a live step-up grant for the caller's session.
-- Rows carry ids, types, sizes and hashes only: no file names (rule 5).
-- Every IF is NULL-safe (rule 1).
SET search_path = eureka, public;

-- ---------- document types (configuration) ----------
SET ROLE authz_definer;

CREATE TABLE authz.document_type (
  key            text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label          text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80 AND label !~ '[[:cntrl:]]'),
  classification text NOT NULL CHECK (classification IN ('internal', 'restricted'))
);
INSERT INTO authz.document_type (key, label, classification) VALUES
  ('i9', 'Form I-9', 'restricted'),
  ('drivers_license', 'Driving license', 'restricted'),
  ('work_authorization', 'Work authorization copy', 'restricted'),
  ('offer_letter', 'Offer letter', 'internal'),
  ('other', 'Other document', 'internal');

-- A type is never reclassified or removed once documents may use it: a
-- downgrade would not move stored files, and the copy on each document keeps
-- deciding access anyway.
CREATE FUNCTION authz.document_type_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (NEW.key, NEW.classification) IS DISTINCT FROM (OLD.key, OLD.classification)) THEN
    RAISE EXCEPTION 'document types are not removed or reclassified' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER document_type_guard BEFORE UPDATE OR DELETE ON authz.document_type
  FOR EACH ROW EXECUTE FUNCTION authz.document_type_guard();

REVOKE ALL ON authz.document_type FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.document_type_guard() FROM PUBLIC;
GRANT SELECT ON authz.document_type TO eureka_app;
GRANT REFERENCES (key) ON authz.document_type TO eureka_owner;

-- The dev step-up switch (absent = off). Only the dev seed and tests set it.
ALTER TABLE authz.policy_setting
  ADD CONSTRAINT policy_setting_dev_step_up CHECK (key <> 'dev_step_up' OR value IN ('on', 'off'));

RESET ROLE;

-- ---------- tables ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.file_object (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  classification    text NOT NULL CHECK (classification IN ('internal', 'restricted')),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'clean', 'infected', 'failed', 'rejected', 'expired')),
  -- GuardDuty result or the worker's reason code (as resume.scan_result).
  scan_result       text CHECK (scan_result ~ '^[A-Z_]{1,40}$'),
  content_type      text NOT NULL CHECK (content_type IN (
                      'application/pdf',
                      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      'image/png',
                      'image/jpeg')),
  size_bytes        integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 15728640),
  sha256_hex        text CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  uploaded_by       uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  upload_expires_at timestamptz NOT NULL,
  scanned_at        timestamptz,
  CONSTRAINT file_object_clean_complete CHECK ((status = 'clean') = (sha256_hex IS NOT NULL)),
  CONSTRAINT file_object_scanned CHECK ((status = 'pending') = (scanned_at IS NULL))
);
CREATE INDEX file_object_pending ON eureka.file_object (created_at) WHERE status = 'pending';

CREATE TABLE eureka.document (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id   uuid NOT NULL REFERENCES eureka.candidate(id),
  placement_id   uuid REFERENCES eureka.placement(id),
  doc_type       text NOT NULL REFERENCES authz.document_type(key),
  classification text NOT NULL CHECK (classification IN ('internal', 'restricted')),
  file_id        uuid NOT NULL UNIQUE REFERENCES eureka.file_object(id),
  created_by     uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_candidate ON eureka.document (candidate_id, created_at DESC);
CREATE INDEX document_placement ON eureka.document (placement_id, created_at DESC) WHERE placement_id IS NOT NULL;

CREATE TABLE eureka.step_up_challenge (
  state_hash   bytea PRIMARY KEY CHECK (octet_length(state_hash) = 32),
  session_hash bytea NOT NULL REFERENCES eureka.session(id_hash) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  nonce_hash   bytea NOT NULL CHECK (octet_length(nonce_hash) = 32),
  -- Where the browser returns afterwards: a same-origin path only.
  return_to    text NOT NULL CHECK (return_to ~ '^/[A-Za-z0-9/_.?=&%-]{0,200}$' AND return_to !~ '^//'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  outcome      text CHECK (outcome ~ '^[a-z_]{1,40}$')
);
CREATE INDEX step_up_challenge_session ON eureka.step_up_challenge (session_hash, created_at);

CREATE TABLE eureka.step_up_grant (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash bytea NOT NULL REFERENCES eureka.session(id_hash) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  method       text NOT NULL CHECK (method IN ('google', 'dev')),
  auth_time    timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CONSTRAINT step_up_grant_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX step_up_grant_session ON eureka.step_up_grant (session_hash, expires_at DESC);

CREATE TABLE eureka.document_access (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid NOT NULL REFERENCES eureka.document(id),
  user_id          uuid NOT NULL REFERENCES eureka.app_user(id),
  action           text NOT NULL CHECK (action IN ('download')),
  -- Copies, so the log reads without access to the document itself (audit:read).
  doc_type         text NOT NULL,
  classification   text NOT NULL CHECK (classification IN ('internal', 'restricted')),
  -- Not a foreign key: the log outlives sessions and their grants.
  step_up_grant_id uuid,
  at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_access_step_up CHECK (classification <> 'restricted' OR step_up_grant_id IS NOT NULL)
);
CREATE INDEX document_access_document ON eureka.document_access (document_id, at DESC);
CREATE INDEX document_access_at ON eureka.document_access (at DESC, id);

-- ---------- write guards (rules 4 and 6) ----------

-- file_object: written only inside authz_definer functions; the server sets
-- every managed column; a scanned file is final.
CREATE FUNCTION eureka.file_object_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'file_object rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'file_object rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'pending';
    NEW.scan_result := NULL;
    NEW.sha256_hex := NULL;
    NEW.uploaded_by := authz.current_user_id();
    NEW.created_at := pg_catalog.now();
    NEW.upload_expires_at := pg_catalog.now() + interval '5 minutes';
    NEW.scanned_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.classification, NEW.content_type, NEW.size_bytes, NEW.uploaded_by, NEW.created_at, NEW.upload_expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.classification, OLD.content_type, OLD.size_bytes, OLD.uploaded_by, OLD.created_at, OLD.upload_expires_at) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'a scanned file is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'a scan result must leave pending' USING ERRCODE = 'check_violation';
  END IF;
  NEW.scanned_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER file_object_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.file_object
  FOR EACH ROW EXECUTE FUNCTION eureka.file_object_write_guard();

-- document: insert-only through definer functions; the creator, time and
-- classification are the server's (the classification comes from the type
-- and must match the file's).
CREATE FUNCTION eureka.document_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE cls text;
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'document rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP IS DISTINCT FROM 'INSERT' THEN
    RAISE EXCEPTION 'document rows are not changed or deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.classification INTO cls FROM authz.document_type t WHERE t.key = NEW.doc_type;
  IF cls IS NULL OR NOT EXISTS (
       SELECT 1 FROM eureka.file_object f WHERE f.id = NEW.file_id AND f.classification = cls AND f.status = 'pending') THEN
    RAISE EXCEPTION 'document type and file do not match' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.placement_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM eureka.placement p WHERE p.id = NEW.placement_id AND p.candidate_id = NEW.candidate_id) THEN
    RAISE EXCEPTION 'placement belongs to another candidate' USING ERRCODE = 'check_violation';
  END IF;
  NEW.classification := cls;
  NEW.created_by := authz.current_user_id();
  NEW.created_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER document_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.document
  FOR EACH ROW EXECUTE FUNCTION eureka.document_write_guard();

-- Append-only rows written by definer functions: document_access and the
-- step-up grant. The challenge may only be consumed (used_at, outcome) once.
CREATE FUNCTION eureka.step_up_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION '% rows are written only by definer functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'step_up_challenge' THEN
      NEW.created_at := pg_catalog.now();
      NEW.expires_at := pg_catalog.now() + interval '10 minutes';
      NEW.used_at := NULL;
      NEW.outcome := NULL;
    ELSIF TG_TABLE_NAME = 'step_up_grant' THEN
      NEW.created_at := pg_catalog.now();
    ELSIF TG_TABLE_NAME = 'document_access' THEN
      NEW.user_id := authz.current_user_id();
      NEW.at := pg_catalog.now();
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'step_up_challenge'
     AND OLD.used_at IS NULL AND NEW.used_at IS NOT NULL
     AND (NEW.state_hash, NEW.session_hash, NEW.user_id, NEW.nonce_hash, NEW.return_to, NEW.created_at, NEW.expires_at)
         IS NOT DISTINCT FROM
         (OLD.state_hash, OLD.session_hash, OLD.user_id, OLD.nonce_hash, OLD.return_to, OLD.created_at, OLD.expires_at) THEN
    NEW.used_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER step_up_challenge_write_guard BEFORE INSERT OR UPDATE ON eureka.step_up_challenge
  FOR EACH ROW EXECUTE FUNCTION eureka.step_up_write_guard();
CREATE TRIGGER step_up_grant_write_guard BEFORE INSERT OR UPDATE ON eureka.step_up_grant
  FOR EACH ROW EXECUTE FUNCTION eureka.step_up_write_guard();
CREATE TRIGGER document_access_write_guard BEFORE INSERT OR UPDATE ON eureka.document_access
  FOR EACH ROW EXECUTE FUNCTION eureka.step_up_write_guard();

-- No DELETE on the log and the document tables, from anyone (owner and superuser
-- included). Step-up rows go with their session (ON DELETE CASCADE); no role
-- has DELETE on them otherwise.
CREATE FUNCTION eureka.document_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER document_access_no_delete BEFORE DELETE ON eureka.document_access
  FOR EACH ROW EXECUTE FUNCTION eureka.document_no_delete();
CREATE TRIGGER document_access_no_truncate BEFORE TRUNCATE ON eureka.document_access
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.document_no_delete();
CREATE TRIGGER document_no_truncate BEFORE TRUNCATE ON eureka.document
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.document_no_delete();
CREATE TRIGGER file_object_no_truncate BEFORE TRUNCATE ON eureka.file_object
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.document_no_delete();

-- ---------- RLS ----------
ALTER TABLE eureka.file_object ENABLE ROW LEVEL SECURITY;       ALTER TABLE eureka.file_object FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.document ENABLE ROW LEVEL SECURITY;          ALTER TABLE eureka.document FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.document_access ENABLE ROW LEVEL SECURITY;   ALTER TABLE eureka.document_access FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.step_up_challenge ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.step_up_challenge FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.step_up_grant ENABLE ROW LEVEL SECURITY;     ALTER TABLE eureka.step_up_grant FORCE ROW LEVEL SECURITY;

-- Rule 3: scope arrays as InitPlans, the candidate by primary key under the
-- caller's candidate policy (so the candidate must be readable too).
CREATE POLICY document_read ON eureka.document FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.id = document.candidate_id
    AND ((SELECT authz.has_org('document:read'))
         OR c.recruiter_id = ANY ((SELECT authz.recruiter_ids('document:read'))::uuid[])
         OR c.team_id      = ANY ((SELECT authz.team_ids('document:read'))::uuid[])
         OR c.location_id  = ANY ((SELECT authz.location_ids('document:read'))::uuid[]))
    AND (document.classification = 'internal'
         OR (SELECT authz.has_org('document.restricted:read'))
         OR c.recruiter_id = ANY ((SELECT authz.recruiter_ids('document.restricted:read'))::uuid[])
         OR c.team_id      = ANY ((SELECT authz.team_ids('document.restricted:read'))::uuid[])
         OR c.location_id  = ANY ((SELECT authz.location_ids('document.restricted:read'))::uuid[])))
);
-- A file is readable with its document (unique file_id: a key probe).
CREATE POLICY file_object_read ON eureka.file_object FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.document d WHERE d.file_id = file_object.id)
);
-- The access log: org-wide audit:read (org admins), or the log of a
-- restricted document the caller can read (HR, Accounts, Immigration).
CREATE POLICY document_access_read ON eureka.document_access FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('audit:read'))
  OR EXISTS (SELECT 1 FROM eureka.document d WHERE d.id = document_access.document_id AND d.classification = 'restricted')
);

CREATE POLICY definer_read   ON eureka.file_object FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.file_object FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.file_object FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.document FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.document FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.document_access FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.document_access FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.step_up_challenge FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.step_up_challenge FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.step_up_challenge FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.step_up_grant FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.step_up_grant FOR INSERT TO authz_definer WITH CHECK (true);

-- The definer functions below write their own audit rows (same transaction as
-- the change; actor is always the caller; ids and codes only).
CREATE POLICY document_definer_audit ON eureka.audit_event FOR INSERT TO authz_definer WITH CHECK (
  actor_id IS NOT NULL AND actor_id = authz.current_user_id()
  AND action IN ('document.upload_requested', 'document.viewed', 'document.downloaded', 'document.view_refused',
                 'auth.step_up', 'auth.step_up_failed'));

RESET ROLE;

REVOKE ALL ON eureka.file_object, eureka.document, eureka.document_access, eureka.step_up_challenge, eureka.step_up_grant FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.file_object_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.document_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.step_up_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.document_no_delete() FROM PUBLIC;
GRANT SELECT ON eureka.file_object, eureka.document, eureka.document_access TO eureka_app;
GRANT SELECT, INSERT ON eureka.file_object, eureka.document, eureka.document_access, eureka.step_up_challenge, eureka.step_up_grant TO authz_definer;
GRANT UPDATE (status, scan_result, sha256_hex, scanned_at) ON eureka.file_object TO authz_definer;
GRANT UPDATE (used_at, outcome) ON eureka.step_up_challenge TO authz_definer;
-- Step-up checks the caller's session (0013 granted user_id and revoked_at).
GRANT SELECT (id_hash, user_id, expires_at, revoked_at) ON eureka.session TO authz_definer;
-- The guards read the type, the file and the placement inside definer calls.
GRANT SELECT (id, candidate_id) ON eureka.placement TO authz_definer;
-- 0033/0037 granted these columns; repeated so this migration stands alone.
GRANT INSERT (actor_id, action, entity_type, entity_id, changes) ON eureka.audit_event TO authz_definer;
GRANT USAGE ON SEQUENCE eureka.audit_event_seq_seq TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- The caller's own live session (by its hashed id). The idle timeout is the
-- API's (it resolved this session for the same request).
CREATE FUNCTION authz.session_is_mine(p_session bytea) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_session IS NOT NULL AND authz.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM eureka.session s JOIN eureka.app_user u ON u.id = s.user_id AND u.status = 'active'
    WHERE s.id_hash = p_session AND s.user_id = authz.current_user_id()
      AND s.revoked_at IS NULL AND s.expires_at > pg_catalog.now())
$$;

-- The live step-up grant of the caller's session, if any (newest first).
CREATE FUNCTION authz.step_up_current(p_session bytea)
RETURNS TABLE (grant_id uuid, method text, auth_time timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT g.id, g.method, g.auth_time, g.expires_at FROM eureka.step_up_grant g
  WHERE coalesce(authz.session_is_mine(p_session), false)
    AND g.session_hash = p_session AND g.user_id = authz.current_user_id()
    AND g.expires_at > pg_catalog.now()
  ORDER BY g.expires_at DESC, g.id
  LIMIT 1
$$;

-- API: starts a Google re-authentication for the caller's session. Stores
-- the hashed OIDC state and nonce (the browser holds neither in clear here;
-- the PKCE verifier and nonce travel in a signed cookie). At most ten
-- challenges per session in ten minutes.
CREATE FUNCTION authz.step_up_begin(p_session bytea, p_state_hash bytea, p_nonce_hash bytea, p_return_to text)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE exp timestamptz;
BEGIN
  IF NOT coalesce(authz.session_is_mine(p_session), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_state_hash IS NULL OR p_nonce_hash IS NULL OR p_return_to IS NULL THEN
    RAISE EXCEPTION 'invalid_step_up' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('step_up:' || pg_catalog.encode(p_session, 'hex'), 0));
  IF (SELECT pg_catalog.count(*) FROM eureka.step_up_challenge c
       WHERE c.session_hash = p_session AND c.created_at > pg_catalog.now() - interval '10 minutes') >= 10 THEN
    RAISE EXCEPTION 'too_many_step_ups' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.step_up_challenge AS c (state_hash, session_hash, user_id, nonce_hash, return_to, expires_at)
  VALUES (p_state_hash, p_session, authz.current_user_id(), p_nonce_hash, p_return_to, pg_catalog.now())
  RETURNING c.expires_at INTO exp;
  RETURN exp;
END $$;

-- API: finishes a Google re-authentication after the API verified the ID
-- token (signature, issuer, audience, hd, email). Consumes the challenge
-- (single use, also on failure: a replayed callback finds it used) and grants
-- step-up only when the challenge belongs to this session and user and has
-- not expired, the token's nonce hash matches, the Google account (sub) is
-- the one linked to this user, and auth_time proves a sign-in after the
-- challenge started and within p_max_age_seconds (at most 15 minutes).
-- Outcomes other than 'granted' are returned, not raised, so the consumption
-- and the audit row commit.
CREATE FUNCTION authz.step_up_complete(
  p_session bytea, p_state_hash bytea, p_nonce_hash bytea, p_sub text, p_auth_time timestamptz,
  p_max_age_seconds integer, p_ttl_minutes integer)
RETURNS TABLE (outcome text, grant_id uuid, expires_at timestamptz, return_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c eureka.step_up_challenge%ROWTYPE;
  why text;
  max_age integer := LEAST(GREATEST(coalesce(p_max_age_seconds, 0), 0), 900);
  ttl integer := LEAST(GREATEST(coalesce(p_ttl_minutes, 1), 1), 15);
  g_id uuid; g_exp timestamptz;
BEGIN
  IF NOT coalesce(authz.session_is_mine(p_session), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO c FROM eureka.step_up_challenge x
   WHERE x.state_hash = p_state_hash AND x.session_hash = p_session AND x.user_id = authz.current_user_id()
   FOR UPDATE;
  IF NOT FOUND THEN
    why := 'unknown_state';
  ELSIF c.used_at IS NOT NULL THEN
    why := 'replayed';
  ELSE
    IF NOT coalesce(c.expires_at > pg_catalog.now(), false) THEN
      why := 'expired';
    ELSIF p_nonce_hash IS NULL OR p_nonce_hash IS DISTINCT FROM c.nonce_hash THEN
      why := 'nonce_mismatch';
    ELSIF p_sub IS NULL OR NOT EXISTS (
        SELECT 1 FROM eureka.app_user u WHERE u.id = authz.current_user_id() AND u.google_sub = p_sub AND u.status = 'active') THEN
      why := 'wrong_account';
    ELSIF p_auth_time IS NULL
        OR NOT coalesce(p_auth_time >= c.created_at - interval '60 seconds', false)
        OR NOT coalesce(p_auth_time <= pg_catalog.now() + interval '60 seconds', false)
        OR NOT coalesce(p_auth_time >= pg_catalog.now() - pg_catalog.make_interval(secs => max_age), false) THEN
      why := 'stale_auth';
    ELSE
      why := 'granted';
    END IF;
    UPDATE eureka.step_up_challenge SET used_at = pg_catalog.now(), outcome = why WHERE state_hash = c.state_hash;
  END IF;

  IF why IS DISTINCT FROM 'granted' THEN
    INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
    VALUES (authz.current_user_id(), 'auth.step_up_failed', 'app_user', authz.current_user_id(),
            pg_catalog.jsonb_build_object('method', 'google', 'reason', why));
    RETURN QUERY SELECT why, NULL::uuid, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;

  INSERT INTO eureka.step_up_grant AS g (session_hash, user_id, method, auth_time, expires_at)
  VALUES (p_session, authz.current_user_id(), 'google', p_auth_time, pg_catalog.now() + pg_catalog.make_interval(mins => ttl))
  RETURNING g.id, g.expires_at INTO g_id, g_exp;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'auth.step_up', 'app_user', authz.current_user_id(),
          pg_catalog.jsonb_build_object('method', 'google', 'grantId', g_id, 'expiresAt', g_exp));
  RETURN QUERY SELECT 'granted'::text, g_id, g_exp, c.return_to;
END $$;

-- API, development only: a step-up grant without an identity provider. The
-- API refuses it unless AUTH_MODE=dev outside production; the database
-- refuses it unless authz.policy_setting dev_step_up = 'on' (never set by a
-- migration; the dev seed and tests set it).
CREATE FUNCTION authz.step_up_dev(p_session bytea, p_ttl_minutes integer)
RETURNS TABLE (grant_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ttl integer := LEAST(GREATEST(coalesce(p_ttl_minutes, 1), 1), 15); g_id uuid; g_exp timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM authz.policy_setting s WHERE s.key = 'dev_step_up' AND s.value = 'on') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(authz.session_is_mine(p_session), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO eureka.step_up_grant AS g (session_hash, user_id, method, auth_time, expires_at)
  VALUES (p_session, authz.current_user_id(), 'dev', pg_catalog.now(), pg_catalog.now() + pg_catalog.make_interval(mins => ttl))
  RETURNING g.id, g.expires_at INTO g_id, g_exp;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'auth.step_up', 'app_user', authz.current_user_id(),
          pg_catalog.jsonb_build_object('method', 'dev', 'grantId', g_id, 'expiresAt', g_exp));
  RETURN QUERY SELECT g_id, g_exp;
END $$;

-- API: a pending document with its file, for a candidate or one of the
-- candidate's placements. 404-equivalent when the candidate (or placement)
-- is not readable; 403 when document:upload (and, for a restricted type,
-- document.restricted:read) does not cover the candidate; 422 for an unknown
-- type, a type outside the allowlist or a bad size; 409 with five uploads of
-- the candidate still waiting. Audited (ids, type, size).
CREATE FUNCTION authz.create_document_upload(
  p_candidate uuid, p_placement uuid, p_doc_type text, p_content_type text, p_size integer)
RETURNS TABLE (document_id uuid, file_id uuid, classification text, upload_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cand uuid; cls text; f_id uuid; f_exp timestamptz; d_id uuid;
  p record;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_candidate IS NULL) = (p_placement IS NULL) THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  IF p_placement IS NOT NULL THEN
    SELECT x.candidate_id, x.recruiter_id, x.team_id, x.location_id INTO p FROM eureka.placement x WHERE x.id = p_placement;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT coalesce(
         authz.owns('placement:read', p.recruiter_id, p.team_id, p.location_id)
         OR authz.candidate_owned(p.candidate_id, 'placement:read'), false) THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
    END IF;
    cand := p.candidate_id;
  ELSE
    cand := p_candidate;
  END IF;
  IF NOT coalesce(authz.candidate_visible(cand, 'candidate:read'), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_owned(cand, 'document:upload'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.classification INTO cls FROM authz.document_type t WHERE t.key = p_doc_type;
  IF cls IS NULL THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  IF cls IS NOT DISTINCT FROM 'restricted' AND NOT coalesce(authz.candidate_owned(cand, 'document.restricted:read'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_content_type IS NULL OR p_size IS NULL
     OR p_content_type NOT IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                               'image/png', 'image/jpeg')
     OR NOT coalesce(p_size BETWEEN 1 AND 15728640, false) THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('document:' || cand::text, 0));
  IF (SELECT pg_catalog.count(*) FROM eureka.document d JOIN eureka.file_object f ON f.id = d.file_id
       WHERE d.candidate_id = cand AND f.status = 'pending') >= 5 THEN
    RAISE EXCEPTION 'too_many_pending' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.file_object AS f (classification, content_type, size_bytes, uploaded_by, upload_expires_at)
  VALUES (cls, p_content_type, p_size, authz.current_user_id(), pg_catalog.now())
  RETURNING f.id, f.upload_expires_at INTO f_id, f_exp;
  INSERT INTO eureka.document AS d (candidate_id, placement_id, doc_type, classification, file_id, created_by)
  VALUES (cand, p_placement, p_doc_type, cls, f_id, authz.current_user_id())
  RETURNING d.id INTO d_id;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'document.upload_requested', 'document', d_id, pg_catalog.jsonb_build_object(
    'candidateId', cand, 'placementId', p_placement, 'fileId', f_id, 'docType', p_doc_type,
    'classification', cls, 'contentType', p_content_type, 'sizeBytes', p_size));
  RETURN QUERY SELECT d_id, f_id, cls, f_exp;
END $$;

-- API: authorizes one download of a document's file and logs it (access
-- log + audit, same transaction). Not visible (candidate, document:read or,
-- for restricted documents, document.restricted:read) -> not_found.
-- Restricted without a live step-up grant of the caller's session ->
-- 'step_up_required' (the refusal is audited, nothing else is written).
-- File not clean -> 'not_available'. 'ok' returns what the API needs to sign
-- the link: never a key chosen by the client.
CREATE FUNCTION authz.document_download(p_document uuid, p_session bytea)
RETURNS TABLE (outcome text, file_id uuid, classification text, content_type text, doc_type text,
               candidate_id uuid, access_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE d record; g_id uuid; a_id uuid;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.candidate_id, x.placement_id, x.doc_type, x.classification, x.file_id, f.status, f.content_type
    INTO d
    FROM eureka.document x JOIN eureka.file_object f ON f.id = x.file_id WHERE x.id = p_document;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_visible(d.candidate_id, 'candidate:read'), false)
     OR NOT coalesce(authz.candidate_owned(d.candidate_id, 'document:read'), false)
     OR (d.classification IS DISTINCT FROM 'internal'
         AND NOT coalesce(authz.candidate_owned(d.candidate_id, 'document.restricted:read'), false)) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF d.classification IS DISTINCT FROM 'internal' THEN
    SELECT s.grant_id INTO g_id FROM authz.step_up_current(p_session) s;
    IF g_id IS NULL THEN
      INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
      VALUES (authz.current_user_id(), 'document.view_refused', 'document', d.id, pg_catalog.jsonb_build_object(
        'candidateId', d.candidate_id, 'docType', d.doc_type, 'classification', d.classification, 'reason', 'step_up_required'));
      RETURN QUERY SELECT 'step_up_required'::text, NULL::uuid, d.classification, NULL::text, d.doc_type, d.candidate_id, NULL::uuid;
      RETURN;
    END IF;
  END IF;
  IF d.status IS DISTINCT FROM 'clean' THEN
    RETURN QUERY SELECT 'not_available'::text, NULL::uuid, d.classification, NULL::text, d.doc_type, d.candidate_id, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO eureka.document_access AS a (document_id, user_id, action, doc_type, classification, step_up_grant_id)
  VALUES (d.id, authz.current_user_id(), 'download', d.doc_type, d.classification, g_id)
  RETURNING a.id INTO a_id;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(),
          CASE WHEN d.classification = 'restricted' THEN 'document.viewed' ELSE 'document.downloaded' END,
          'document', d.id, pg_catalog.jsonb_build_object(
            'candidateId', d.candidate_id, 'placementId', d.placement_id, 'fileId', d.file_id, 'docType', d.doc_type,
            'classification', d.classification, 'accessId', a_id, 'stepUpGrantId', g_id));
  RETURN QUERY SELECT 'ok'::text, d.file_id, d.classification, d.content_type, d.doc_type, d.candidate_id, a_id;
END $$;

-- Worker: pending files, oldest first (ids and declared metadata only).
CREATE FUNCTION authz.document_scan_queue(p_limit integer, p_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, classification text, content_type text, size_bytes integer, created_at timestamptz, upload_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT f.id, f.classification, f.content_type, f.size_bytes, f.created_at, f.upload_expires_at
  FROM eureka.file_object f
  WHERE f.status = 'pending' AND (p_id IS NULL OR f.id = p_id)
  ORDER BY f.created_at, f.id
  LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 100)
$$;

-- Worker: records the outcome of one scan (as authz.resume_scan_finish, no
-- versions: each document is one file). Only pending files change; clean needs
-- the declared size and a SHA-256. Returns the status, or 'not_pending'.
CREATE FUNCTION authz.document_scan_finish(p_id uuid, p_status text, p_result text, p_sha256 text, p_size integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f eureka.file_object%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_status IS NULL OR p_result IS NULL
     OR p_status NOT IN ('clean', 'infected', 'failed', 'rejected', 'expired')
     OR NOT coalesce(p_result ~ '^[A-Z_]{1,40}$', false) THEN
    RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO f FROM eureka.file_object x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF f.status IS DISTINCT FROM 'pending' THEN
    RETURN 'not_pending';
  END IF;
  IF p_status IS NOT DISTINCT FROM 'clean' THEN
    IF p_result IS DISTINCT FROM 'NO_THREATS_FOUND'
       OR p_size IS DISTINCT FROM f.size_bytes
       OR NOT coalesce(p_sha256 ~ '^[0-9a-f]{64}$', false) THEN
      RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.file_object SET status = 'clean', scan_result = p_result, sha256_hex = p_sha256 WHERE id = p_id;
  ELSE
    IF p_status IS NOT DISTINCT FROM 'expired' AND NOT coalesce(pg_catalog.now() > f.upload_expires_at, false) THEN
      RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.file_object SET status = p_status, scan_result = p_result WHERE id = p_id;
  END IF;
  RETURN p_status;
END $$;

RESET ROLE;

-- Rule 2: no PUBLIC execute; each function to exactly the role that calls it.
REVOKE ALL ON FUNCTION authz.session_is_mine(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.step_up_current(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.step_up_begin(bytea, bytea, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.step_up_complete(bytea, bytea, bytea, text, timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.step_up_dev(bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.create_document_upload(uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.document_download(uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.document_scan_queue(integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.document_scan_finish(uuid, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.step_up_current(bytea) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.step_up_begin(bytea, bytea, bytea, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.step_up_complete(bytea, bytea, bytea, text, timestamptz, integer, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.step_up_dev(bytea, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.create_document_upload(uuid, uuid, text, text, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.document_download(uuid, bytea) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.document_scan_queue(integer, uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.document_scan_finish(uuid, text, text, text, integer) TO eureka_worker;
