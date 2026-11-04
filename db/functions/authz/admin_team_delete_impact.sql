-- authz.admin_team_delete_impact: current definition (repeatable; db/functions/README.md).
-- What authz.admin_delete_team would touch, for the delete dialog (docs/admin-api.md
-- AD-15): current members, candidates on the team and how many of them are on the
-- Hot List (which blocks "leave unassigned"). Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.admin_team_delete_impact(p_team uuid)
 RETURNS TABLE (members integer, candidates integer, hotlist_candidates integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM authz.admin_guard(NULL);
  IF NOT EXISTS (SELECT 1 FROM eureka.team t WHERE t.id = p_team AND t.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY SELECT
    (SELECT pg_catalog.count(*)::integer FROM eureka.team_member tm
      WHERE tm.team_id = p_team AND tm.valid @> pg_catalog.now()),
    (SELECT pg_catalog.count(*)::integer FROM eureka.candidate c WHERE c.team_id = p_team),
    (SELECT pg_catalog.count(*)::integer FROM eureka.candidate c WHERE c.team_id = p_team
      AND c.marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped'));
END $function$;
REVOKE ALL ON FUNCTION authz.admin_team_delete_impact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_team_delete_impact(uuid) TO eureka_app;
RESET ROLE;
