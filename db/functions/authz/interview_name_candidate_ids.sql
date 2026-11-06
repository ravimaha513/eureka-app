-- authz.interview_name_candidate_ids: current definition (repeatable; db/functions/README.md).
-- since: 0570
-- Created for E-09 (docs/backend-audit/perf-baseline.md "R-13b"). Change this file, not a new migration.
--
-- The candidate ids whose name, as the Interviews board shows it, matches p_pattern (a
-- likeContains() pattern, ILIKE with ESCAPE '\'). The board shows the person's name when the
-- caller reads the candidate (candidate_read / person_read), else authz.interview_candidate_name
-- (0141) for a caller holding interview:read at org scope. So the set is:
--   * interview:read at org: candidates that have an interview (every interview is readable at org,
--     with its candidate id and, through interview_candidate_name, its name) and whose name matches;
--   * otherwise: the candidates of authz.person_name_matches (readable persons; person_id is unique),
--     plus the candidates of interviews assigned to the caller's coaches (authz.assigned_coach_ids,
--     0570), whose name interview_candidate_name also answers.
-- Nothing outside what the board already shows the caller is revealed. Used once per statement
-- (InitPlan, rule 3) by candidateNameMatch() in interviews.service.ts in place of the per-row
-- interview_candidate_name call of E-09: rows with a visible person keep their own name ILIKE, rows
-- without one are decided by membership in this set. apps/api/test/name-search-scope.db.int.test.ts
-- proves the board rows are unchanged for every seeded user.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.interview_name_candidate_ids(p_pattern text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_persons uuid[];
  v_coaches uuid[];
  v_assigned uuid[];
BEGIN
  IF p_pattern IS NULL OR authz.current_user_id() IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  IF coalesce(authz.has_org('interview:read'), false) THEN
    EXECUTE $q$
    SELECT coalesce(pg_catalog.array_agg(c.id), '{}'::uuid[])
      FROM eureka.person p
      JOIN eureka.candidate c ON c.person_id = p.id
     WHERE (p.first_name || ' ' || p.last_name) ILIKE $1::text ESCAPE '\'
       AND EXISTS (SELECT 1 FROM eureka.interview i WHERE i.candidate_id = c.id)
    $q$ INTO v_ids USING p_pattern;
  ELSE
    v_persons := authz.person_name_matches(p_pattern);
    SELECT coalesce(pg_catalog.array_agg(c.id), '{}'::uuid[]) INTO v_ids
      FROM pg_catalog.unnest(v_persons) m(id)
      JOIN eureka.candidate c ON c.person_id = m.id;
    v_coaches := authz.assigned_coach_ids('interview:read');
    IF coalesce(pg_catalog.cardinality(v_coaches), 0) > 0 THEN
      EXECUTE $q$
      SELECT coalesce(pg_catalog.array_agg(DISTINCT c.id), '{}'::uuid[])
        FROM eureka.interview i
        JOIN eureka.candidate c ON c.id = i.candidate_id
        JOIN eureka.person p ON p.id = c.person_id
       WHERE i.coach_id = ANY ($1::uuid[])
         AND (p.first_name || ' ' || p.last_name) ILIKE $2::text ESCAPE '\'
      $q$ INTO v_assigned USING v_coaches, p_pattern;
      v_ids := v_ids || coalesce(v_assigned, '{}'::uuid[]);
    END IF;
  END IF;
  RETURN v_ids;
END
$function$;

REVOKE ALL ON FUNCTION authz.interview_name_candidate_ids(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.interview_name_candidate_ids(text) TO eureka_app;
RESET ROLE;
