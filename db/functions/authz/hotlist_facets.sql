-- authz.hotlist_facets: current definition (repeatable; db/functions/README.md).
-- Facet counts for the open Hot List (OD-01), beside authz.hotlist_page: for each filter, how
-- many Hot List candidates carry each value when every OTHER filter in effect applies (so a
-- filter's own choices stay visible). Counts only, never candidate data; the predicates match
-- authz.hotlist_page (generated together) and the API's scoped facets (list-filters.ts).
-- $1 = name search (ILIKE pattern), $2 = resume, $3 = stay, $4 = p_more as hotlist_page
-- (f = multi-value filters, not = inverted keys, inPerson).

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.hotlist_facets(p_search text, p_resume boolean, p_stay text, p_more jsonb)
 RETURNS TABLE(facet text, value text, n bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY EXECUTE $q$
  WITH m AS MATERIALIZED (
    SELECT
      c.marketing_status AS "v_status",
      ($4::jsonb #> '{f,status}' IS NULL
             OR coalesce(c.marketing_status = ANY (ARRAY(SELECT x FROM jsonb_array_elements_text($4::jsonb #> '{f,status}') x)), false) <> coalesce(($4::jsonb -> 'not') ? 'status', false)) AS "m_status",
      t.name AS "v_technology",
      ($4::jsonb #> '{f,technology}' IS NULL
             OR coalesce(t.name = ANY (ARRAY(SELECT x FROM jsonb_array_elements_text($4::jsonb #> '{f,technology}') x)), false) <> coalesce(($4::jsonb -> 'not') ? 'technology', false)) AS "m_technology",
      c.visibility AS "v_visibility",
      ($4::jsonb #> '{f,visibility}' IS NULL
             OR coalesce(c.visibility = ANY (ARRAY(SELECT x FROM jsonb_array_elements_text($4::jsonb #> '{f,visibility}') x)), false) <> coalesce(($4::jsonb -> 'not') ? 'visibility', false)) AS "m_visibility",
      c.location_id::text AS "v_locationId",
      ($4::jsonb #> '{f,locationId}' IS NULL
             OR coalesce(c.location_id = ANY (ARRAY(SELECT x::uuid FROM jsonb_array_elements_text($4::jsonb #> '{f,locationId}') x)), false) <> coalesce(($4::jsonb -> 'not') ? 'locationId', false)) AS "m_locationId",
      c.visa_category AS "v_visa",
      ($4::jsonb #> '{f,visa}' IS NULL
             OR coalesce(c.visa_category = ANY (ARRAY(SELECT x FROM jsonb_array_elements_text($4::jsonb #> '{f,visa}') x)), false) <> coalesce(($4::jsonb -> 'not') ? 'visa', false)) AS "m_visa",
      coalesce(c.documents_status, 'none') AS "v_documents",
      ($4::jsonb #> '{f,documents}' IS NULL
             OR coalesce(c.documents_status = ANY (ARRAY(SELECT x FROM jsonb_array_elements_text($4::jsonb #> '{f,documents}') x)) OR (c.documents_status IS NULL AND 'none' = ANY (ARRAY(SELECT x FROM jsonb_array_elements_text($4::jsonb #> '{f,documents}') x))), false) <> coalesce(($4::jsonb -> 'not') ? 'documents', false)) AS "m_documents",
      c.priority AS "v_priority",
      ($4::jsonb #> '{f,priority}' IS NULL
             OR coalesce(c.priority = ANY (ARRAY(SELECT x FROM jsonb_array_elements_text($4::jsonb #> '{f,priority}') x)), false) <> coalesce(($4::jsonb -> 'not') ? 'priority', false)) AS "m_priority",
      c.team_id::text AS "v_teamId",
      ($4::jsonb #> '{f,teamId}' IS NULL
             OR coalesce(c.team_id = ANY (ARRAY(SELECT x::uuid FROM jsonb_array_elements_text($4::jsonb #> '{f,teamId}') x)), false) <> coalesce(($4::jsonb -> 'not') ? 'teamId', false)) AS "m_teamId",
      c.recruiter_id::text AS "v_recruiterId",
      ($4::jsonb #> '{f,recruiterId}' IS NULL
             OR coalesce(c.recruiter_id = ANY (ARRAY(SELECT x::uuid FROM jsonb_array_elements_text($4::jsonb #> '{f,recruiterId}') x)), false) <> coalesce(($4::jsonb -> 'not') ? 'recruiterId', false)) AS "m_recruiterId",
      c.gh_location_id::text AS "v_ghLocationId",
      ($4::jsonb #> '{f,ghLocationId}' IS NULL
             OR coalesce(c.gh_location_id = ANY (ARRAY(SELECT x::uuid FROM jsonb_array_elements_text($4::jsonb #> '{f,ghLocationId}') x)), false) <> coalesce(($4::jsonb -> 'not') ? 'ghLocationId', false)) AS "m_ghLocationId",
      CASE WHEN (c.resume_url IS NOT NULL OR EXISTS (SELECT 1 FROM eureka.resume r WHERE r.candidate_id = c.id AND r.is_current)) THEN 'yes' ELSE 'no' END AS "v_resume",
      ($2::boolean IS NULL OR $2::boolean = (c.resume_url IS NOT NULL OR EXISTS (SELECT 1 FROM eureka.resume r WHERE r.candidate_id = c.id AND r.is_current))) AS "m_resume",
      CASE WHEN c.gh_remote THEN 'remote' WHEN c.gh_location_id IS NOT NULL THEN 'guest_house' END AS "v_stay",
      ($3::text IS NULL OR ($3::text = 'remote' AND c.gh_remote) OR ($3::text = 'guest_house' AND c.gh_location_id IS NOT NULL)) AS "m_stay",
      CASE c.in_person_ok WHEN true THEN 'yes' WHEN false THEN 'no' END AS "v_inPerson",
      ($4::jsonb ->> 'inPerson' IS NULL OR c.in_person_ok IS NOT DISTINCT FROM ($4::jsonb ->> 'inPerson' = 'yes')) AS "m_inPerson"
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    WHERE (SELECT authz.hotlist_open())
      AND c.marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped')
      AND ($1::text IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE $1::text ESCAPE '\')
  )
  SELECT 'status'::text, m."v_status", count(*) FROM m WHERE m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_status" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'technology'::text, m."v_technology", count(*) FROM m WHERE m."m_status" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_technology" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'visibility'::text, m."v_visibility", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_visibility" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'locationId'::text, m."v_locationId", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_locationId" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'visa'::text, m."v_visa", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_visa" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'documents'::text, m."v_documents", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_documents" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'priority'::text, m."v_priority", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_priority" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'teamId'::text, m."v_teamId", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_teamId" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'recruiterId'::text, m."v_recruiterId", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_recruiterId" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'ghLocationId'::text, m."v_ghLocationId", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson" AND m."v_ghLocationId" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'resume'::text, m."v_resume", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_stay" AND m."m_inPerson" AND m."v_resume" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'stay'::text, m."v_stay", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_inPerson" AND m."v_stay" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT 'inPerson'::text, m."v_inPerson", count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."v_inPerson" IS NOT NULL GROUP BY 2
  UNION ALL
  SELECT '_total'::text, NULL::text, count(*) FROM m WHERE m."m_status" AND m."m_technology" AND m."m_visibility" AND m."m_locationId" AND m."m_visa" AND m."m_documents" AND m."m_priority" AND m."m_teamId" AND m."m_recruiterId" AND m."m_ghLocationId" AND m."m_resume" AND m."m_stay" AND m."m_inPerson"
  $q$ USING p_search, p_resume, p_stay, p_more;
END
$function$;

REVOKE ALL ON FUNCTION authz.hotlist_facets(text, boolean, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_facets(text, boolean, text, jsonb) TO eureka_app;
RESET ROLE;
