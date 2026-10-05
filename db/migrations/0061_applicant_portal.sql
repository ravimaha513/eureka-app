-- Applicant portal accounts and one-time email sign-in links (jobs-portal
-- package; docs/jobs-portal-api.md JP-10..JP-16).
--
--   1. eureka.applicant: outside applicants (not app_user rows, no Google).
--      Name, email (unique, lower-case), phone (E.164), email verified time.
--      Date of birth is not collected (see the docs: it would need the dob
--      field class end to end, OD-04).
--   2. eureka.applicant_login_link: one-time sign-in links. Only a SHA-256 of
--      the link secret is stored; a link is single use, expires after the TTL
--      the API passes (15 minutes, capped at 30 here), and at most p_max links
--      per applicant per hour are issued (rate limit per email in the database,
--      shared by every API task). Redeeming one link burns the applicant's other
--      open links.
--   3. eureka.applicant_session: server-side applicant sessions (only the
--      SHA-256 of the cookie value is stored), separate from staff sessions.
--   4. Role eureka_portal (NOLOGIN): what an applicant request may touch. The
--      API's portal routes run `SET LOCAL ROLE eureka_portal` with
--      eureka.applicant_id set; eureka_app may SET to it but does not inherit
--      it (INHERIT FALSE), so staff requests never get its policies, and its
--      policies limit every row to the signed-in applicant. eureka_portal holds
--      no privilege on staff tables.
--   5. Writes only through SECURITY DEFINER functions executable by eureka_app
--      (sign-up, issue, redeem, session resolve/revoke); a guard refuses every
--      other writer and all deletes except the definer's housekeeping.
-- Every IF is NULL-safe (rule 1). Functions pin search_path, are not
-- executable by PUBLIC and are granted to exactly the role that needs them (rule 2).
SET search_path = eureka, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eureka_portal') THEN
    CREATE ROLE eureka_portal NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA eureka, authz TO eureka_portal;
GRANT eureka_portal TO eureka_app WITH INHERIT FALSE, SET TRUE;

SET ROLE eureka_owner;

