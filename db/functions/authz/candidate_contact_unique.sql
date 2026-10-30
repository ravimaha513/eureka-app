-- authz.candidate_contact_unique: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0260 and 0300 (0300 took one lock per transaction).
-- Change this file, not a new migration.
--
-- Candidate contact uniqueness (docs/candidates-api.md CA-6): a new candidate, or a
-- candidate's person changing personal email or phone, is refused when another
-- candidate's person already has that value. Trigger on eureka.candidate (BEFORE INSERT)
-- and eureka.person (BEFORE UPDATE OF personal_email, phone_e164), created in 0260.
--   * Race safety: one transaction-scoped advisory lock serializes concurrent writers, so the
--     second sees the first once it commits. One lock per transaction (not per value) keeps a
--     bulk insert from exhausting max_locks_per_transaction (0260 did that; 0300 fixed it).
--   * Existing duplicates are left alone (no unique index); persons without a candidate
--     (employees only) are not checked.
-- Raises duplicate_email / duplicate_phone (unique_violation).

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.candidate_contact_unique()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('eureka.candidate_contact', 0));

  IF em IS NOT NULL AND EXISTS (SELECT 1 FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
              WHERE p.personal_email IS NOT NULL AND pg_catalog.lower(p.personal_email::text) = em AND p.id <> pid) THEN
    RAISE EXCEPTION 'duplicate_email' USING ERRCODE = 'unique_violation';
  END IF;
  IF ph IS NOT NULL AND EXISTS (SELECT 1 FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
              WHERE p.phone_e164 IS NOT NULL AND p.phone_e164 = ph AND p.id <> pid) THEN
    RAISE EXCEPTION 'duplicate_phone' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION authz.candidate_contact_unique() FROM PUBLIC;
-- Owner of the triggers that call it (0260).
GRANT EXECUTE ON FUNCTION authz.candidate_contact_unique() TO eureka_owner;
RESET ROLE;
