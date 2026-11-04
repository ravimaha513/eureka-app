-- authz.assign_candidate_team: current definition (repeatable; db/functions/README.md).
-- Gives a candidate created with no team (0390) their team. Rights are candidate:create, not
-- candidate:assign: whoever could have chosen the team at creation can choose it now.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.assign_candidate_team(p_candidate uuid, p_team uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM eureka.candidate WHERE id = p_candidate FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(authz.owns('candidate:read', c.recruiter_id, c.team_id, c.location_id), false) THEN
    RAISE EXCEPTION 'candidate not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('candidate:create', c.recruiter_id, c.team_id, c.location_id), false) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF c.team_id IS NOT NULL THEN
    RAISE EXCEPTION 'team_already_assigned' USING ERRCODE = 'check_violation';
  END IF;
  IF p_team IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.team t WHERE t.id = p_team) THEN
    RAISE EXCEPTION 'invalid_team' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(authz.has_org('candidate:create') OR p_team = ANY (authz.team_ids('candidate:create')), false) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The creator held the candidate as recruiter meanwhile: they stay only if they are in the team.
  UPDATE eureka.candidate x SET team_id = p_team,
    recruiter_id = CASE WHEN EXISTS (SELECT 1 FROM eureka.team_member tm
                                      WHERE tm.team_id = p_team AND tm.user_id = c.recruiter_id
                                        AND tm.valid @> pg_catalog.now())
                        THEN c.recruiter_id END
  WHERE x.id = p_candidate;
  -- FR-NTF-10: the new team's lead and that lead's manager (ids only, rule 5).
  INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
  VALUES ('candidate.assigned', 'candidate', p_candidate,
          pg_catalog.jsonb_build_object('candidateId', p_candidate, 'teamId', p_team));
  RETURN p_team;
END $function$;

REVOKE ALL ON FUNCTION authz.assign_candidate_team(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assign_candidate_team(uuid, uuid) TO eureka_app;
RESET ROLE;
