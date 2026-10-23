-- Candidate profile fields, company links and Hot List filters (Eureka App 4
-- spec, gap list "Candidate/Hot List"; docs/candidates-api.md).
--
-- 1. New candidate columns:
--    profile (candidate:update, like the other profile fields): gh_remote (the
--      "Remote" stay option next to gh_location_id), marketing_locations,
--      linkedin_url, resume_url, eligibility, visa_category (the visa the
--      candidate is marketed on; the work-authorization record stays restricted);
--    compliance (candidate.compliance:update, only through
--      authz.set_candidate_compliance): everify_company_id,
--      offer_letter_company_id, form1099_company_id, documents_status;
--    server-managed: team_assigned_at (date added to the current team).
-- 2. eureka.candidate_profile_guard: a separate BEFORE INSERT OR UPDATE
--    trigger for these columns (candidate_column_guard is left untouched).
-- 3. authz.hotlist_page and authz.hotlist_export take the new Hot List
--    filters (location, visa, documents, resume, stay) as bound parameters with
--    NULL defaults, and return the new list columns.
-- 4. Definer readers: authz.candidate_companies (names of the linked
--    companies), authz.compliance_company_options (picker),
--    authz.resume_candidate_ids / authz.resume_flags (the "has a resume" filter
--    and column; uploaded resumes are under document:read, the flag is not).
-- 5. Technologies from the spec list are added to databases that already hold
--    technologies (a fresh database is seeded by the seed scripts instead).
-- Every IF is NULL-safe (rule 1); every function pins search_path and is
-- revoked from PUBLIC (rule 2).
SET search_path = eureka, public;

-- =====================================================================
-- 1. columns
-- =====================================================================
SET ROLE eureka_owner;

ALTER TABLE eureka.candidate
  ADD COLUMN gh_remote boolean NOT NULL DEFAULT false,
  ADD COLUMN marketing_locations text[] CONSTRAINT candidate_marketing_locations CHECK (
    cardinality(marketing_locations) BETWEEN 1 AND 5
    AND array_position(marketing_locations, NULL) IS NULL
    AND NOT ('' = ANY (marketing_locations))
    AND char_length(array_to_string(marketing_locations, '|')) <= 400
    AND array_to_string(marketing_locations, '|') !~ '[[:cntrl:]]'),
  ADD COLUMN linkedin_url text CONSTRAINT candidate_linkedin_url CHECK (
    char_length(linkedin_url) <= 300
    AND linkedin_url ~ '^https://([a-z]{2,3}\.)?linkedin\.com/[^[:space:][:cntrl:]]+$'),
  ADD COLUMN resume_url text CONSTRAINT candidate_resume_url CHECK (
    char_length(resume_url) <= 500 AND resume_url ~ '^https://[^[:space:][:cntrl:]]+$'),
  ADD COLUMN eligibility text[] CONSTRAINT candidate_eligibility CHECK (
    cardinality(eligibility) >= 1
    AND array_position(eligibility, NULL) IS NULL
    AND eligibility <@ ARRAY['in_person', 'hybrid', 'remote', 'relocation', 'travel']::text[]),
  ADD COLUMN visa_category text CONSTRAINT candidate_visa_category CHECK (visa_category IN (
    'us_citizen', 'green_card', 'gc_ead', 'h1b', 'h4_ead', 'l2_ead', 'f1_opt', 'f1_stem_opt', 'f1_cpt',
    'tn', 'o1', 'other')),
  ADD COLUMN documents_status text CONSTRAINT candidate_documents_status CHECK (
    documents_status IN ('pending', 'partial', 'complete')),
  ADD COLUMN everify_company_id uuid REFERENCES eureka.company(id),
  ADD COLUMN offer_letter_company_id uuid REFERENCES eureka.company(id),
  ADD COLUMN form1099_company_id uuid REFERENCES eureka.company(id),
  ADD COLUMN team_assigned_at timestamptz,
  -- Guest house or remote, never both.
  ADD CONSTRAINT candidate_stay CHECK (NOT gh_remote OR gh_location_id IS NULL);

