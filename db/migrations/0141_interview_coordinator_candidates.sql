-- Interview coordinators no longer read candidates org-wide (gap/candidates, Eureka App 4
-- spec: a team-assigned candidate is visible to that lead's sales team and the interview prep
-- team only; docs/candidates-api.md "Interview coordinators").
-- The catalog drops `candidate:read` from interview_coordinator (the migration runner rewrites
-- role_permission), so the Candidates list, profiles and the Hot List are closed to them. They
-- keep `interview:read` at org scope; the Interviews board and the support calendar block still
-- need the candidate's name on each interview, which this function supplies:
--   authz.interview_candidate_name(interview): the candidate's display name for a caller who
--   holds `interview:read` at org scope, else NULL. Name only (no contact, status or team);
--   the coordinators' email keeps its own details read (0089 authz.interview_notice_details).
-- Callers use it only where their candidate join came back empty (RLS), so every other reader
-- is unchanged. Rule 1 (NULL-safe), rule 2 (pinned search_path, exact EXECUTE grant).
SET search_path = eureka, public;

SET ROLE authz_definer;
CREATE FUNCTION authz.interview_candidate_name(p_interview uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.first_name || ' ' || p.last_name
    FROM eureka.interview i
    JOIN eureka.candidate c ON c.id = i.candidate_id
    JOIN eureka.person p ON p.id = c.person_id
   WHERE i.id = p_interview
     AND coalesce(authz.has_org('interview:read'), false)
$$;
REVOKE ALL ON FUNCTION authz.interview_candidate_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.interview_candidate_name(uuid) TO eureka_app;
RESET ROLE;
