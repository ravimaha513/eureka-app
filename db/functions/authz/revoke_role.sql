-- authz.revoke_role: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0013, 0014, 0018. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.revoke_role(p_user uuid, p_role text, p_location uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE n integer; actor uuid;
BEGIN
  actor := authz.admin_guard(p_user);
  UPDATE eureka.user_role SET valid = authz.ended(valid)
    WHERE user_id = p_user AND role_key = p_role
      AND (p_location IS NULL OR location_id = p_location)
      AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'role_not_held' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_role = 'org_admin' THEN
    UPDATE eureka.role_request SET status = 'rejected', decided_by = actor, decided_at = pg_catalog.now()
      WHERE status = 'pending' AND requested_by = p_user AND user_id <> actor;
    PERFORM authz.assert_admin_remains();
  END IF;
  RETURN n;
END $function$;

REVOKE ALL ON FUNCTION authz.revoke_role(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.revoke_role(uuid, text, uuid) TO eureka_app;
RESET ROLE;
