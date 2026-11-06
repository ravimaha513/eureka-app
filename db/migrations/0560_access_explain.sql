-- Access explainer (docs/admin-api.md AD-16): "why can this user see this record?".
-- An admin (access:manage + admin trait, authz.admin_guard) names a user and a candidate,
-- submission, interview or placement by id; the API explains the engine's verdict role by role and
-- checks it against RLS by probing the record as that user in a READ ONLY transaction.
-- Admins cannot read those tables (admin separation, 0500), so this function hands the API only the
-- record's ownership facts: ids of the recruiter, team and location (actor snapshot and candidate),
-- the candidate's visibility and marketing status. No names, phones, emails, rates or free text.
-- Every IF is NULL-safe (rule 1); search_path pinned, EXECUTE to eureka_app only (rule 2).

SET ROLE authz_definer;
CREATE FUNCTION authz.admin_explain_record(p_kind text, p_id uuid)
 RETURNS TABLE(candidate_id uuid, actor_recruiter_id uuid, actor_team_id uuid, actor_location_id uuid,
               recruiter_id uuid, team_id uuid, location_id uuid, visibility text, marketing_status text)
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
    RETURN QUERY SELECT c.id, NULL::uuid, NULL::uuid, NULL::uuid, c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status
      FROM eureka.candidate c WHERE c.id = p_id;
  ELSIF p_kind = 'submission' THEN
    RETURN QUERY SELECT c.id, s.recruiter_id, s.team_id, s.location_id, c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status
      FROM eureka.submission s JOIN eureka.candidate c ON c.id = s.candidate_id WHERE s.id = p_id;
  ELSIF p_kind = 'interview' THEN
    RETURN QUERY SELECT c.id, i.recruiter_id, i.team_id, i.location_id, c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status
      FROM eureka.interview i JOIN eureka.candidate c ON c.id = i.candidate_id WHERE i.id = p_id;
  ELSE
    RETURN QUERY SELECT c.id, pl.recruiter_id, pl.team_id, pl.location_id, c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status
      FROM eureka.placement pl JOIN eureka.candidate c ON c.id = pl.candidate_id WHERE pl.id = p_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_not_found' USING ERRCODE = 'no_data_found';
  END IF;
END $function$;
REVOKE ALL ON FUNCTION authz.admin_explain_record(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_explain_record(text, uuid) TO eureka_app;
RESET ROLE;
