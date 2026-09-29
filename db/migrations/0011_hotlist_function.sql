-- Open Hot List without widening base-table RLS (review of 0010).
-- 0010 made every Hot List candidate row, and through person_read every person
-- row (raw phone, personal email, DOB columns), readable by every user. Any
-- future query, report or policy that reads candidate or person would have
-- inherited that. Instead, the open Hot List is served by one SECURITY DEFINER
-- function that returns only list columns and masks the phone in SQL.
SET search_path = eureka, public;

DROP POLICY candidate_hotlist_read ON candidate;

-- authz_definer reads person and technology only inside authz functions.
CREATE POLICY definer_read ON person FOR SELECT TO authz_definer USING (true);
GRANT SELECT ON technology TO authz_definer;

SET ROLE authz_definer;

ALTER TABLE authz.policy_setting
  ADD CONSTRAINT policy_setting_value CHECK (key <> 'hotlist_visibility' OR value IN ('everyone', 'team'));

-- Only an active user counts (a stale or unknown id sees nothing).
CREATE OR REPLACE FUNCTION authz.hotlist_open() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
      SELECT 1 FROM eureka.app_user u WHERE u.id = authz.current_user_id() AND u.status = 'active')
    AND EXISTS (
      SELECT 1 FROM authz.policy_setting WHERE key = 'hotlist_visibility' AND value = 'everyone')
$$;

-- Lets the API check at startup that code and database agree on the switch.
CREATE FUNCTION authz.hotlist_visibility() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT value FROM authz.policy_setting WHERE key = 'hotlist_visibility'
$$;
REVOKE ALL ON FUNCTION authz.hotlist_visibility() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_visibility() TO eureka_app;

-- One page of the open Hot List. Phone is returned only when the caller owns
-- the candidate for candidate.phone:read; otherwise masked like the app does
-- (•••-•••-NN). Technical rating only for candidates the caller can read.
-- DOB and contact emails are never returned. Returns nothing unless the
-- policy is "everyone".
CREATE FUNCTION authz.hotlist_page(
  p_status text, p_technology text, p_visibility text, p_search text, p_cursor uuid, p_limit int)
RETURNS TABLE (
  id uuid, first_name text, last_name text, technology text,
  team_id uuid, team_name text, recruiter_id uuid, recruiter_name text,
  location_id uuid, location_name text, visibility text, marketing_status text, priority text,
  marketing_start_date text, technical_rating smallint, phone text, phone_masked boolean, readable boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH page AS (
    SELECT c.*, p.first_name, p.last_name, p.phone_e164, t.name AS technology_name
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    WHERE authz.hotlist_open()
      AND c.marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped')
      AND (p_status IS NULL OR c.marketing_status = p_status)
      AND (p_technology IS NULL OR t.name = p_technology)
      AND (p_visibility IS NULL OR c.visibility = p_visibility)
      AND (p_search IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE p_search)
      AND (p_cursor IS NULL OR c.id > p_cursor)
    ORDER BY c.id
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 201)
  )
  SELECT h.id, h.first_name, h.last_name, h.technology_name,
         h.team_id, tm.name, h.recruiter_id, u.display_name,
         h.location_id, l.name, h.visibility, h.marketing_status, h.priority,
         h.marketing_start_date::text,
         CASE WHEN r.readable THEN h.technical_rating END,
         CASE WHEN ph.allowed THEN h.phone_e164
              WHEN h.phone_e164 IS NULL THEN NULL
              ELSE '•••-•••-' || lpad(right(regexp_replace(h.phone_e164, '\D', '', 'g'), 2), 2, '•') END,
         (h.phone_e164 IS NOT NULL AND NOT ph.allowed),
         r.readable
  FROM page h
  JOIN eureka.team tm ON tm.id = h.team_id
  JOIN eureka.location l ON l.id = h.location_id
  LEFT JOIN eureka.app_user u ON u.id = h.recruiter_id
  CROSS JOIN LATERAL (SELECT coalesce(authz.owns('candidate.phone:read', h.recruiter_id, h.team_id, h.location_id), false) AS allowed) ph
  CROSS JOIN LATERAL (SELECT authz.candidate_visible(h.id, 'candidate:read') AS readable) r
  ORDER BY h.id
$$;
REVOKE ALL ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, int) TO eureka_app;

RESET ROLE;
