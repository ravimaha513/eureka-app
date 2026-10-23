-- authz.admin_rename_team: current definition (repeatable; db/functions/README.md).
-- An admin (access:manage) renames a team (docs/admin-api.md, Teams). Column
-- privilege granted in 0200. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.admin_rename_team(p_team uuid, p_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_name text := pg_catalog.btrim(p_name);
BEGIN
  PERFORM authz.admin_guard(NULL);
  IF coalesce(pg_catalog.length(v_name), 0) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.team SET name = v_name WHERE id = p_team;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
END $function$;
REVOKE ALL ON FUNCTION authz.admin_rename_team(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_rename_team(uuid, text) TO eureka_app;
RESET ROLE;
