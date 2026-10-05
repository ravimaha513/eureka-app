-- Username and password sign-in for staging and local test environments.
--
--   * Production keeps Google SSO with 2-step verification (design A6.1).
--     This is a test and demo convenience, gated three ways:
--       1. the API refuses PASSWORD_LOGIN unless EUREKA_ENVIRONMENT is staging
--          or local (config.ts);
--       2. every function below raises not_permitted unless
--          authz.policy_setting password_login = 'on'. No migration sets it:
--          seedCatalog turns it on only for staging/local and deletes it on
--          every other environment (as dev_step_up, migration 0043);
--       3. credentials live in authz.user_credential, which only authz_definer
--          can read or write. The API role has EXECUTE on the functions only.
--   * Passwords are never stored, logged or audited in plain text. The hash is
--     bcrypt (pgcrypto crypt/gen_salt 'bf', cost 12, salted per password) and
--     is verified inside the database; the API never sees a hash.
--   * Lockout: 5 failures lock the account for 15 minutes (the API passes
--     the limits; the database caps them). Failed and successful sign-ins are
--     audited without the password.
--   * An admin-set password is temporary: must_change forces a new one at the
--     first sign-in and the API blocks every other route until then. An admin
--     can not set the password of a user holding a restricted role (that
--     would bypass the second approver, AD-3); those are set out of band with
--     the db CLI (src/db/set-password.ts) by whoever holds the database credentials.
--   * Step-up for restricted documents accepts a password re-entry as method
--     'password' when the session was created by password.
SET search_path = eureka, public;

SET ROLE eureka_owner;
ALTER TABLE eureka.step_up_grant DROP CONSTRAINT step_up_grant_method_check;
ALTER TABLE eureka.step_up_grant
  ADD CONSTRAINT step_up_grant_method_check CHECK (method IN ('google', 'dev', 'password'));
RESET ROLE;

SET ROLE authz_definer;

ALTER TABLE authz.policy_setting
  ADD CONSTRAINT policy_setting_password_login CHECK (key <> 'password_login' OR value IN ('on', 'off'));

CREATE TABLE authz.user_credential (
  user_id             uuid PRIMARY KEY,
  password_hash       text NOT NULL CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$.{53}$'),
  must_change         boolean NOT NULL DEFAULT true,
  failed_count        integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until        timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON authz.user_credential FROM PUBLIC;

-- ---------- helpers (not granted to the API) ----------
CREATE FUNCTION authz.password_login_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM authz.policy_setting s WHERE s.key = 'password_login' AND s.value = 'on')
$$;

-- 10 to 72 bytes (bcrypt ignores anything beyond 72), one letter and one digit.
CREATE FUNCTION authz.password_acceptable(p_password text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.octet_length(p_password) BETWEEN 10 AND 72
    AND p_password ~ '[A-Za-z]' AND p_password ~ '[0-9]' AND p_password !~ '[[:cntrl:]]', false)
$$;

