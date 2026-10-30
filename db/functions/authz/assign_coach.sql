-- authz.assign_coach: current definition (repeatable; db/functions/README.md).
-- Assigns an interview coach (or Interview Lead) to a sales team (docs/admin-api.md
-- AD-11). An org admin (access:manage) assigns anyone; a coach:assign holder
-- (Interview Lead, hierarchy scope) assigns the coaches in their reporting subtree,
-- never themself. Any team. The API writes the audit row in the same transaction.
-- Change this file, not a new migration.

-- 0311: branches on role traits (authz.user_has_trait), never on the role key (docs/roles-api.md).
SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.assign_coach(p_coach uuid, p_team uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM authz.coach_assignment_guard(p_coach);
  IF NOT EXISTS (SELECT 1 FROM eureka.team t WHERE t.id = p_team) THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF authz.admin_user_status(p_coach) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'user_inactive' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT authz.user_has_trait(p_coach, 'coach') THEN
    RAISE EXCEPTION 'not_a_coach' USING ERRCODE = 'check_violation';
  END IF;
  -- Serialize assignments of one coach so two concurrent calls cannot both insert.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coach_assignment:' || p_coach::text, 0));
  IF EXISTS (SELECT 1 FROM eureka.coach_assignment ca
             WHERE ca.coach_id = p_coach AND ca.team_id = p_team AND ca.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'already_assigned' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.coach_assignment (coach_id, team_id) VALUES (p_coach, p_team);
END $function$;

REVOKE ALL ON FUNCTION authz.assign_coach(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assign_coach(uuid, uuid) TO eureka_app;
RESET ROLE;
