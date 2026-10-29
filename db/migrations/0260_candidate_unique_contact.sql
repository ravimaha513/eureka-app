-- Candidate contact uniqueness (docs/candidates-api.md CA-6).
--
-- A candidate's personal email and phone each identify one candidate: a new
-- candidate, or a candidate's person changing either value, is refused when
-- another candidate's person already has it. The API's duplicate check
-- (authz.candidate_duplicates) gives the friendly 409 first; this trigger is
-- the race-safe backstop for every writer (API, imports, hire from portal).
--   * Email compares case-insensitively (person_email_lower index, 0026);
--     phone compares the stored E.164 (person_phone index, 0026).
--   * One transaction-scoped advisory lock serializes candidate creates and
--     contact changes, so the second of two racing writers sees the first once
--     it commits. One key, not one per value: a bulk insert (load seed,
--     import) would otherwise exhaust the lock table. Candidate creates are
--     rare enough for this.
--   * Existing duplicates are left alone (no unique index): only new
--     candidates and contact changes are checked.
--   * Persons without a candidate (employees only) are not checked.
-- Raises duplicate_email / duplicate_phone (unique_violation).
--
-- Recruiters lose candidate:create (lead or above adds candidates; catalog).
-- The import loader writes as each row's owner, often a recruiter, after an
-- operator approved the batch: its person / candidate policies (0041) now also
-- accept the owner's own candidate:update in their own team, the rule the
-- recruiter "own" create grant gave before.
SET search_path = eureka, public;

SET ROLE authz_definer;

CREATE FUNCTION authz.candidate_contact_unique() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  pid uuid;
  em  text;
  ph  text;
BEGIN
  IF TG_TABLE_NAME = 'candidate' THEN
    pid := NEW.person_id;
    SELECT pg_catalog.lower(p.personal_email::text), p.phone_e164 INTO em, ph FROM eureka.person p WHERE p.id = pid;
  ELSE
    pid := NEW.id;
    -- Only a person that is a candidate, and only the values that changed.
    IF NOT EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.person_id = pid) THEN RETURN NEW; END IF;
    IF NEW.personal_email IS DISTINCT FROM OLD.personal_email THEN em := pg_catalog.lower(NEW.personal_email::text); END IF;
    IF NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164 THEN ph := NEW.phone_e164; END IF;
  END IF;
  em := nullif(pg_catalog.btrim(em), '');
  ph := nullif(pg_catalog.btrim(ph), '');
  IF em IS NULL AND ph IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('eureka.candidate_contact', 0));

  IF em IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
                WHERE p.personal_email IS NOT NULL AND pg_catalog.lower(p.personal_email::text) = em AND p.id <> pid) THEN
      RAISE EXCEPTION 'duplicate_email' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  IF ph IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
                WHERE p.phone_e164 IS NOT NULL AND p.phone_e164 = ph AND p.id <> pid) THEN
      RAISE EXCEPTION 'duplicate_phone' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

RESET ROLE;

-- Created before the REVOKE, as in 0026: CREATE TRIGGER needs EXECUTE.
CREATE TRIGGER candidate_contact_unique BEFORE INSERT ON eureka.candidate
  FOR EACH ROW EXECUTE FUNCTION authz.candidate_contact_unique();
CREATE TRIGGER person_contact_unique BEFORE UPDATE OF personal_email, phone_e164 ON eureka.person
  FOR EACH ROW EXECUTE FUNCTION authz.candidate_contact_unique();

REVOKE ALL ON FUNCTION authz.candidate_contact_unique() FROM PUBLIC;

-- ---------- import loader: owners keep loading their own candidates ----------
DROP POLICY import_load_insert ON eureka.person;
DROP POLICY import_load_insert ON eureka.candidate;
CREATE POLICY import_load_insert ON eureka.person FOR INSERT TO authz_definer WITH CHECK (
  (SELECT authz.import_active())
  AND ((SELECT authz.has_perm('candidate:create')) OR (SELECT authz.has_perm('candidate:update'))));
CREATE POLICY import_load_insert ON eureka.candidate FOR INSERT TO authz_definer WITH CHECK (
  (SELECT authz.import_active())
  AND ((SELECT authz.has_org('candidate:create'))
       OR team_id = ANY ((SELECT authz.team_ids('candidate:create'))::uuid[])
       OR (recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:create'))::uuid[])
           AND team_id = (SELECT authz.actor_team()))
       OR (recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:update'))::uuid[])
           AND team_id = (SELECT authz.actor_team()))));
