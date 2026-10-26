-- authz.admin_create_department: current definition (repeatable; db/functions/README.md).
-- An admin (access:manage) creates a department, or a sub-department under a
-- top-level one (docs/admin-api.md, Departments). Table and column privileges in
-- 0220. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.admin_create_department(p_name text, p_parent uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_name text := pg_catalog.btrim(p_name);
  v_grandparent uuid;
  new_id uuid;
BEGIN
  PERFORM authz.admin_guard(NULL);
  IF coalesce(pg_catalog.length(v_name), 0) NOT BETWEEN 1 AND 120 OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'check_violation';
  END IF;
  IF p_parent IS NOT NULL THEN
    SELECT d.parent_id INTO v_grandparent FROM eureka.department d WHERE d.id = p_parent;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'department_not_found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_grandparent IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_parent' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  INSERT INTO eureka.department (name, parent_id) VALUES (v_name, p_parent) RETURNING id INTO new_id;
  RETURN new_id;
END $function$;
REVOKE ALL ON FUNCTION authz.admin_create_department(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_create_department(text, uuid) TO eureka_app;
RESET ROLE;
