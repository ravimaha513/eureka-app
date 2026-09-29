-- authz.owns returned NULL (not false) when the candidate has no recruiter and
-- nothing else matched: NULL = ANY(non-empty array) is NULL. RLS treats NULL as
-- false, but plpgsql `IF NOT authz.owns(...)` skips the RAISE on NULL, so
-- authz.transition_candidate and the column guard could be bypassed at the
-- database layer for unassigned candidates (the API layer still refused).
-- Found in review; regression tests in apps/api/test/rls.int.test.ts.
SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.owns(perm text, p_recruiter uuid, p_team uuid, p_location uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
       authz.has_org(perm)
    OR p_recruiter = ANY (authz.recruiter_ids(perm))
    OR p_team      = ANY (authz.team_ids(perm))
    OR p_location  = ANY (authz.location_ids(perm)),
    false)
$$;

RESET ROLE;
