-- Candidates: bulk-import contact budget, set-based contact check, optional If-Match
-- (docs/candidates-api.md "Bulk add to a batch", "Optimistic concurrency"; audit R-15 / A-01, A-07, R-10 / A-02).
--
--   1. eureka.bulk_candidate_budget: rows each user had checked against existing
--      candidates' contacts today (UTC). POST /batches/:id/candidates/bulk answers
--      "is this email / phone taken?" for up to 500 rows a call, preview included,
--      so its rows are charged to a per-user daily budget held in the database
--      (the per-minute limiter is in memory, per API task). Counts only, no
--      contact values (rule 5). Written only by authz.bulk_candidate_budget_take.
--   2. authz.candidate_contacts_taken: which of the given emails / phones an
--      existing candidate already has, the authz.candidate_contact_unique (0260,
--      0300) rule set-based. Takes the same transaction-scoped advisory lock first,
--      so the answer holds until the caller's transaction ends; the trigger stays
--      the backstop on insert.
--   3. authz.candidate_version_lock: locks a candidate the caller may write and
--      returns its row_version, so the API can compare an If-Match header for
--      writes that go through definer functions (compliance, visibility,
--      transition) without a lost-update window.

-- ---------- 1. budget table ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.bulk_candidate_budget (
  user_id uuid    NOT NULL,
  day     date    NOT NULL,
  rows_checked integer NOT NULL DEFAULT 0 CHECK (rows_checked >= 0),
  PRIMARY KEY (user_id, day)
);
ALTER TABLE eureka.bulk_candidate_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.bulk_candidate_budget FORCE ROW LEVEL SECURITY;
-- The definer below is the only writer and reader; eureka_app has no privilege on the table.
CREATE POLICY definer_all ON eureka.bulk_candidate_budget FOR ALL TO authz_definer USING (true) WITH CHECK (true);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON eureka.bulk_candidate_budget TO authz_definer;

SET ROLE authz_definer;

-- ---------- 1b. charge the budget ----------
-- Adds p_rows to the caller's count for today (UTC) unless that would pass
-- p_limit: then nothing is charged and 'bulk_budget_exceeded' is raised (429).
-- Returns the rows left today. Earlier days of the caller are dropped.
CREATE FUNCTION authz.bulk_candidate_budget_take(p_rows integer, p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  uid   uuid := authz.current_user_id();
  today date := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
  used  integer;
BEGIN
  IF uid IS NULL OR NOT coalesce(authz.has_perm('candidate:create'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_rows IS NULL OR p_rows < 0 OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'invalid_budget' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.bulk_candidate_budget b WHERE b.user_id = uid AND b.day < today;
  INSERT INTO eureka.bulk_candidate_budget (user_id, day, rows_checked) VALUES (uid, today, 0) ON CONFLICT DO NOTHING;
  SELECT b.rows_checked INTO used FROM eureka.bulk_candidate_budget b WHERE b.user_id = uid AND b.day = today FOR UPDATE;
  IF coalesce(used, 0) + p_rows > p_limit THEN
    RAISE EXCEPTION 'bulk_budget_exceeded' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.bulk_candidate_budget b SET rows_checked = b.rows_checked + p_rows WHERE b.user_id = uid AND b.day = today;
  RETURN p_limit - (coalesce(used, 0) + p_rows);
END $$;
REVOKE ALL ON FUNCTION authz.bulk_candidate_budget_take(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.bulk_candidate_budget_take(integer, integer) TO eureka_app;

-- ---------- 2. set-based contact check ----------
-- kind 'email' (lower-cased) or 'phone' (E.164), for each given value an existing
-- candidate's person has. Persons without a candidate (employees only) do not
-- count, as in the trigger. At most 500 values of each kind (one bulk call).
CREATE FUNCTION authz.candidate_contacts_taken(p_emails text[], p_phones text[])
RETURNS TABLE (kind text, value text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_perm('candidate:create'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(pg_catalog.cardinality(p_emails), 0) > 500 OR coalesce(pg_catalog.cardinality(p_phones), 0) > 500 THEN
    RAISE EXCEPTION 'too_many_values' USING ERRCODE = 'check_violation';
  END IF;
  -- The lock authz.candidate_contact_unique takes: no other writer adds or
  -- changes a candidate contact until this transaction ends.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('eureka.candidate_contact', 0));
  RETURN QUERY
    SELECT DISTINCT 'email'::text, pg_catalog.lower(p.personal_email::text)
      FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
     WHERE p.personal_email IS NOT NULL
       AND pg_catalog.lower(p.personal_email::text) IN (
             SELECT pg_catalog.lower(pg_catalog.btrim(e)) FROM pg_catalog.unnest(coalesce(p_emails, '{}')) e)
    UNION
    SELECT DISTINCT 'phone'::text, p.phone_e164
      FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
     WHERE p.phone_e164 IS NOT NULL
       AND p.phone_e164 IN (SELECT pg_catalog.btrim(x) FROM pg_catalog.unnest(coalesce(p_phones, '{}')) x);
END $$;
REVOKE ALL ON FUNCTION authz.candidate_contacts_taken(text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.candidate_contacts_taken(text[], text[]) TO eureka_app;

-- ---------- 3. version lock for If-Match ----------
-- 404 (no_data_found) when the candidate is not readable to the caller; 403 when
-- the caller holds none of the candidate write permissions over it.
CREATE FUNCTION authz.candidate_version_lock(p_candidate uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v integer;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.row_version INTO v FROM eureka.candidate c WHERE c.id = p_candidate FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_owned(p_candidate, 'candidate:update')
                  OR authz.candidate_owned(p_candidate, 'candidate:assign')
                  OR authz.candidate_owned(p_candidate, 'candidate.visibility:update')
                  OR authz.candidate_owned(p_candidate, 'candidate.rating:update')
                  OR authz.candidate_owned(p_candidate, 'candidate.compliance:update'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION authz.candidate_version_lock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.candidate_version_lock(uuid) TO eureka_app;

RESET ROLE;
