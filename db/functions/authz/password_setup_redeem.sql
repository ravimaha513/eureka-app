-- authz.password_setup_redeem: current definition (repeatable; db/functions/README.md).
-- A user opens a set-password link (migration 0270) and picks a password. No
-- session yet: the token is the credential. Returns (user_id, outcome) with
-- outcome ok | invalid | weak. A weak password keeps the link open so the user
-- can try again; ok stores the password (must_change = false) and closes the
-- link, and the API then starts a session. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.password_setup_redeem(p_token_hash bytea, p_password text)
 RETURNS TABLE(user_id uuid, outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  t authz.password_setup_token%ROWTYPE;
BEGIN
  IF NOT authz.password_login_enabled() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM authz.password_setup_token s WHERE s.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR t.used_at IS NOT NULL OR t.expires_at <= pg_catalog.now()
     OR NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = t.user_id AND u.status = 'active')
     OR EXISTS (SELECT 1 FROM eureka.user_role ur JOIN eureka.role ro ON ro.key = ur.role_key
                 WHERE ur.user_id = t.user_id AND ur.valid @> pg_catalog.now() AND ro.is_restricted) THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid'::text;
    RETURN;
  END IF;
  IF NOT authz.password_acceptable(p_password) THEN
    RETURN QUERY SELECT NULL::uuid, 'weak'::text;
    RETURN;
  END IF;
  PERFORM authz.password_store(t.user_id, p_password, false);
  UPDATE authz.password_setup_token s SET used_at = pg_catalog.now() WHERE s.token_hash = p_token_hash;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (t.user_id, 'auth.password_setup', 'app_user', t.user_id, '{}'::jsonb);
  RETURN QUERY SELECT t.user_id, 'ok'::text;
END $function$;
REVOKE ALL ON FUNCTION authz.password_setup_redeem(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.password_setup_redeem(bytea, text) TO eureka_app;
RESET ROLE;
