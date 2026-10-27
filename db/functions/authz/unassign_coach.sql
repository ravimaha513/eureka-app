-- authz.unassign_coach: current definition (repeatable; db/functions/README.md).
-- Ends a coach's current assignment to a team (docs/admin-api.md AD-11). Same
-- permission and scope as authz.assign_coach. The API writes the audit row.
-- Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.unassign_coach(p_coach uuid, p_team uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM authz.coach_assignment_guard(p_coach);
  UPDATE eureka.coach_assignment SET valid = authz.ended(valid)
   WHERE coach_id = p_coach AND team_id = p_team AND valid @> pg_catalog.now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_assigned' USING ERRCODE = 'no_data_found';
  END IF;
END $function$;

REVOKE ALL ON FUNCTION authz.unassign_coach(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.unassign_coach(uuid, uuid) TO eureka_app;
RESET ROLE;
