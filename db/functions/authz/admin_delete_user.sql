-- authz.admin_delete_user: current definition (repeatable; db/functions/README.md).
-- An admin (access:manage) deletes a deactivated user now instead of waiting for the
-- worker's purge (docs/admin-api.md, "Deleting users"; migration 0280). Active users
-- must be deactivated first. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.admin_delete_user(p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_status text; v_deleted timestamptz;
BEGIN
  PERFORM authz.admin_guard(p_user);
  SELECT u.status, u.deleted_at INTO v_status, v_deleted FROM eureka.app_user u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND OR v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status IS DISTINCT FROM 'inactive' THEN
    RAISE EXCEPTION 'user_active' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM authz.anonymize_user(p_user);
END $function$;
REVOKE ALL ON FUNCTION authz.admin_delete_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_delete_user(uuid) TO eureka_app;
RESET ROLE;
