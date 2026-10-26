-- authz.admin_set_user_department: current definition (repeatable; db/functions/README.md).
-- An admin (access:manage) sets or clears a user's department (docs/admin-api.md,
-- Departments). Descriptive only, so admins may set their own. Returns the
-- previous department for the audit row. Column privilege granted in 0220.
-- Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.admin_set_user_department(p_user uuid, p_department uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_previous uuid;
BEGIN
  PERFORM authz.admin_guard(NULL);
  SELECT u.department_id INTO v_previous FROM eureka.app_user u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_department IS NOT NULL AND NOT EXISTS (SELECT 1 FROM eureka.department d WHERE d.id = p_department) THEN
    RAISE EXCEPTION 'department_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE eureka.app_user SET department_id = p_department WHERE id = p_user;
  RETURN v_previous;
END $function$;
REVOKE ALL ON FUNCTION authz.admin_set_user_department(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_set_user_department(uuid, uuid) TO eureka_app;
RESET ROLE;