-- Backfill team_assigned_at: the first assignment to the current team after the
-- last assignment to another team (candidate_event, 0026), else the creation
-- time. Run as the owner through two policies that exist only inside this
-- transaction, so it works where the migration user does not bypass RLS (RDS).
CREATE POLICY m0140_event_read ON eureka.candidate_event FOR SELECT TO eureka_owner USING (true);
CREATE POLICY m0140_backfill ON eureka.candidate FOR UPDATE TO eureka_owner USING (true) WITH CHECK (true);
UPDATE eureka.candidate c SET team_assigned_at = coalesce((
  SELECT min(e.at) FROM eureka.candidate_event e
  WHERE e.candidate_id = c.id AND e.type = 'candidate.assigned' AND e.ref_id = c.team_id
    AND e.at > coalesce((SELECT max(o.at) FROM eureka.candidate_event o
                         WHERE o.candidate_id = c.id AND o.type = 'candidate.assigned'
                           AND o.ref_id IS DISTINCT FROM c.team_id), '-infinity'::timestamptz)
), c.created_at);
DROP POLICY m0140_backfill ON eureka.candidate;
DROP POLICY m0140_event_read ON eureka.candidate_event;
ALTER TABLE eureka.candidate
  ALTER COLUMN team_assigned_at SET DEFAULT now(),
  ALTER COLUMN team_assigned_at SET NOT NULL;

