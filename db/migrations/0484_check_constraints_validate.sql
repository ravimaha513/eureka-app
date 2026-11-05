-- Database-side limits on core free text and contacts, and the CHECKs that were never validated
-- (R-28; docs/backend-audit/architecture.md G-09, G-10).
--
-- G-10: person names and emails, candidate marketing email and Vitel number, submission job title
-- and app_user display name / designation had no length or control-character CHECK, so only the
-- zod schemas limited them; a writer that bypasses those (the import definer, seeds, a future
-- endpoint) could store CSV / header injection or unbounded text. The limits are the API's:
-- names 1-80 (candidates.schemas CreateCandidate, import normalizeName, applicant 0061), emails
-- <= 254 in a one-@ shape with no space or control characters (Email / normalizeEmail), Vitel
-- number <= 20 (ProfileUpdate), job title 1-160 (submissions.service, edit_submission), display
-- name 1-120 and designation <= 120 (admin.schemas). A violation is 23514, i.e. 422 problem.
--
-- G-09: six CHECKs from 0017 / 0019 were added NOT VALID and never validated, so rows from before
-- them (a recording link without consent, a non-https link) were not guaranteed to comply and any
-- later UPDATE of such a row failed on an unrelated edit.
--
-- Each constraint is added NOT VALID (no long lock), then validated (SHARE UPDATE EXCLUSIVE: reads
-- and writes go on). A database whose existing rows violate one keeps that constraint NOT VALID,
-- with a WARNING naming it (no row data, rule 5): new and updated rows are checked either way. Fix
-- those rows and VALIDATE in a later migration; apps/api/test/db-lint.db.int.test.ts asserts every
-- CHECK is validated on a fresh database.

SET ROLE eureka_owner;

ALTER TABLE eureka.person
  ADD CONSTRAINT person_first_name_text CHECK (char_length(first_name) BETWEEN 1 AND 80 AND first_name !~ '[[:cntrl:]]') NOT VALID,
  ADD CONSTRAINT person_last_name_text CHECK (char_length(last_name) BETWEEN 1 AND 80 AND last_name !~ '[[:cntrl:]]') NOT VALID,
  ADD CONSTRAINT person_personal_email_shape CHECK (personal_email IS NULL OR (char_length(personal_email) <= 254
    AND personal_email::text ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$')) NOT VALID;

ALTER TABLE eureka.candidate
  ADD CONSTRAINT candidate_marketing_email_shape CHECK (marketing_email IS NULL OR (char_length(marketing_email) <= 254
    AND marketing_email::text ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$')) NOT VALID,
  ADD CONSTRAINT candidate_vitel_number_text CHECK (vitel_number IS NULL OR (char_length(vitel_number) <= 20
    AND vitel_number !~ '[[:cntrl:]]')) NOT VALID;

ALTER TABLE eureka.submission
  ADD CONSTRAINT submission_job_title_text CHECK (char_length(job_title) BETWEEN 1 AND 160 AND job_title !~ '[[:cntrl:]]') NOT VALID;

ALTER TABLE eureka.app_user
  ADD CONSTRAINT app_user_display_name_text CHECK (char_length(display_name) BETWEEN 1 AND 120 AND display_name !~ '[[:cntrl:]]') NOT VALID,
  ADD CONSTRAINT app_user_designation_text CHECK (designation IS NULL OR (char_length(designation) <= 120
    AND designation !~ '[[:cntrl:]]')) NOT VALID;

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT k.oid, k.conrelid::regclass AS tbl, k.conname
      FROM pg_catalog.pg_constraint k
     WHERE k.contype = 'c' AND NOT k.convalidated
       AND (k.conrelid, k.conname) IN (
         ('eureka.submission'::regclass, 'submission_rejection_reason'),
         ('eureka.submission'::regclass, 'submission_rejection_reason_len'),
         ('eureka.interview'::regclass, 'interview_recording_consent'),
         ('eureka.interview'::regclass, 'interview_links_https'),
         ('eureka.interview'::regclass, 'interview_duration'),
         ('eureka.interview'::regclass, 'interview_start_sane'),
         ('eureka.person'::regclass, 'person_first_name_text'),
         ('eureka.person'::regclass, 'person_last_name_text'),
         ('eureka.person'::regclass, 'person_personal_email_shape'),
         ('eureka.candidate'::regclass, 'candidate_marketing_email_shape'),
         ('eureka.candidate'::regclass, 'candidate_vitel_number_text'),
         ('eureka.submission'::regclass, 'submission_job_title_text'),
         ('eureka.app_user'::regclass, 'app_user_display_name_text'),
         ('eureka.app_user'::regclass, 'app_user_designation_text'))
     ORDER BY 2, 3
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tbl, c.conname);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING '0484: % on % stays NOT VALID: existing rows violate %', c.conname, c.tbl, pg_catalog.pg_get_constraintdef(c.oid)
        USING HINT = 'Fix the rows, then ALTER TABLE ... VALIDATE CONSTRAINT in a new migration (G-09/G-10).';
    END;
  END LOOP;
END $$;

RESET ROLE;