CREATE TABLE eureka.applicant (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name        text NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 80 AND first_name !~ '[[:cntrl:]]'),
  last_name         text NOT NULL CHECK (char_length(last_name) BETWEEN 1 AND 80 AND last_name !~ '[[:cntrl:]]'),
  -- Stored lower-case (the API normalizes; the CHECK holds it), so equality is case-insensitive.
  email             text NOT NULL UNIQUE CHECK (char_length(email) <= 254 AND email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone_e164        text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email_verified_at timestamptz,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applicant_list ON eureka.applicant (created_at DESC, id DESC);

CREATE TABLE eureka.applicant_login_link (
  id           uuid PRIMARY KEY,
  applicant_id uuid NOT NULL REFERENCES eureka.applicant(id),
  secret_hash  bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX applicant_login_link_recent ON eureka.applicant_login_link (applicant_id, created_at);

CREATE TABLE eureka.applicant_session (
  id_hash      bytea PRIMARY KEY CHECK (octet_length(id_hash) = 32),
  applicant_id uuid NOT NULL REFERENCES eureka.applicant(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX applicant_session_applicant ON eureka.applicant_session (applicant_id);

-- Only the definer functions (as authz_definer) write these tables.
CREATE FUNCTION eureka.portal_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'applicant data changes only through portal functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'applicant' THEN
      RAISE EXCEPTION 'applicants are never deleted here' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'applicant' THEN
    -- Nested: the column references only compile for the applicant row type.
    IF TG_OP = 'UPDATE' THEN
      IF (NEW.id, NEW.email, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.email, OLD.created_at) THEN
        RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    NEW.updated_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER applicant_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.applicant
  FOR EACH ROW EXECUTE FUNCTION eureka.portal_write_guard();
CREATE TRIGGER applicant_login_link_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.applicant_login_link
  FOR EACH ROW EXECUTE FUNCTION eureka.portal_write_guard();
CREATE TRIGGER applicant_session_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.applicant_session
  FOR EACH ROW EXECUTE FUNCTION eureka.portal_write_guard();

CREATE FUNCTION eureka.portal_truncate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'applicant data is never truncated' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER applicant_truncate_guard BEFORE TRUNCATE ON eureka.applicant
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.portal_truncate_guard();
CREATE TRIGGER applicant_login_link_truncate_guard BEFORE TRUNCATE ON eureka.applicant_login_link
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.portal_truncate_guard();
CREATE TRIGGER applicant_session_truncate_guard BEFORE TRUNCATE ON eureka.applicant_session
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.portal_truncate_guard();

ALTER TABLE eureka.applicant            ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.applicant            FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.applicant_login_link ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.applicant_login_link FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.applicant_session    ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.applicant_session    FORCE ROW LEVEL SECURITY;

RESET ROLE;

-- ---------- functions ----------
SET ROLE authz_definer;

-- The signed-in applicant of a portal request (set by the API with set_config, transaction-local).
-- Not a definer: it only reads the caller's own setting.
CREATE FUNCTION authz.current_applicant_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT nullif(pg_catalog.current_setting('eureka.applicant_id', true), '')::uuid
$$;

-- Issues a link for an active applicant unless p_max links were issued in the last hour.
-- Internal. Returns true when issued.
CREATE FUNCTION authz.portal_link_insert(p_applicant uuid, p_link uuid, p_hash bytea, p_ttl_minutes integer, p_max integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_link IS NULL OR p_hash IS NULL OR octet_length(p_hash) IS DISTINCT FROM 32
     OR p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 30 OR p_max IS NULL OR p_max < 1 OR p_max > 20 THEN
    RAISE EXCEPTION 'invalid_link_request' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM eureka.applicant a WHERE a.id = p_applicant FOR UPDATE;
  -- Housekeeping: this applicant's links older than a day.
  DELETE FROM eureka.applicant_login_link l WHERE l.applicant_id = p_applicant AND l.created_at < pg_catalog.now() - interval '1 day';
  SELECT count(*) INTO n FROM eureka.applicant_login_link l
   WHERE l.applicant_id = p_applicant AND l.created_at > pg_catalog.now() - interval '1 hour';
  IF coalesce(n, 0) >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO eureka.applicant_login_link (id, applicant_id, secret_hash, created_at, expires_at)
  VALUES (p_link, p_applicant, p_hash, pg_catalog.now(), pg_catalog.now() + pg_catalog.make_interval(mins => p_ttl_minutes));
  RETURN true;
END $$;

-- JP-10 sign-up. A new email creates the applicant (unverified); an
-- unverified applicant's name and phone are replaced (the mailbox owner has
-- not confirmed anything yet); a verified applicant is left unchanged. Either
-- way a sign-in link is issued (rate limited). Returns the applicant id, first
-- name, whether the account already existed verified, and whether a link was
-- issued; the API answers the caller the same way in every case.
CREATE FUNCTION authz.portal_sign_up(p_first text, p_last text, p_email text, p_phone text,
                                     p_link uuid, p_hash bytea, p_ttl_minutes integer, p_max integer)
RETURNS TABLE (applicant_id uuid, first_name text, existing boolean, issued boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE a record;
BEGIN
  IF p_email IS NULL OR p_first IS NULL OR p_last IS NULL THEN
    RAISE EXCEPTION 'invalid_sign_up' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.applicant (first_name, last_name, email, phone_e164)
  VALUES (p_first, p_last, pg_catalog.lower(p_email), p_phone)
  ON CONFLICT (email) DO NOTHING;
  SELECT x.* INTO a FROM eureka.applicant x WHERE x.email = pg_catalog.lower(p_email) FOR UPDATE;
  IF a.id IS NULL OR a.status IS DISTINCT FROM 'active' THEN
    RETURN;
  END IF;
  IF a.email_verified_at IS NULL THEN
    UPDATE eureka.applicant x SET first_name = p_first, last_name = p_last, phone_e164 = p_phone WHERE x.id = a.id;
  END IF;
  RETURN QUERY SELECT a.id, CASE WHEN a.email_verified_at IS NULL THEN p_first ELSE a.first_name END,
    a.email_verified_at IS NOT NULL, authz.portal_link_insert(a.id, p_link, p_hash, p_ttl_minutes, p_max);
END $$;

-- JP-11 sign-in link for an existing active applicant (no row when the email is unknown).
CREATE FUNCTION authz.portal_issue_link(p_email text, p_link uuid, p_hash bytea, p_ttl_minutes integer, p_max integer)
RETURNS TABLE (applicant_id uuid, first_name text, issued boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE a record;
BEGIN
  SELECT x.id, x.first_name INTO a FROM eureka.applicant x WHERE x.email = pg_catalog.lower(p_email) AND x.status = 'active';
  IF a.id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT a.id, a.first_name, authz.portal_link_insert(a.id, p_link, p_hash, p_ttl_minutes, p_max);
END $$;

-- JP-12 step 1: the stored secret hash of an open link (unused, unexpired,
-- active applicant), so the API compares it in constant time; NULL otherwise.
CREATE FUNCTION authz.portal_link_hash(p_link uuid) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.secret_hash FROM eureka.applicant_login_link l JOIN eureka.applicant a ON a.id = l.applicant_id
   WHERE l.id = p_link AND l.used_at IS NULL AND l.expires_at > pg_catalog.now() AND a.status = 'active'
$$;

-- JP-12 step 2: burns the link (once, only with the matching hash, re-checked
-- here), burns the applicant's other open links, marks the email verified and
-- opens a session. Returns the applicant id, or NULL when the link is not open.
CREATE FUNCTION authz.portal_redeem_link(p_link uuid, p_hash bytea, p_session bytea, p_session_hours integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE who uuid;
BEGIN
  IF p_session IS NULL OR octet_length(p_session) IS DISTINCT FROM 32 OR p_session_hours IS NULL
     OR p_session_hours < 1 OR p_session_hours > 24 THEN
    RAISE EXCEPTION 'invalid_session' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.applicant_login_link l SET used_at = pg_catalog.now()
   WHERE l.id = p_link AND l.used_at IS NULL AND l.expires_at > pg_catalog.now() AND l.secret_hash = p_hash
     AND EXISTS (SELECT 1 FROM eureka.applicant a WHERE a.id = l.applicant_id AND a.status = 'active')
  RETURNING l.applicant_id INTO who;
  IF who IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE eureka.applicant_login_link l SET used_at = pg_catalog.now()
   WHERE l.applicant_id = who AND l.used_at IS NULL;
  UPDATE eureka.applicant a SET email_verified_at = coalesce(a.email_verified_at, pg_catalog.now()) WHERE a.id = who;
  DELETE FROM eureka.applicant_session s WHERE s.applicant_id = who AND (s.expires_at < pg_catalog.now() OR s.revoked_at IS NOT NULL);
  INSERT INTO eureka.applicant_session (id_hash, applicant_id, expires_at)
  VALUES (p_session, who, pg_catalog.now() + pg_catalog.make_interval(hours => p_session_hours));
  RETURN who;
END $$;

-- Valid applicant session (absolute and idle timeouts, active applicant): touches it and returns the applicant.
CREATE FUNCTION authz.portal_session_resolve(p_session bytea, p_idle_minutes integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE who uuid;
BEGIN
  IF p_session IS NULL OR p_idle_minutes IS NULL OR p_idle_minutes < 1 THEN
    RETURN NULL;
  END IF;
  UPDATE eureka.applicant_session s SET last_seen_at = pg_catalog.now()
   WHERE s.id_hash = p_session AND s.revoked_at IS NULL AND s.expires_at > pg_catalog.now()
     AND s.last_seen_at > pg_catalog.now() - pg_catalog.make_interval(mins => p_idle_minutes)
     AND EXISTS (SELECT 1 FROM eureka.applicant a WHERE a.id = s.applicant_id AND a.status = 'active')
  RETURNING s.applicant_id INTO who;
  RETURN who;
END $$;

CREATE FUNCTION authz.portal_session_revoke(p_session bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE eureka.applicant_session SET revoked_at = pg_catalog.now() WHERE id_hash = p_session AND revoked_at IS NULL
$$;

RESET ROLE;

-- ---------- policies ----------
SET ROLE eureka_owner;
-- The applicant (portal role) sees their own row only.
CREATE POLICY applicant_self_read ON eureka.applicant FOR SELECT TO eureka_portal
  USING (id = (SELECT authz.current_applicant_id()));
-- Staff: applicant:read at org scope (HR). Hiring managers see applicants of
-- their jobs through applications (migration 0062).
CREATE POLICY applicant_staff_read ON eureka.applicant FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('applicant:read')));
CREATE POLICY definer_all ON eureka.applicant FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON eureka.applicant_login_link FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON eureka.applicant_session FOR ALL TO authz_definer USING (true) WITH CHECK (true);
RESET ROLE;

REVOKE ALL ON eureka.applicant, eureka.applicant_login_link, eureka.applicant_session FROM PUBLIC;
GRANT SELECT (id, first_name, last_name, email, phone_e164, email_verified_at, created_at) ON eureka.applicant TO eureka_portal;
GRANT SELECT (id, first_name, last_name, email, phone_e164, email_verified_at, status, created_at) ON eureka.applicant TO eureka_app;
GRANT SELECT, INSERT, UPDATE ON eureka.applicant, eureka.applicant_session TO authz_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON eureka.applicant_login_link TO authz_definer;
GRANT DELETE ON eureka.applicant_session TO authz_definer;

REVOKE ALL ON FUNCTION eureka.portal_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.portal_truncate_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.current_applicant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_link_insert(uuid, uuid, bytea, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_sign_up(text, text, text, text, uuid, bytea, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_issue_link(text, uuid, bytea, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_link_hash(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_redeem_link(uuid, bytea, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_session_resolve(bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.portal_session_revoke(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.current_applicant_id() TO eureka_portal;
GRANT EXECUTE ON FUNCTION authz.portal_sign_up(text, text, text, text, uuid, bytea, integer, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.portal_issue_link(text, uuid, bytea, integer, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.portal_link_hash(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.portal_redeem_link(uuid, bytea, bytea, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.portal_session_resolve(bytea, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.portal_session_revoke(bytea) TO eureka_app;
