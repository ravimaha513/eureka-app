-- Review follow-up for 0025: authz.hotlist_export checked only that hotlist:read
-- is held, not its scope; rows came from the report:export scope alone. Each
-- exported row now must also be on the caller's Hot List, decided the way
-- authz.hotlist_page decides it: the open Hot List (authz.hotlist_open(), policy
-- "everyone") or the hotlist:read scope, including the Open-to-all-teams rule
-- (AS-07, policy "team"). Scope is still resolved once per call.
SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.hotlist_export(
  p_status text, p_technology text, p_visibility text, p_search text, p_limit int)
RETURNS TABLE (
  id uuid, first_name text, last_name text, technology text,
  team_name text, recruiter_name text, location_name text, visibility text, marketing_status text,
  priority text, marketing_start_date text, technical_rating smallint, phone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
      AND (p_status IS NULL OR c.marketing_status = p_status)
      AND (p_technology IS NULL OR t.name = p_technology)
      AND (p_visibility IS NULL OR c.visibility = p_visibility)
      AND (p_search IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE p_search ESCAPE '\')
    ORDER BY c.id
    LIMIT least(greatest(coalesce(p_limit, 50000), 1), 50001)
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
$$;
-- CREATE OR REPLACE keeps the ACL; restate it so this file stands on its own.
REVOKE ALL ON FUNCTION authz.hotlist_export(text, text, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_export(text, text, text, text, int) TO eureka_app;

RESET ROLE;
