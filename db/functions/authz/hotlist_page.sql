-- authz.hotlist_page: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0011, 0015, 0034, 0140. Change this file, not a new migration.
-- 0290 (signature dropped there): p_more carries the Hot List sheet filters and the sort,
-- so later filters need no new signature; returns the team lead and in-person.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.hotlist_page(p_status text, p_technology text, p_visibility text, p_search text, p_cursor uuid, p_limit integer, p_location uuid DEFAULT NULL::uuid, p_visa text DEFAULT NULL::text, p_documents text DEFAULT NULL::text, p_resume boolean DEFAULT NULL::boolean, p_stay text DEFAULT NULL::text, p_more jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(id uuid, first_name text, last_name text, technology text, team_id uuid, team_name text, recruiter_id uuid, recruiter_name text, location_id uuid, location_name text, visibility text, marketing_status text, priority text, marketing_start_date text, technical_rating smallint, phone text, phone_masked boolean, readable boolean, visa_category text, documents_status text, gh_remote boolean, gh_location_name text, has_resume boolean, lead_name text, in_person_ok boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- $7..$11 = p_location, p_visa, p_documents ('none' = not recorded), p_resume, p_stay.
  -- $12 = p_more: priority, teamId, recruiterId, inPerson (yes/no), ghLocationId, sort
  -- (default | priority | days | name). Paging is keyset on (sort key, id), the cursor
  -- row's key read back by id; the API's scoped list uses the same order (sortKey).
  RETURN QUERY EXECUTE $q$
  WITH s AS MATERIALIZED (
    SELECT authz.hotlist_open() AS open,
           authz.has_org('candidate.phone:read') AS po, authz.recruiter_ids('candidate.phone:read') AS pr,
           authz.team_ids('candidate.phone:read') AS pt, authz.location_ids('candidate.phone:read') AS pl,
           authz.has_org('candidate:read') AS ro, authz.recruiter_ids('candidate:read') AS rr,
           authz.team_ids('candidate:read') AS rt, authz.location_ids('candidate:read') AS rl,
           authz.all_teams('candidate:read') AS rat, authz.shared_candidate_ids('candidate:read') AS rsh,
           coalesce($12::jsonb ->> 'sort', 'default') AS sort
  ),
  cur AS (
    SELECT CASE (SELECT s.sort FROM s)
             WHEN 'priority' THEN cc.priority
             WHEN 'days' THEN coalesce(cc.marketing_start_date::text, '9999-12-31')
             WHEN 'name' THEN lower(pp.first_name || ' ' || pp.last_name)
             ELSE '' END AS sk, cc.id
    FROM eureka.candidate cc JOIN eureka.person pp ON pp.id = cc.person_id
    WHERE cc.id = $5::uuid
  ),
  page AS (
    SELECT c.*, p.first_name, p.last_name, p.phone_e164, t.name AS technology_name,
           (c.resume_url IS NOT NULL OR EXISTS (SELECT 1 FROM eureka.resume r WHERE r.candidate_id = c.id AND r.is_current)) AS resume_on_file,
           CASE (SELECT s.sort FROM s)
             WHEN 'priority' THEN c.priority
             WHEN 'days' THEN coalesce(c.marketing_start_date::text, '9999-12-31')
             WHEN 'name' THEN lower(p.first_name || ' ' || p.last_name)
             ELSE '' END AS sk
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    WHERE (SELECT s.open FROM s)
      AND c.marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped')
      AND ($1::text IS NULL OR c.marketing_status = $1::text)
      AND ($2::text IS NULL OR t.name = $2::text)
      AND ($3::text IS NULL OR c.visibility = $3::text)
      AND ($4::text IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE $4::text ESCAPE '\')
      AND ($7::uuid IS NULL OR c.location_id = $7::uuid)
      AND ($8::text IS NULL OR c.visa_category = $8::text)
      AND ($9::text IS NULL OR ($9::text = 'none' AND c.documents_status IS NULL) OR c.documents_status = $9::text)
      AND ($10::boolean IS NULL OR $10::boolean = (c.resume_url IS NOT NULL
             OR EXISTS (SELECT 1 FROM eureka.resume r WHERE r.candidate_id = c.id AND r.is_current)))
      AND ($11::text IS NULL OR ($11::text = 'remote' AND c.gh_remote)
             OR ($11::text = 'guest_house' AND c.gh_location_id IS NOT NULL))
      AND ($12::jsonb ->> 'priority' IS NULL OR c.priority = $12::jsonb ->> 'priority')
      AND ($12::jsonb ->> 'teamId' IS NULL OR c.team_id = ($12::jsonb ->> 'teamId')::uuid)
      AND ($12::jsonb ->> 'recruiterId' IS NULL OR c.recruiter_id = ($12::jsonb ->> 'recruiterId')::uuid)
      AND ($12::jsonb ->> 'inPerson' IS NULL OR c.in_person_ok IS NOT DISTINCT FROM ($12::jsonb ->> 'inPerson' = 'yes'))
      AND ($12::jsonb ->> 'ghLocationId' IS NULL OR c.gh_location_id = ($12::jsonb ->> 'ghLocationId')::uuid)
  ),
  after AS (
    SELECT h.* FROM page h
    WHERE $5::uuid IS NULL OR (h.sk, h.id) > (SELECT cur.sk, cur.id FROM cur)
    ORDER BY h.sk, h.id
    LIMIT least(greatest(coalesce($6::int, 50), 1), 201)
  ),
  scoped AS (
    SELECT h.*,
      coalesce(s.po OR h.recruiter_id = ANY (s.pr) OR h.team_id = ANY (s.pt) OR h.location_id = ANY (s.pl), false) AS phone_allowed,
      coalesce(s.ro OR h.recruiter_id = ANY (s.rr) OR h.team_id = ANY (s.rt) OR h.location_id = ANY (s.rl)
               OR (s.rat AND h.visibility = 'all_teams' AND h.marketing_status IN ('active', 'full_of_interviews'))
               OR h.id = ANY (s.rsh), false) AS can_read
    FROM after h CROSS JOIN s
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
         h.visa_category, h.documents_status, h.gh_remote, gl.name, h.resume_on_file,
         lu.display_name, h.in_person_ok
  FROM scoped h
  JOIN eureka.team tm ON tm.id = h.team_id
  JOIN eureka.location l ON l.id = h.location_id
  LEFT JOIN eureka.location gl ON gl.id = h.gh_location_id
  LEFT JOIN eureka.app_user u ON u.id = h.recruiter_id
  LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
  ORDER BY h.sk, h.id
  $q$ USING p_status, p_technology, p_visibility, p_search, p_cursor, p_limit,
            p_location, p_visa, p_documents, p_resume, p_stay, p_more;
END
$function$;

REVOKE ALL ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, integer, uuid, text, text, boolean, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, integer, uuid, text, text, boolean, text, jsonb) TO eureka_app;
RESET ROLE;
