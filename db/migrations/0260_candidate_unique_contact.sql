-- Candidate contact uniqueness (docs/candidates-api.md CA-6).
--
-- A candidate's personal email and phone each identify one candidate: a new
-- candidate, or a candidate's person changing either value, is refused when
-- another candidate's person already has it. The API's duplicate check
-- (authz.candidate_duplicates) gives the friendly 409 first; this trigger is
-- the race-safe backstop for every writer (API, imports, hire from portal).
--   * Email compares case-insensitively (person_email_lower index, 0026);
--     phone compares the stored E.164 (person_phone index, 0026).
--   * A transaction-scoped advisory lock per value serializes two concurrent
--     creates of the same contact, so the second sees the first once it commits.
--   * Existing duplicates are left alone (no unique index): only new
--     candidates and contact changes are checked.
--   * Persons without a candidate (employees only) are not checked.
-- Raises duplicate_email / duplicate_phone (unique_violation).
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

  IF em IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('candidate_email:' || em, 0));
    IF EXISTS (SELECT 1 FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
                WHERE p.personal_email IS NOT NULL AND pg_catalog.lower(p.personal_email::text) = em AND p.id <> pid) THEN
      RAISE EXCEPTION 'duplicate_email' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  IF ph IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('candidate_phone:' || ph, 0));
    IF EXISTS (SELECT 1 FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
                WHERE p.phone_e164 IS NOT NULL AND p.phone_e164 = ph AND p.id <> pid) THEN
      RAISE EXCEPTION 'duplicate_phone' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.candidate_contact_unique() FROM PUBLIC;
-- The trigger owner needs EXECUTE to create the triggers below (as non-superuser, rule 7).
GRANT EXECUTE ON FUNCTION authz.candidate_contact_unique() TO eureka_owner;

RESET ROLE;

SET ROLE eureka_owner;
CREATE TRIGGER candidate_contact_unique BEFORE INSERT ON eureka.candidate
  FOR EACH ROW EXECUTE FUNCTION authz.candidate_contact_unique();
CREATE TRIGGER person_contact_unique BEFORE UPDATE OF personal_email, phone_e164 ON eureka.person
  FOR EACH ROW EXECUTE FUNCTION authz.candidate_contact_unique();
RESET ROLE;
