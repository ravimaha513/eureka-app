-- Applicant notices go through a durable queue (design A7) instead of a fire-and-forget send after
-- commit, which lost the email when the API crashed or was drained between the commit and the send.
--
--   1. eureka.applicant_notice: one row per email owed to an applicant, written in the same
--      transaction as the change it reports, by authz.application_transition ('status', with the new
--      status) and authz.application_schedule_interview ('interview', with the interview). Rows hold
--      ids and a status only; the address, job title and interview details are read at send time,
--      and staff comments are never part of a notice (rule 5).
--   2. The API sends due notices (db/functions/authz/applicant_notice_claim.sql): right after the
--      commit, and every minute for retries. A claim pushes next_attempt_at forward (the lease), so
--      concurrent API tasks never send the same notice at once; a send that dies before
--      applicant_notice_sent is retried after the lease (at least once). Backoff doubles from one
--      minute; after 8 attempts the notice is 'failed'. Notices older than 30 days are removed.
--   3. Only authz_definer reads or writes the table; the app reaches it through the functions.
-- Every IF is NULL-safe (rule 1).
SET search_path = eureka, public;

SET ROLE eureka_owner;
CREATE TABLE eureka.applicant_notice (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES eureka.job_application(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('status', 'interview')),
  to_status       text CHECK ((kind = 'status') = (to_status IS NOT NULL)),
  interview_id    uuid REFERENCES eureka.application_interview(id) ON DELETE CASCADE
                  CHECK ((kind = 'interview') = (interview_id IS NOT NULL)),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX applicant_notice_due ON eureka.applicant_notice (next_attempt_at) WHERE status = 'pending';
CREATE INDEX applicant_notice_created ON eureka.applicant_notice (created_at);

ALTER TABLE eureka.applicant_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.applicant_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_read   ON eureka.applicant_notice FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.applicant_notice FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.applicant_notice FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.applicant_notice FOR DELETE TO authz_definer USING (true);
RESET ROLE;

REVOKE ALL ON eureka.applicant_notice FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON eureka.applicant_notice TO authz_definer;
