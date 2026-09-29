-- Review follow-ups (2026-09-29):
-- 1. authz.hotlist_page evaluated owns()/candidate_visible() per row; each call
--    re-resolves the caller's grants (definer functions are never inlined), so
--    a 200-row page took ~1.3 s locally. The caller's scope is now computed
--    once per call and compared inline.
-- 2. authz.transition_candidate skipped the transition check when p_to was NULL
--    (NULL IN (...) is NULL); only the NOT NULL column stopped it.
SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.hotlist_page(
  p_status text, p_technology text, p_visibility text, p_search text, p_cursor uuid, p_limit int)
RETURNS TABLE (
  id uuid, first_name text, last_name text, technology text,
  team_id uuid, team_name text, recruiter_id uuid, recruiter_name text,
  location_id uuid, location_name text, visibility text, marketing_status text, priority text,
  marketing_start_date text, technical_rating smallint, phone text, phone_masked boolean, readable boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
      AND (p_status IS NULL OR c.marketing_status = p_status)
      AND (p_technology IS NULL OR t.name = p_technology)
      AND (p_visibility IS NULL OR c.visibility = p_visibility)
      AND (p_search IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE p_search ESCAPE '\')
      AND (p_cursor IS NULL OR c.id > p_cursor)
    ORDER BY c.id
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 201)
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
$$;

CREATE OR REPLACE FUNCTION authz.transition_candidate(p_candidate uuid, p_to text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM eureka.candidate WHERE id = p_candidate FOR UPDATE;
  IF NOT FOUND OR NOT (
       authz.owns('candidate:read', c.recruiter_id, c.team_id, c.location_id)
       OR (authz.all_teams('candidate:read') AND c.visibility = 'all_teams'
           AND c.marketing_status IN ('active','full_of_interviews'))) THEN
    RAISE EXCEPTION 'candidate not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT authz.owns('candidate:update', c.recruiter_id, c.team_id, c.location_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to IS NULL OR NOT (c.marketing_status, p_to) IN (
      ('in_training','active'),
      ('active','on_hold'), ('active','stopped'), ('active','full_of_interviews'), ('active','confirmation'),
      ('on_hold','active'), ('full_of_interviews','active'),
      ('confirmation','active'), ('bench','active'),
      ('in_training','terminated'), ('active','terminated'), ('on_hold','terminated'),
      ('stopped','terminated'), ('full_of_interviews','terminated'), ('confirmation','terminated'),
      ('bench','terminated')) THEN
    RAISE EXCEPTION 'invalid transition % -> %', c.marketing_status, p_to USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.candidate SET marketing_status = p_to,
    bench_since = CASE WHEN p_to = 'bench' THEN current_date ELSE NULL END
  WHERE id = p_candidate;
  RETURN p_to;
END $$;

RESET ROLE;
