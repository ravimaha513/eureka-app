-- Adding candidates: lead or above, contact required and unique (docs/candidates-api.md CA-6).
-- Follows 0260 (candidate contact uniqueness trigger).
--
--   1. authz.candidate_contact_unique takes one transaction-scoped advisory
--      lock instead of one per email / phone. One per value exhausted the lock
--      table on a bulk insert (load seed, imports: 50,000 rows is "out of
--      shared memory"). The single key still serializes racing creates and
--      contact changes, so the second writer sees the first once it commits;
--      candidate creates are rare enough for this.
--   2. Recruiters lose candidate:create (catalog). The import loader writes as
--      each row's owner, often a recruiter, after an operator approved the
--      batch: its person / candidate insert policies (0041) also accept the
--      owner's own candidate:update in their own team, the rule the recruiter
--      "own" create grant gave before.
SET search_path = eureka, public;

-- ---------- 1. one lock per transaction ----------
SET ROLE authz_definer;

-- CREATE OR REPLACE keeps the grants from 0260 (EXECUTE to eureka_owner only).
CREATE OR REPLACE FUNCTION authz.candidate_contact_unique() RETURNS trigger
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

  IF em IS NOT NULL AND EXISTS (SELECT 1 FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
      WHERE p.personal_email IS NOT NULL AND pg_catalog.lower(p.personal_email::text) = em AND p.id <> pid) THEN
    RAISE EXCEPTION 'duplicate_email' USING ERRCODE = 'unique_violation';
  END IF;
  IF ph IS NOT NULL AND EXISTS (SELECT 1 FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
      WHERE p.phone_e164 IS NOT NULL AND p.phone_e164 = ph AND p.id <> pid) THEN
    RAISE EXCEPTION 'duplicate_phone' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;

RESET ROLE;

-- ---------- 2. import loader: owners keep loading their own candidates ----------
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
