-- authz.org_chart_move: current definition (repeatable; db/functions/README.md).
-- One reporting-line move of the org chart editor (docs/roles-api.md, "Org chart").
-- Applies authz.admin_set_manager (0013: access:manage, self_change, cycle,
-- invalid_manager, user_inactive) after the ladder check, and returns the warnings
-- the move raises instead of refusing it:
--   ladder_level   authz.org_chart_ladder_ok is false (the new manager is not above
--                  the person on the ladder).
-- The API records one audit row per move.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.org_chart_move(p_user uuid, p_manager uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE warnings text[] := '{}';
BEGIN
  IF p_manager IS NOT NULL AND NOT authz.org_chart_ladder_ok(p_user, p_manager) THEN
    warnings := warnings || 'ladder_level'::text;
  END IF;
  PERFORM authz.admin_set_manager(p_user, p_manager);
  RETURN warnings;
END $function$;

REVOKE ALL ON FUNCTION authz.org_chart_move(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.org_chart_move(uuid, uuid) TO eureka_app;
RESET ROLE;
