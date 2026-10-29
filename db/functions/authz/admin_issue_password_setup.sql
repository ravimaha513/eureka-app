-- authz.admin_issue_password_setup: current definition (repeatable; db/functions/README.md).
-- An org admin issues a one-time set-password link for a user (migration 0270).
-- The API makes the token and passes only its SHA-256; this stores it, closes
-- any open link for the user and returns the address to email it to.
-- Same rules as authz.admin_set_password: password sign-in on, access:manage,
-- not oneself, active user, no restricted role. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.admin_issue_password_setup(p_user uuid, p_token_hash bytea, p_ttl_hours integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  actor uuid;
  v_email text;
  ttl integer := LEAST(GREATEST(coalesce(p_ttl_hours, 72), 1), 168);
BEGIN
  IF NOT authz.password_login_enabled() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  actor := authz.admin_guard(p_user); -- access:manage, and never one's own account
  IF authz.admin_user_status(p_user) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'user_inactive' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.user_role ur JOIN eureka.role ro ON ro.key = ur.role_key
              WHERE ur.user_id = p_user AND ur.valid @> pg_catalog.now() AND ro.is_restricted) THEN
    RAISE EXCEPTION 'restricted_target' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE authz.password_setup_token SET used_at = pg_catalog.now() WHERE user_id = p_user AND used_at IS NULL;
  INSERT INTO authz.password_setup_token (token_hash, user_id, created_by, expires_at)
  VALUES (p_token_hash, p_user, actor, pg_catalog.now() + pg_catalog.make_interval(hours => ttl));
  SELECT u.email::text INTO v_email FROM eureka.app_user u WHERE u.id = p_user;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (actor, 'admin.user.password_invite', 'app_user', p_user, pg_catalog.jsonb_build_object('ttlHours', ttl));
  RETURN v_email;
END $function$;
REVOKE ALL ON FUNCTION authz.admin_issue_password_setup(uuid, bytea, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_issue_password_setup(uuid, bytea, integer) TO eureka_app;
RESET ROLE;
