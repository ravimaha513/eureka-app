-- List performance on the 50k-candidate load seed (loadtest/README.md, 2026-10-01).
--
-- 1. submission_read / interview_read matched the caller's owned candidates with
--    `candidate_id = ANY ((SELECT authz.owned_candidate_ids(...))::uuid[])`. The
--    array is computed once (InitPlan), but `= ANY` over a runtime array is a
--    linear search per row: a location admin owns ~12,500 candidates, so every
--    submission the other branches reject costs ~12,500 comparisons. Scanning
--    the visible set took 2.1 s (location admin) and 1.5 s (manager) for
--    submissions, 0.6 s for interviews, before any join, sort or LIMIT; with no
--    index matching the list order (added since in 0027) that was the list
--    endpoints' whole cost, and it still is for anything that reads many rows.
--    `IN (SELECT unnest((SELECT ...)))` keeps the function call in an InitPlan
--    (once per statement, rule 3) and turns the membership test into a hashed
--    SubPlan: one hash probe per row. Same rows: candidate ids are primary keys
--    (no NULL elements), and an empty or NULL array admits nothing either way.
-- 2. authz.hotlist_page was a SQL function: definer functions are never inlined,
--    so its body ran with a generic plan in which the `(p_x IS NULL OR ...)`
--    filters cannot be simplified and are estimated at a few rows. The planner
--    then read every Hot List candidate, sorted all ~40k and kept 51 (~210 ms
--    per page). It is now plpgsql running the same, constant query text with
--    EXECUTE ... USING, which plans each call with the actual values (a custom
--    plan): the unfiltered page walks candidate_pkey and stops after 51 rows.
--    No text is concatenated: the arguments are bound parameters only.
SET ROLE eureka_owner;

ALTER POLICY submission_read ON eureka.submission USING (
  (SELECT authz.has_org('submission:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('submission:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('submission:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('submission:read'))::uuid[])
  OR candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('submission:read'))))
);

ALTER POLICY interview_read ON eureka.interview USING (
  (SELECT authz.has_org('interview:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('interview:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('interview:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('interview:read'))::uuid[])
  OR candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('interview:read'))))
);

RESET ROLE;

SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.hotlist_page(
  p_status text, p_technology text, p_visibility text, p_search text, p_cursor uuid, p_limit int)
RETURNS TABLE (
  id uuid, first_name text, last_name text, technology text,
  team_id uuid, team_name text, recruiter_id uuid, recruiter_name text,
  location_id uuid, location_name text, visibility text, marketing_status text, priority text,
  marketing_start_date text, technical_rating smallint, phone text, phone_masked boolean, readable boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  -- Same query as 0015; $1..$6 = p_status, p_technology, p_visibility, p_search, p_cursor, p_limit.
  RETURN QUERY EXECUTE $q$
  WITH s AS MATERIALIZED (
    SELECT authz.hotlist_open() AS open,
           authz.has_org('candidate.phone:read') AS po, authz.recruiter_ids('candidate.phone:read') AS pr,
           authz.team_ids('candidate.phone:read') AS pt, authz.location_ids('candidate.phone:read') AS pl,
           authz.has_org('candidate:read') AS ro, authz.recruiter_ids('candidate:read') AS rr,
           authz.team_ids('candidate:read') AS rt, authz.location_ids('candidate:read') AS rl,
           authz.all_teams('candidate:read') AS rat
  ),
  page AS (
    SELECT c.*, p.first_name, p.last_name, p.phone_e164, t.name AS technology_name
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    WHERE (SELECT s.open FROM s)
      AND c.marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped')
      AND ($1::text IS NULL OR c.marketing_status = $1::text)
      AND ($2::text IS NULL OR t.name = $2::text)
      AND ($3::text IS NULL OR c.visibility = $3::text)
      AND ($4::text IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE $4::text ESCAPE '\')
      AND ($5::uuid IS NULL OR c.id > $5::uuid)
    ORDER BY c.id
    LIMIT least(greatest(coalesce($6::int, 50), 1), 201)
  ),
  scoped AS (
    SELECT h.*,
      coalesce(s.po OR h.recruiter_id = ANY (s.pr) OR h.team_id = ANY (s.pt) OR h.location_id = ANY (s.pl), false) AS phone_allowed,
      coalesce(s.ro OR h.recruiter_id = ANY (s.rr) OR h.team_id = ANY (s.rt) OR h.location_id = ANY (s.rl)
               OR (s.rat AND h.visibility = 'all_teams' AND h.marketing_status IN ('active', 'full_of_interviews')), false) AS can_read
    FROM page h CROSS JOIN s
  )
  SELECT h.id, h.first_name, h.last_name, h.technology_name,
         h.team_id, tm.name, h.recruiter_id, u.display_name,
         h.location_id, l.name, h.visibility, h.marketing_status, h.priority,
         h.marketing_start_date::text,
         CASE WHEN h.can_read THEN h.technical_rating END,
         CASE WHEN h.phone_allowed THEN h.phone_e164
              WHEN h.phone_e164 IS NULL THEN NULL
              ELSE '•••-•••-' || lpad(right(regexp_replace(h.phone_e164, '\D', '', 'g'), 2), 2, '•') END,
         (h.phone_e164 IS NOT NULL AND NOT h.phone_allowed),
         h.can_read
  FROM scoped h
  JOIN eureka.team tm ON tm.id = h.team_id
  JOIN eureka.location l ON l.id = h.location_id
  LEFT JOIN eureka.app_user u ON u.id = h.recruiter_id
  ORDER BY h.id
  $q$ USING p_status, p_technology, p_visibility, p_search, p_cursor, p_limit;
END
$fn$;
REVOKE ALL ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, int) TO eureka_app;

RESET ROLE;
