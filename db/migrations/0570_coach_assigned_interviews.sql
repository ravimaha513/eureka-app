-- An Interview Coach sees the interviews they are assigned to (interview.coach_id), not only those of
-- the teams they coach (coach_assignment). Without this a coach put on an interview outside their
-- coached teams saw an empty Interviews page, and "Open interview" on the coach calendar was a 404.
-- docs/interviews-settings-api.md IS-15. Additive: team coverage is unchanged.
--   1. authz.assigned_coach_ids(perm): the coaches whose assignments a coached grant covers. `coached`
--      = the caller; `coached_hierarchy` (Interview Lead) = the caller and everyone below them, the
--      same reach as authz.coached_team_ids (0220). Mirrored by EffectiveScope.coachIds (engine.ts).
--   2. interview_read gains that path as an InitPlan (rule 3), served by interview_coach_time (0130).
--      feedback_read and panelist_read follow interview visibility, so they come along.
--   3. authz.interview_candidate_name: an assigned coach may not be able to read the candidate, but
--      the board must still name who they are preparing. The name only, as for org readers (0141).
--   4. authz.feedback_kind_allowed: an assigned coach may leave 'coach' feedback on that interview.
--   5. authz.admin_explain_record also returns the coach, so the access explainer (AD-16) agrees with
--      the RLS probe. Ids only. Return type changes, hence the DROP.
-- authz.interview_name_candidate_ids is updated in db/functions/authz (since: 0570).
-- Every expression below is NULL-safe (rule 1); functions pin search_path (rule 2).

SET ROLE authz_definer;
CREATE FUNCTION authz.assigned_coach_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (SELECT authz.current_user_id() AS id),
  scopes AS (SELECT DISTINCT scope FROM authz.grants(perm))
  SELECT coalesce(pg_catalog.array_agg(x.id), '{}'::uuid[]) FROM (
    SELECT me.id FROM me
     WHERE me.id IS NOT NULL AND EXISTS (SELECT 1 FROM scopes WHERE scope IN ('coached','coached_hierarchy'))
    UNION
    SELECT rc.descendant_id FROM eureka.reporting_closure rc, me
     WHERE rc.ancestor_id = me.id AND EXISTS (SELECT 1 FROM scopes WHERE scope = 'coached_hierarchy')
  ) x
$$;
REVOKE ALL ON FUNCTION authz.assigned_coach_ids(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assigned_coach_ids(text) TO eureka_app;
RESET ROLE;

SET ROLE eureka_owner;
ALTER POLICY interview_read ON eureka.interview USING (
  (SELECT authz.has_org('interview:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('interview:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('interview:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('interview:read'))::uuid[])
  OR coach_id     = ANY ((SELECT authz.assigned_coach_ids('interview:read'))::uuid[])
  OR candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('interview:read'))))
);
RESET ROLE;

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.interview_candidate_name(p_interview uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.first_name || ' ' || p.last_name
    FROM eureka.interview i
    JOIN eureka.candidate c ON c.id = i.candidate_id
    JOIN eureka.person p ON p.id = c.person_id
   WHERE i.id = p_interview
     AND (coalesce(authz.has_org('interview:read'), false)
          OR coalesce(i.coach_id = ANY (authz.assigned_coach_ids('interview:read')), false))
$$;

CREATE OR REPLACE FUNCTION authz.feedback_kind_allowed(p_interview uuid, p_kind text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  perm constant text := 'interview.feedback:create';
  i record; c record;
  org boolean := false; rids uuid[] := '{}'; tids uuid[] := '{}'; lids uuid[] := '{}'; cids uuid[] := '{}';
BEGIN
  SELECT iv.recruiter_id, iv.team_id, iv.location_id, iv.candidate_id, iv.coach_id INTO i
  FROM eureka.interview iv WHERE iv.id = p_interview;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT cd.recruiter_id, cd.team_id, cd.location_id INTO c FROM eureka.candidate cd WHERE cd.id = i.candidate_id;
  IF p_kind = 'coach' THEN
    tids := authz.coached_team_ids(perm);
    cids := authz.assigned_coach_ids(perm);
  ELSIF p_kind = 'location' THEN
    lids := authz.location_ids(perm);
  ELSIF p_kind = 'client' THEN
    org := authz.has_org(perm); rids := authz.recruiter_ids(perm); tids := authz.owned_team_ids(perm);
  ELSE
    RETURN false;
  END IF;
  RETURN coalesce(org
    OR i.recruiter_id = ANY (rids) OR i.team_id = ANY (tids) OR i.location_id = ANY (lids)
    OR i.coach_id = ANY (cids)
    OR c.recruiter_id = ANY (rids) OR c.team_id = ANY (tids) OR c.location_id = ANY (lids), false);
END $$;

DROP FUNCTION authz.admin_explain_record(text, uuid);
CREATE FUNCTION authz.admin_explain_record(p_kind text, p_id uuid)
 RETURNS TABLE(candidate_id uuid, actor_recruiter_id uuid, actor_team_id uuid, actor_location_id uuid,
               recruiter_id uuid, team_id uuid, location_id uuid, visibility text, marketing_status text,
               actor_coach_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM authz.admin_guard(NULL);
  IF p_kind IS NULL OR p_kind NOT IN ('candidate', 'submission', 'interview', 'placement') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind = 'candidate' THEN
    RETURN QUERY SELECT c.id, NULL::uuid, NULL::uuid, NULL::uuid, c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status, NULL::uuid
      FROM eureka.candidate c WHERE c.id = p_id;
  ELSIF p_kind = 'submission' THEN
    RETURN QUERY SELECT c.id, s.recruiter_id, s.team_id, s.location_id, c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status, NULL::uuid
      FROM eureka.submission s JOIN eureka.candidate c ON c.id = s.candidate_id WHERE s.id = p_id;
  ELSIF p_kind = 'interview' THEN
    RETURN QUERY SELECT c.id, i.recruiter_id, i.team_id, i.location_id, c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status, i.coach_id
      FROM eureka.interview i JOIN eureka.candidate c ON c.id = i.candidate_id WHERE i.id = p_id;
  ELSE
    RETURN QUERY SELECT c.id, pl.recruiter_id, pl.team_id, pl.location_id, c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status, NULL::uuid
      FROM eureka.placement pl JOIN eureka.candidate c ON c.id = pl.candidate_id WHERE pl.id = p_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_not_found' USING ERRCODE = 'no_data_found';
  END IF;
END $function$;
REVOKE ALL ON FUNCTION authz.admin_explain_record(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_explain_record(text, uuid) TO eureka_app;
RESET ROLE;
