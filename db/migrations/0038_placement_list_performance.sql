-- Placement lists and the Hot List export: the same two fixes as 0034.
--
-- 1. placement_read and assignment_read matched owned candidates with
--    `candidate_id = ANY ((SELECT authz.owned_candidate_ids(...))::uuid[])`, a
--    linear search of a runtime array per row (thousands of ids for broad
--    scopes). They now probe a hashed SubPlan built once from the same InitPlan
--    (rule 3 still holds: one call per statement). Same rows: the ids are
--    candidate primary keys (no NULL elements) and an empty array admits
--    nothing either way. placement_contact_read already probes the placement by
--    primary key under placement_read (0023), so it needs no change.
-- 2. authz.hotlist_export (0030) was a SQL definer function, never inlined, so
--    its catch-all `(p_x IS NULL OR ...)` filters ran with one generic plan.
--    It is now plpgsql running the same constant query text with
--    EXECUTE ... USING: each call is planned with its actual arguments. No text
--    is concatenated; the scope rules of 0030 are unchanged.
SET ROLE eureka_owner;

ALTER POLICY placement_read ON eureka.placement USING (
  (SELECT authz.has_org('placement:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('placement:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('placement:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('placement:read'))::uuid[])
  OR candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('placement:read'))))
);

ALTER POLICY assignment_read ON eureka.assignment USING (
  EXISTS (
    SELECT 1 FROM eureka.placement p
    WHERE p.id = assignment.placement_id
      AND ((SELECT authz.has_org('assignment:read'))
           OR p.recruiter_id = ANY ((SELECT authz.recruiter_ids('assignment:read'))::uuid[])
           OR p.team_id      = ANY ((SELECT authz.team_ids('assignment:read'))::uuid[])
           OR p.location_id  = ANY ((SELECT authz.location_ids('assignment:read'))::uuid[])
           OR p.candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('assignment:read'))))))
);

RESET ROLE;

SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.hotlist_export(
  p_status text, p_technology text, p_visibility text, p_search text, p_limit int)
RETURNS TABLE (
  id uuid, first_name text, last_name text, technology text,
  team_name text, recruiter_name text, location_name text, visibility text, marketing_status text,
  priority text, marketing_start_date text, technical_rating smallint, phone text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  -- Same query as 0030; $1..$5 = p_status, p_technology, p_visibility, p_search, p_limit.
  RETURN QUERY EXECUTE $q$
  WITH s AS MATERIALIZED (
    SELECT authz.hotlist_open() AS open,
           authz.has_org('hotlist:read') AS ho, authz.recruiter_ids('hotlist:read') AS hr,
           authz.team_ids('hotlist:read') AS ht, authz.location_ids('hotlist:read') AS hl,
           authz.all_teams('hotlist:read') AS hat,
           authz.has_org('report:export') AS eo, authz.recruiter_ids('report:export') AS er,
           authz.team_ids('report:export') AS et, authz.location_ids('report:export') AS el,
           authz.has_org('candidate:read') AS ro, authz.recruiter_ids('candidate:read') AS rr,
           authz.team_ids('candidate:read') AS rt, authz.location_ids('candidate:read') AS rl,
           authz.all_teams('candidate:read') AS rat
  ),
  picked AS (
    SELECT c.*, p.first_name, p.last_name, p.phone_e164, t.name AS technology_name,
      coalesce(s.ro OR c.recruiter_id = ANY (s.rr) OR c.team_id = ANY (s.rt) OR c.location_id = ANY (s.rl)
               OR (s.rat AND c.visibility = 'all_teams' AND c.marketing_status IN ('active', 'full_of_interviews')), false) AS can_read
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    CROSS JOIN s
    WHERE coalesce(s.eo OR c.recruiter_id = ANY (s.er) OR c.team_id = ANY (s.et) OR c.location_id = ANY (s.el), false)
      AND coalesce(s.open
            OR s.ho OR c.recruiter_id = ANY (s.hr) OR c.team_id = ANY (s.ht) OR c.location_id = ANY (s.hl)
            OR (s.hat AND c.visibility = 'all_teams' AND c.marketing_status IN ('active', 'full_of_interviews')), false)
      AND c.marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped')
      AND ($1::text IS NULL OR c.marketing_status = $1::text)
      AND ($2::text IS NULL OR t.name = $2::text)
      AND ($3::text IS NULL OR c.visibility = $3::text)
      AND ($4::text IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE $4::text ESCAPE '\')
    ORDER BY c.id
    LIMIT least(greatest(coalesce($5::int, 50000), 1), 50001)
  )
  SELECT h.id, h.first_name, h.last_name, h.technology_name,
         tm.name, u.display_name, l.name, h.visibility, h.marketing_status, h.priority,
         h.marketing_start_date::text,
         CASE WHEN h.can_read THEN h.technical_rating END,
         CASE WHEN h.phone_e164 IS NULL THEN NULL
              ELSE '•••-•••-' || lpad(right(regexp_replace(h.phone_e164, '\D', '', 'g'), 2), 2, '•') END
  FROM picked h
  JOIN eureka.team tm ON tm.id = h.team_id
  JOIN eureka.location l ON l.id = h.location_id
  LEFT JOIN eureka.app_user u ON u.id = h.recruiter_id
  ORDER BY h.id
  $q$ USING p_status, p_technology, p_visibility, p_search, p_limit;
END
$fn$;
-- CREATE OR REPLACE keeps the ACL; restate it so this file stands on its own.
REVOKE ALL ON FUNCTION authz.hotlist_export(text, text, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_export(text, text, text, text, int) TO eureka_app;

RESET ROLE;