-- Stores a password. No authorization: only callable by callers that already checked it.
CREATE FUNCTION authz.password_store(p_user uuid, p_password text, p_must_change boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT authz.password_login_enabled() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT authz.password_acceptable(p_password) THEN
    RAISE EXCEPTION 'password_weak' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO authz.user_credential AS c (user_id, password_hash, must_change)
  VALUES (p_user, public.crypt(p_password, public.gen_salt('bf', 12)), coalesce(p_must_change, true))
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash, must_change = EXCLUDED.must_change,
        failed_count = 0, locked_until = NULL, password_changed_at = pg_catalog.now();
  -- A new password ends every session of that user.
  UPDATE eureka.session SET revoked_at = pg_catalog.now() WHERE user_id = p_user AND revoked_at IS NULL;
END $$;

-- Verifies a password with lockout. Returns ok | invalid | locked. Never raises
-- on a bad password, so the failure counter survives the transaction.
CREATE FUNCTION authz.password_verify(p_user uuid, p_password text, p_max integer, p_lock_minutes integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c authz.user_credential%ROWTYPE; maxf integer := LEAST(GREATEST(coalesce(p_max, 5), 3), 10);
        lockm integer := LEAST(GREATEST(coalesce(p_lock_minutes, 15), 1), 60);
BEGIN
  SELECT * INTO c FROM authz.user_credential WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.crypt(coalesce(p_password, ''), public.gen_salt('bf', 12)); -- same work as a real check
    RETURN 'invalid';
  END IF;
  IF c.locked_until IS NOT NULL AND c.locked_until > pg_catalog.now() THEN RETURN 'locked'; END IF;
  IF p_password IS NOT NULL AND pg_catalog.octet_length(p_password) <= 72
     AND public.crypt(p_password, c.password_hash) = c.password_hash THEN
    UPDATE authz.user_credential SET failed_count = 0, locked_until = NULL WHERE user_id = p_user;
    RETURN 'ok';
  END IF;
  UPDATE authz.user_credential SET
    failed_count = CASE WHEN failed_count + 1 >= maxf THEN 0 ELSE failed_count + 1 END,
    locked_until = CASE WHEN failed_count + 1 >= maxf THEN pg_catalog.now() + pg_catalog.make_interval(mins => lockm) ELSE locked_until END
  WHERE user_id = p_user;
  RETURN 'invalid';
END $$;

-- ---------- API: sign-in (no session yet) ----------
CREATE FUNCTION authz.password_login(p_email text, p_password text, p_max integer, p_lock_minutes integer)
RETURNS TABLE (user_id uuid, outcome text, must_change boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u uuid; r text; mc boolean := false;
  nil CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  IF NOT authz.password_login_enabled() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a.id INTO u FROM eureka.app_user a
   WHERE a.status = 'active' AND pg_catalog.lower(a.email::text) = pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  IF u IS NULL THEN
    PERFORM public.crypt(coalesce(p_password, ''), public.gen_salt('bf', 12));
    r := 'invalid';
  ELSE
    r := authz.password_verify(u, p_password, p_max, p_lock_minutes);
    IF r = 'ok' THEN SELECT c.must_change INTO mc FROM authz.user_credential c WHERE c.user_id = u; END IF;
  END IF;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (coalesce(u, nil), CASE WHEN r = 'ok' THEN 'auth.password_login' ELSE 'auth.password_denied' END,
          'app_user', u, pg_catalog.jsonb_build_object('outcome', r));
  RETURN QUERY SELECT CASE WHEN r = 'ok' THEN u END, r, coalesce(mc, false);
END $$;

-- The caller's temporary-password flag (the API blocks other routes while true).
CREATE FUNCTION authz.password_must_change() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT c.must_change FROM authz.user_credential c WHERE c.user_id = authz.current_user_id()), false)
$$;

-- Whether the caller has a password (step-up offers password re-entry only then).
CREATE FUNCTION authz.password_has_credential() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM authz.user_credential c WHERE c.user_id = authz.current_user_id())
$$;

