-- authz.admin_delete_team: current definition (repeatable; db/functions/README.md).
-- An admin (access:manage) deletes a team (docs/admin-api.md AD-15, migration 0420).
-- With p_to_team, its current members move to that team (and report to its lead,
-- eureka.team_reporting_sync) and its candidates go with them: a candidate keeps a
-- recruiter who is now in the target team, otherwise they go to the target's lead.
-- Without it, members are left in no team (their reporting line stays, as on AD-14)
-- and candidates in "No team yet" (0410) with their recruiter; refused while any of
-- them is on the Hot List, which is team-owned. Either way coach assignments end,
-- shares to the team are dropped, and the team is marked deleted with no lead.
-- Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.admin_delete_team(p_team uuid, p_to_team uuid)
 RETURNS TABLE (members integer, moved_candidates integer, unassigned_candidates integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid := authz.admin_guard(NULL); to_lead uuid; nm integer := 0; nc integer := 0; nu integer := 0;
BEGIN
  PERFORM 1 FROM eureka.team t WHERE t.id = p_team AND t.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_to_team IS NOT NULL THEN
    IF p_to_team = p_team THEN
      RAISE EXCEPTION 'same_team' USING ERRCODE = 'check_violation';
    END IF;
    SELECT t.lead_id INTO to_lead FROM eureka.team t WHERE t.id = p_to_team AND t.deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
    END IF;
    -- Moving people under yourself widens your own scope (AD-2).
    IF to_lead IS NOT DISTINCT FROM actor THEN
      RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.team_member tm
              WHERE tm.team_id = p_team AND tm.user_id = actor AND tm.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO eureka.team_delete (xact, pid, team_id)
    VALUES (pg_catalog.pg_current_xact_id(), pg_catalog.pg_backend_pid(), p_team);

  IF p_to_team IS NULL THEN
    IF EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.team_id = p_team
                AND c.marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped')) THEN
      RAISE EXCEPTION 'has_hotlist_candidates' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.team_member SET valid = authz.ended(valid)
      WHERE team_id = p_team AND valid @> pg_catalog.now();
    GET DIAGNOSTICS nm = ROW_COUNT;
    UPDATE eureka.candidate c SET team_id = NULL WHERE c.team_id = p_team;
    GET DIAGNOSTICS nu = ROW_COUNT;
  ELSE
    WITH ended AS (
      UPDATE eureka.team_member SET valid = authz.ended(valid)
        WHERE team_id = p_team AND valid @> pg_catalog.now()
      RETURNING user_id)
    INSERT INTO eureka.team_member (team_id, user_id) SELECT p_to_team, e.user_id FROM ended e;
    GET DIAGNOSTICS nm = ROW_COUNT;
    UPDATE eureka.candidate c SET team_id = p_to_team,
           recruiter_id = CASE
             WHEN c.recruiter_id IS NULL OR c.recruiter_id = to_lead
               OR EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.team_id = p_to_team
                           AND tm.user_id = c.recruiter_id AND tm.valid @> pg_catalog.now())
             THEN c.recruiter_id ELSE to_lead END
      WHERE c.team_id = p_team;
    GET DIAGNOSTICS nc = ROW_COUNT;
  END IF;

  UPDATE eureka.coach_assignment SET valid = authz.ended(valid)
    WHERE team_id = p_team AND valid @> pg_catalog.now();
  DELETE FROM eureka.candidate_team_share s WHERE s.team_id = p_team;
  UPDATE eureka.team SET lead_id = NULL, deleted_at = pg_catalog.now() WHERE id = p_team;
  DELETE FROM eureka.team_delete d
    WHERE d.xact = pg_catalog.pg_current_xact_id() AND d.pid = pg_catalog.pg_backend_pid();
  RETURN QUERY SELECT nm, nc, nu;
END $function$;
REVOKE ALL ON FUNCTION authz.admin_delete_team(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_delete_team(uuid, uuid) TO eureka_app;

RESET ROLE;
