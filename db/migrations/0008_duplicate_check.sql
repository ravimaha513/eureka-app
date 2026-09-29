-- Duplicate submission warning (design B3, N11): answers only yes/no, so it
-- cannot be used to enumerate other teams' records.
SET ROLE authz_definer;
CREATE FUNCTION authz.recent_submission_exists(p_candidate uuid, p_client uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.candidate_visible(p_candidate, 'submission:create') AND EXISTS (
    SELECT 1 FROM eureka.submission s
    WHERE s.candidate_id = p_candidate AND s.client_id = p_client
      AND s.submitted_at > pg_catalog.now() - interval '90 days'
      AND s.status NOT IN ('withdrawn'))
$$;
RESET ROLE;
REVOKE ALL ON FUNCTION authz.recent_submission_exists(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.recent_submission_exists(uuid, uuid) TO eureka_app;