-- =====================================================================
-- 2. column guard for the new columns
-- =====================================================================
CREATE FUNCTION eureka.candidate_profile_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  is_definer boolean := current_user = 'authz_definer';
  -- The API, the worker and definer code (import commit): never superuser seeds or migrations.
  is_service boolean := current_user IN ('eureka_app', 'eureka_worker', 'authz_definer');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF is_service THEN
      IF NEW.everify_company_id IS NOT NULL OR NEW.offer_letter_company_id IS NOT NULL
         OR NEW.form1099_company_id IS NOT NULL OR NEW.documents_status IS NOT NULL THEN
        RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.team_assigned_at := pg_catalog.now();
    ELSE
      NEW.team_assigned_at := coalesce(NEW.team_assigned_at, pg_catalog.now());
    END IF;
    RETURN NEW;
  END IF;

  -- Date added to team: set by the server whenever the team changes, never by a client.
  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    NEW.team_assigned_at := pg_catalog.now();
  ELSIF NEW.team_assigned_at IS DISTINCT FROM OLD.team_assigned_at AND is_service THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Compliance fields: only inside authz.set_candidate_compliance (rule 6).
  IF (NEW.everify_company_id, NEW.offer_letter_company_id, NEW.form1099_company_id, NEW.documents_status)
     IS DISTINCT FROM
     (OLD.everify_company_id, OLD.offer_letter_company_id, OLD.form1099_company_id, OLD.documents_status)
     AND is_service AND NOT is_definer THEN
    RAISE EXCEPTION 'compliance fields change only through authz.set_candidate_compliance'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Profile fields: candidate:update over the candidate, like candidate_column_guard's list.
  IF (NEW.gh_remote, NEW.marketing_locations, NEW.linkedin_url, NEW.resume_url, NEW.eligibility, NEW.visa_category)
     IS DISTINCT FROM
     (OLD.gh_remote, OLD.marketing_locations, OLD.linkedin_url, OLD.resume_url, OLD.eligibility, OLD.visa_category)
     AND is_service AND NOT is_definer
     AND NOT authz.owns('candidate:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update profile fields' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eureka.candidate_profile_guard() FROM PUBLIC;
CREATE TRIGGER candidate_profile_guard BEFORE INSERT OR UPDATE ON eureka.candidate
  FOR EACH ROW EXECUTE FUNCTION eureka.candidate_profile_guard();

RESET ROLE;

GRANT UPDATE (everify_company_id, offer_letter_company_id, form1099_company_id, documents_status)
  ON eureka.candidate TO authz_definer;

-- =====================================================================
-- 3. definer functions
-- =====================================================================
SET ROLE authz_definer;

-- Company links and documents status (candidate.compliance:update over the
-- candidate). A link that changes must name an active company; an unchanged
-- link may keep a company that has since become inactive. Returns the new row_version.
CREATE FUNCTION authz.set_candidate_compliance(
  p_candidate uuid, p_everify uuid, p_offer_letter uuid, p_form1099 uuid, p_documents text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c record;
  v integer;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.recruiter_id, x.team_id, x.location_id, x.everify_company_id, x.offer_letter_company_id, x.form1099_company_id
    INTO c FROM eureka.candidate x WHERE x.id = p_candidate FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'candidate_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('candidate.compliance:update', c.recruiter_id, c.team_id, c.location_id), false) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_everify IS NOT NULL AND p_everify IS DISTINCT FROM c.everify_company_id
      AND NOT EXISTS (SELECT 1 FROM eureka.company k WHERE k.id = p_everify AND k.status = 'active'))
     OR (p_offer_letter IS NOT NULL AND p_offer_letter IS DISTINCT FROM c.offer_letter_company_id
      AND NOT EXISTS (SELECT 1 FROM eureka.company k WHERE k.id = p_offer_letter AND k.status = 'active'))
     OR (p_form1099 IS NOT NULL AND p_form1099 IS DISTINCT FROM c.form1099_company_id
      AND NOT EXISTS (SELECT 1 FROM eureka.company k WHERE k.id = p_form1099 AND k.status = 'active')) THEN
    RAISE EXCEPTION 'invalid_company' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.candidate SET everify_company_id = p_everify, offer_letter_company_id = p_offer_letter,
         form1099_company_id = p_form1099, documents_status = p_documents
   WHERE id = p_candidate RETURNING row_version INTO v;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION authz.set_candidate_compliance(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_candidate_compliance(uuid, uuid, uuid, uuid, text) TO eureka_app;

-- Names of a candidate's linked companies, for callers who own the candidate
-- under candidate:read (not through Open to all teams) or hold
-- candidate.compliance:update over it. Company rows themselves stay under company:read.
CREATE FUNCTION authz.candidate_companies(p_candidate uuid)
RETURNS TABLE (link text, company_id uuid, company_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.link, k.id, k.name
  FROM eureka.candidate c
  CROSS JOIN LATERAL (VALUES ('everify', c.everify_company_id), ('offerLetter', c.offer_letter_company_id),
                             ('form1099', c.form1099_company_id)) AS l(link, cid)
  JOIN eureka.company k ON k.id = l.cid
  WHERE c.id = p_candidate
    AND (authz.owns('candidate:read', c.recruiter_id, c.team_id, c.location_id)
         OR authz.owns('candidate.compliance:update', c.recruiter_id, c.team_id, c.location_id))
$$;
REVOKE ALL ON FUNCTION authz.candidate_companies(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.candidate_companies(uuid) TO eureka_app;

-- Active companies for the compliance picker (candidate.compliance:update holders only).
CREATE FUNCTION authz.compliance_company_options()
RETURNS TABLE (id uuid, name text, location_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.id, k.name, l.name
  FROM eureka.company k JOIN eureka.location l ON l.id = k.location_id
  WHERE k.status = 'active' AND (SELECT authz.has_perm('candidate.compliance:update'))
  ORDER BY lower(k.name), k.id
$$;
REVOKE ALL ON FUNCTION authz.compliance_company_options() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.compliance_company_options() TO eureka_app;

-- Candidates with a current (clean) uploaded resume, for the Hot List "resume"
-- filter: ids only, to callers who hold hotlist:read or candidate:read. Used as
-- `c.id IN (SELECT unnest((SELECT authz.resume_candidate_ids())))` (rule 3).
CREATE FUNCTION authz.resume_candidate_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN coalesce(authz.has_perm('hotlist:read') OR authz.has_perm('candidate:read'), false)
    THEN (SELECT coalesce(pg_catalog.array_agg(r.candidate_id), '{}') FROM eureka.resume r WHERE r.is_current)
    ELSE '{}'::uuid[] END
$$;
REVOKE ALL ON FUNCTION authz.resume_candidate_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.resume_candidate_ids() TO eureka_app;

-- The subset of p_ids with a current uploaded resume (the Hot List page's resume column).
CREATE FUNCTION authz.resume_flags(p_ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN coalesce(authz.has_perm('hotlist:read') OR authz.has_perm('candidate:read'), false)
    THEN (SELECT coalesce(pg_catalog.array_agg(r.candidate_id), '{}') FROM eureka.resume r
          WHERE r.is_current AND r.candidate_id = ANY (p_ids))
    ELSE '{}'::uuid[] END
$$;
REVOKE ALL ON FUNCTION authz.resume_flags(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.resume_flags(uuid[]) TO eureka_app;

-- ---------- Hot List page (0034) with the new filters and columns ----------
DROP FUNCTION authz.hotlist_page(text, text, text, text, uuid, int);
CREATE FUNCTION authz.hotlist_page(
  p_status text, p_technology text, p_visibility text, p_search text, p_cursor uuid, p_limit int,
  p_location uuid DEFAULT NULL, p_visa text DEFAULT NULL, p_documents text DEFAULT NULL,
  p_resume boolean DEFAULT NULL, p_stay text DEFAULT NULL)
RETURNS TABLE (
  id uuid, first_name text, last_name text, technology text,
  team_id uuid, team_name text, recruiter_id uuid, recruiter_name text,
  location_id uuid, location_name text, visibility text, marketing_status text, priority text,
  marketing_start_date text, technical_rating smallint, phone text, phone_masked boolean, readable boolean,
  visa_category text, documents_status text, gh_remote boolean, gh_location_name text, has_resume boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
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
$fn$;
REVOKE ALL ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, int, uuid, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_page(text, text, text, text, uuid, int, uuid, text, text, boolean, text) TO eureka_app;

-- ---------- Hot List export (0038) with the new filters and columns ----------
DROP FUNCTION authz.hotlist_export(text, text, text, text, int);
CREATE FUNCTION authz.hotlist_export(
  p_status text, p_technology text, p_visibility text, p_search text, p_limit int,
  p_location uuid DEFAULT NULL, p_visa text DEFAULT NULL, p_documents text DEFAULT NULL,
  p_resume boolean DEFAULT NULL, p_stay text DEFAULT NULL)
RETURNS TABLE (
  id uuid, first_name text, last_name text, technology text,
  team_name text, recruiter_name text, location_name text, visibility text, marketing_status text,
  priority text, marketing_start_date text, technical_rating smallint, phone text,
  visa_category text, documents_status text, gh_remote boolean, gh_location_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  -- Same query as 0038; $6..$10 = p_location, p_visa, p_documents ('none' = not recorded), p_resume, p_stay.
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
$fn$;
REVOKE ALL ON FUNCTION authz.hotlist_export(text, text, text, text, int, uuid, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_export(text, text, text, text, int, uuid, text, text, boolean, text) TO eureka_app;

RESET ROLE;

-- =====================================================================
-- 5. technologies (spec list), only where technologies already exist
-- =====================================================================
SET ROLE eureka_owner;
INSERT INTO eureka.technology (name)
SELECT v.name FROM (VALUES ('Java'), ('DE/PY'), ('Python Developer'), ('.Net'), ('DevOps'), ('AI/ML'), ('Networking'),
  ('Service Now'), ('Business Analyst'), ('Others'), ('Data Science'), ('PY AI'), ('Salesforce Administrator'),
  ('Python Full Stack')) AS v(name)
WHERE EXISTS (SELECT 1 FROM eureka.technology)
  AND NOT EXISTS (SELECT 1 FROM eureka.technology t WHERE lower(t.name) = lower(v.name));
RESET ROLE;
