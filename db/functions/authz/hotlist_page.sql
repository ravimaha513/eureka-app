-- authz.hotlist_page: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0011, 0015, 0034, 0140. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.hotlist_page(p_status text, p_technology text, p_visibility text, p_search text, p_cursor uuid, p_limit integer, p_location uuid DEFAULT NULL::uuid, p_visa text DEFAULT NULL::text, p_documents text DEFAULT NULL::text, p_resume boolean DEFAULT NULL::boolean, p_stay text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, first_name text, last_name text, technology text, team_id uuid, team_name text, recruiter_id uuid, recruiter_name text, location_id uuid, location_name text, visibility text, marketing_status text, priority text, marketing_start_date text, technical_rating smallint, phone text, phone_masked boolean, readable boolean, visa_category text, documents_status text, gh_remote boolean, gh_location_name text, has_resume boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Same query as 0034; $7..$11 = p_location, p_visa, p_documents ('none' = not recorded), p_resume, p_stay.
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
    SELECT c.*, p.first_name, p.last_name, p.phone_e164, t.name AS technology_name,
           (c.resume_url IS NOT NULL OR EXISTS (SELECT 1 FROM eureka.resume r WHERE r.candidate_id = c.id AND r.is_current)) AS resume_on_file
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
      AND ($7::uuid IS NULL OR c.location_id = $7::uuid)
      AND ($8::text IS NULL OR c.visa_category = $8::text)
      AND ($9::text IS NULL OR ($9::text = 'none' AND c.documents_status IS NULL) OR c.documents_status = $9::text)
      AND ($10::boolean IS NULL OR $10::boolean = (c.resume_url IS NOT NULL
             OR EXISTS (SELECT 1 FROM eureka.resume r WHERE r.candidate_id = c.id AND r.is_current)))
      AND ($11::text IS NULL OR ($11::text = 'remote' AND c.gh_remote)
             OR ($11::text = 'guest_house' AND c.gh_location_id IS NOT NULL))
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
         h.can_read,
         h.visa_category, h.documents_status, h.gh_remote, gl.name, h.resume_on_file
  FROM scoped h
  JOIN eureka.team tm ON tm.id = h.team_id
  JOIN eureka.location l ON l.id = h.location_id
  LEFT JOIN eureka.location gl ON gl.id = h.gh_location_id
  LEFT JOIN eureka.app_user u ON u.id = h.recruiter_id
  ORDER BY h.id
  $q$ USING p_status, p_technology, p_visibility, p_search, p_cursor, p_limit,
            p_location, p_visa, p_documents, p_resume, p_stay;
END
$function$;

REVOKE ALL ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, integer, uuid, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, integer, uuid, text, text, boolean, text) TO eureka_app;
RESET ROLE;
