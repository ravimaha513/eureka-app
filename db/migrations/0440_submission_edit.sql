-- Editing a submission's details (docs/submissions-api.md, "Editing details").
--
--   1. submission.details:update (lead: team, manager / associate director: hierarchy,
--      CEO: org) corrects job title, client, vendor, rate, job link and submitted time
--      through authz.edit_submission (db/functions/authz/). Status keeps its own state
--      machine (authz.transition_submission); recruiters keep submission:update for it.
--   2. details_edited_at / details_edited_by record the latest correction so the
--      submission shows it was edited, and by whom. Server-managed: only the definer
--      writes them, and eureka.submission_insert_guard (now in db/functions/eureka/)
--      refuses them on insert (rule 4).
--   3. authz_definer may update exactly the editable columns plus the two stamps.
--      Value limits (title 1-160, rate 0-1000) are checked by the function, so imported
--      rows outside them can still have their other fields corrected.
SET search_path = eureka, public;

SET ROLE eureka_owner;
ALTER TABLE eureka.submission
  ADD COLUMN details_edited_at timestamptz,
  ADD COLUMN details_edited_by uuid REFERENCES eureka.app_user(id);
RESET ROLE;

GRANT UPDATE (job_title, client_id, vendor_id, rate, job_id, submitted_at, details_edited_at, details_edited_by)
  ON eureka.submission TO authz_definer;
-- The function checks that a new vendor exists (client is granted since 0089).
GRANT SELECT ON eureka.vendor TO authz_definer;
