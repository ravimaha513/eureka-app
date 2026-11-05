-- authz.person_name_matches: current definition (repeatable; db/functions/README.md).
-- since: 0521
-- Created for R-13b (docs/backend-audit/perf-baseline.md "R-13b"). Change this file, not a new migration.
--
-- The ids of the persons whose full name matches p_pattern (a likeContains() pattern, ILIKE with
-- ESCAPE '\') AND that the caller may read: exactly the rows `SELECT id FROM eureka.person WHERE
-- <name> ILIKE p_pattern` returns as eureka_app under the person_read policy (a person is readable
-- when its candidate is readable under candidate_read; candidate.person_id is unique). The scope
-- test below is the candidate_read predicate (0240) over the same authz helpers, so the function
-- never reveals that a name exists outside the caller's scope (perf-baseline.md "Follow-up").
-- apps/api/test/name-search-scope.db.int.test.ts proves it equals the RLS result for every seeded
-- user and pins the candidate_read text: change both together.
--
-- Why: as eureka_app the RLS security barrier keeps the (not leakproof) ILIKE off the trigram index
-- person_name_trgm (0509); here, as authz_definer, the match is index-backed. Callers use it as an
-- InitPlan id set (rule 3) next to the unchanged ILIKE, e.g.
--   p.id IN (SELECT pg_catalog.unnest((SELECT authz.person_name_matches($n))))
-- (nameMatch() in apps/api/src/platform/sql.ts). EXECUTE ... USING plans the search with the bound
-- pattern, so the trigram index is chosen for 3+ character terms.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.person_name_matches(p_pattern text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
BEGIN
  IF p_pattern IS NULL OR authz.current_user_id() IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  -- Org scope reads every candidate (the first disjunct of candidate_read): skip resolving the
  -- other scope sets (each helper call resolves the caller's grants, ~2 ms).
  IF coalesce(authz.has_org('candidate:read'), false) THEN
    EXECUTE $q$
    SELECT coalesce(pg_catalog.array_agg(p.id), '{}'::uuid[])
      FROM eureka.person p
     WHERE (p.first_name || ' ' || p.last_name) ILIKE $1::text ESCAPE '\'
       AND EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.person_id = p.id)
    $q$ INTO v_ids USING p_pattern;
    RETURN v_ids;
  END IF;
  EXECUTE $q$
  WITH s AS MATERIALIZED (
    SELECT authz.recruiter_ids('candidate:read') AS rr,
           authz.team_ids('candidate:read') AS rt, authz.location_ids('candidate:read') AS rl,
           authz.all_teams('candidate:read') AS rat, authz.shared_candidate_ids('candidate:read') AS rsh
  )
  SELECT coalesce(pg_catalog.array_agg(p.id), '{}'::uuid[])
    FROM eureka.person p
    JOIN eureka.candidate c ON c.person_id = p.id
   CROSS JOIN s
   WHERE (p.first_name || ' ' || p.last_name) ILIKE $1::text ESCAPE '\'
     AND coalesce(c.recruiter_id = ANY (s.rr)
          OR c.team_id = ANY (s.rt)
          OR c.location_id = ANY (s.rl)
          OR (s.rat AND c.visibility = 'all_teams' AND c.marketing_status = ANY (ARRAY['active', 'full_of_interviews']))
          OR c.id = ANY (s.rsh), false)
  $q$ INTO v_ids USING p_pattern;
  RETURN v_ids;
END
$function$;

REVOKE ALL ON FUNCTION authz.person_name_matches(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.person_name_matches(text) TO eureka_app;
RESET ROLE;