-- API: the caller changes their own password. Returns ok | invalid | locked | weak | same.
CREATE FUNCTION authz.password_change(p_session bytea, p_old text, p_new text, p_max integer, p_lock_minutes integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_user_id(); r text;
BEGIN
  IF me IS NULL OR NOT authz.password_login_enabled() OR NOT coalesce(authz.session_is_mine(p_session), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  r := authz.password_verify(me, p_old, p_max, p_lock_minutes);
  IF r <> 'ok' THEN RETURN r; END IF;
  IF NOT authz.password_acceptable(p_new) THEN RETURN 'weak'; END IF;
  IF p_new = p_old THEN RETURN 'same'; END IF;
  PERFORM authz.password_store(me, p_new, false);
  -- password_store ended every session; keep the one that made the change.
  UPDATE eureka.session SET revoked_at = NULL WHERE id_hash = p_session AND user_id = me;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (me, 'auth.password_changed', 'app_user', me, '{}'::jsonb);
  RETURN 'ok';
END $$;

-- API: an org admin sets or resets a user's temporary password.
CREATE FUNCTION authz.admin_set_password(p_user uuid, p_password text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor := authz.admin_guard(p_user); -- access:manage, and never one's own account
  PERFORM authz.admin_user_status(p_user);
  IF EXISTS (SELECT 1 FROM eureka.user_role ur JOIN eureka.role ro ON ro.key = ur.role_key
              WHERE ur.user_id = p_user AND ur.valid @> pg_catalog.now() AND ro.is_restricted) THEN
    RAISE EXCEPTION 'restricted_target' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM authz.password_store(p_user, p_password, true);
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (actor, 'admin.user.password_set', 'app_user', p_user, '{}'::jsonb);
END $$;

-- API: step-up by re-entering the password. ok | invalid | locked.
CREATE FUNCTION authz.step_up_password(p_session bytea, p_password text, p_ttl_minutes integer, p_max integer, p_lock_minutes integer)
RETURNS TABLE (outcome text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_user_id(); r text; g_id uuid; g_exp timestamptz;
  ttl integer := LEAST(GREATEST(coalesce(p_ttl_minutes, 1), 1), 15);
BEGIN
  IF me IS NULL OR NOT authz.password_login_enabled() OR NOT coalesce(authz.session_is_mine(p_session), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  r := authz.password_verify(me, p_password, p_max, p_lock_minutes);
  IF r <> 'ok' THEN
    INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
    VALUES (me, 'auth.step_up_failed', 'app_user', me, pg_catalog.jsonb_build_object('method', 'password', 'outcome', r));
    RETURN QUERY SELECT r, NULL::timestamptz;
    RETURN;
  END IF;
  INSERT INTO eureka.step_up_grant AS g (session_hash, user_id, method, auth_time, expires_at)
  VALUES (p_session, me, 'password', pg_catalog.now(), pg_catalog.now() + pg_catalog.make_interval(mins => ttl))
  RETURNING g.id, g.expires_at INTO g_id, g_exp;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (me, 'auth.step_up', 'app_user', me,
          pg_catalog.jsonb_build_object('method', 'password', 'grantId', g_id, 'expiresAt', g_exp));
  RETURN QUERY SELECT 'ok'::text, g_exp;
END $$;

RESET ROLE;

SET ROLE eureka_owner;
-- The definer functions below write their audit rows (never with a password): sign-in outcomes
-- (no user yet), and, for a signed-in caller, their own password and step-up events.
CREATE POLICY password_definer_audit ON eureka.audit_event FOR INSERT TO authz_definer WITH CHECK (
  (SELECT authz.password_login_enabled())
  AND ((action IN ('auth.password_login', 'auth.password_denied') AND entity_type = 'app_user')
       OR (actor_id IS NOT NULL AND actor_id = (SELECT authz.current_user_id())
           AND action IN ('auth.password_changed', 'admin.user.password_set', 'auth.step_up_failed'))));
RESET ROLE;

-- ---------- grants ----------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'authz.password_login_enabled()', 'authz.password_acceptable(text)',
    'authz.password_store(uuid, text, boolean)', 'authz.password_verify(uuid, text, integer, integer)',
    'authz.password_login(text, text, integer, integer)', 'authz.password_must_change()', 'authz.password_has_credential()',
    'authz.password_change(bytea, text, text, integer, integer)', 'authz.admin_set_password(uuid, text)',
    'authz.step_up_password(bytea, text, integer, integer, integer)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'authz.password_login(text, text, integer, integer)', 'authz.password_must_change()', 'authz.password_has_credential()',
    'authz.password_change(bytea, text, text, integer, integer)', 'authz.admin_set_password(uuid, text)',
    'authz.step_up_password(bytea, text, integer, integer, integer)']
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eureka_app', f);
  END LOOP;
END $$;
