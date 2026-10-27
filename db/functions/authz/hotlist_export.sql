-- authz.hotlist_export: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0025, 0030, 0038, 0140. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.hotlist_export(p_status text, p_technology text, p_visibility text, p_search text, p_limit integer, p_location uuid DEFAULT NULL::uuid, p_visa text DEFAULT NULL::text, p_documents text DEFAULT NULL::text, p_resume boolean DEFAULT NULL::boolean, p_stay text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, first_name text, last_name text, technology text, team_name text, recruiter_name text, location_name text, visibility text, marketing_status text, priority text, marketing_start_date text, technical_rating smallint, phone text, visa_category text, documents_status text, gh_remote boolean, gh_location_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Same query as 0038; $6..$10 = p_location, p_visa, p_documents ('none' = not recorded), p_resume, p_stay.
  RETURN QUERY EXECUTE $q$
  WITH s AS MATERIALIZED (
    SELECT authz.hotlist_open() AS open,
           authz.has_org('hotlist:read') AS ho, authz.recruiter_ids('hotlist:read') AS hr,
           authz.team_ids('hotlist:read') AS ht, authz.location_ids('hotlist:read') AS hl,
           authz.all_teams('hotlist:read') AS hat, authz.shared_candidate_ids('hotlist:read') AS hsh,
           authz.has_org('report:export') AS eo, authz.recruiter_ids('report:export') AS er,
           authz.team_ids('report:export') AS et, authz.location_ids('report:export') AS el,
           authz.has_org('candidate:read') AS ro, authz.recruiter_ids('candidate:read') AS rr,
           authz.team_ids('candidate:read') AS rt, authz.location_ids('candidate:read') AS rl,
           authz.all_teams('candidate:read') AS rat, authz.shared_candidate_ids('candidate:read') AS rsh
  ),
  picked AS (
    SELECT c.*, p.first_name, p.last_name, p.phone_e164, t.name AS technology_name,
      coalesce(s.ro OR c.recruiter_id = ANY (s.rr) OR c.team_id = ANY (s.rt) OR c.location_id = ANY (s.rl)
               OR (s.rat AND c.visibility = 'all_teams' AND c.marketing_status IN ('active', 'full_of_interviews'))
               OR c.id = ANY (s.rsh), false) AS can_read
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    CROSS JOIN s
    WHERE coalesce(s.eo OR c.recruiter_id = ANY (s.er) OR c.team_id = ANY (s.et) OR c.location_id = ANY (s.el), false)
      AND coalesce(s.open
            OR s.ho OR c.recruiter_id = ANY (s.hr) OR c.team_id = ANY (s.ht) OR c.location_id = ANY (s.hl)
            OR (s.hat AND c.visibility = 'all_teams' AND c.marketing_status IN ('active', 'full_of_interviews'))
            OR c.id = ANY (s.hsh), false)
      AND c.marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped')
      AND ($1::text IS NULL OR c.marketing_status = $1::text)
      AND ($2::text IS NULL OR t.name = $2::text)
      AND ($3::text IS NULL OR c.visibility = $3::text)
      AND ($4::text IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE $4::text ESCAPE '\')
      AND ($6::uuid IS NULL OR c.location_id = $6::uuid)
      AND ($7::text IS NULL OR c.visa_category = $7::text)
      AND ($8::text IS NULL OR ($8::text = 'none' AND c.documents_status IS NULL) OR c.documents_status = $8::text)
      AND ($9::boolean IS NULL OR $9::boolean = (c.resume_url IS NOT NULL
             OR EXISTS (SELECT 1 FROM eureka.resume r WHERE r.candidate_id = c.id AND r.is_current)))
      AND ($10::text IS NULL OR ($10::text = 'remote' AND c.gh_remote)
             OR ($10::text = 'guest_house' AND c.gh_location_id IS NOT NULL))
    ORDER BY c.id
    LIMIT least(greatest(coalesce($5::int, 50000), 1), 50001)
  )
  SELECT h.id, h.first_name, h.last_name, h.technology_name,
         tm.name, u.display_name, l.name, h.visibility, h.marketing_status, h.priority,
         h.marketing_start_date::text,
         CASE WHEN h.can_read THEN h.technical_rating END,
         CASE WHEN h.phone_e164 IS NULL THEN NULL
              ELSE '•••-•••-' || lpad(right(regexp_replace(h.phone_e164, '\D', '', 'g'), 2), 2, '•') END,
         h.visa_category, h.documents_status, h.gh_remote, gl.name
  FROM picked h
  JOIN eureka.team tm ON tm.id = h.team_id
  JOIN eureka.location l ON l.id = h.location_id
  LEFT JOIN eureka.location gl ON gl.id = h.gh_location_id
  LEFT JOIN eureka.app_user u ON u.id = h.recruiter_id
  ORDER BY h.id
  $q$ USING p_status, p_technology, p_visibility, p_search, p_limit,
            p_location, p_visa, p_documents, p_resume, p_stay;
END
$function$;

REVOKE ALL ON FUNCTION authz.hotlist_export(text, text, text, text, integer, uuid, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_export(text, text, text, text, integer, uuid, text, text, boolean, text) TO eureka_app;
RESET ROLE;
