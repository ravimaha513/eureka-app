-- authz.role_grantable: current definition (repeatable; db/functions/README.md).
-- Can p_role be granted to p_user now (docs/roles-api.md)? Raises unknown_role,
-- role_archived, or role_department_mismatch when the role is bound to a business
-- unit (department) the user is not in. Called by request_role and approve_role_request.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.role_grantable(p_role text, p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r record; dep uuid;
BEGIN
  SELECT ro.archived_at, ro.department_id INTO r FROM eureka.role ro WHERE ro.key = p_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_role' USING ERRCODE = 'check_violation';
  END IF;
  IF r.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'role_archived' USING ERRCODE = 'check_violation';
  END IF;
  IF r.department_id IS NOT NULL THEN
    SELECT u.department_id INTO dep FROM eureka.app_user u WHERE u.id = p_user;
    -- The role's department, or a sub-department of it (two levels, 0230).
    IF dep IS NULL OR NOT EXISTS (
         SELECT 1 FROM eureka.department d WHERE d.id = dep AND (d.id = r.department_id OR d.parent_id = r.department_id)) THEN
      RAISE EXCEPTION 'role_department_mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END $function$;

REVOKE ALL ON FUNCTION authz.role_grantable(text, uuid) FROM PUBLIC;
RESET ROLE;
