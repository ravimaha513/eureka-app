-- Deleting a candidate with everything recorded about them (docs/candidates-api.md,
-- "Deleting a candidate").
--   authz.delete_candidate (db/functions/authz/) checks candidate:delete on the candidate
--   (lead: team, manager / associate director: hierarchy, CEO: org), refuses a candidate
--   with a placement or an employee record (contracts, invoices and payments hang off
--   those and are never deleted), then hard-deletes the candidate's submissions,
--   interviews (panel, feedback, calendar blocks), assessments, applications, resumes,
--   documents and their files, paperwork, training progress, events, team shares,
--   notifications, import ledger rows, and the person with their work authorizations
--   when no other candidate shares them. audit_event keeps the ids only (rule 5).
-- Most of these tables are append-only or never-delete by their guard triggers. The
-- guards (db/functions/eureka/) let authz_definer delete while a candidate delete is
-- running: a row in eureka.candidate_purge keyed by the current transaction and backend,
-- written only by authz_definer (the eureka.import_session pattern, migration 0041), so a
-- client-settable setting cannot open them. The delete policies below check the same.
SET search_path = eureka, public;

SET ROLE eureka_owner;
CREATE TABLE eureka.candidate_purge (
  xact         xid8 NOT NULL,
  pid          integer NOT NULL,
  candidate_id uuid NOT NULL,
  PRIMARY KEY (xact, pid)
);
ALTER TABLE eureka.candidate_purge ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.candidate_purge FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON eureka.candidate_purge FOR ALL TO authz_definer USING (true) WITH CHECK (true);
RESET ROLE;
GRANT SELECT, INSERT, DELETE ON eureka.candidate_purge TO authz_definer;

SET ROLE authz_definer;
CREATE FUNCTION authz.candidate_purging() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM eureka.candidate_purge p
                 WHERE p.xact = pg_catalog.pg_current_xact_id_if_assigned() AND p.pid = pg_catalog.pg_backend_pid())
$$;
REVOKE ALL ON FUNCTION authz.candidate_purging() FROM PUBLIC;
RESET ROLE;

-- Read and delete every table of the candidate's subtree while a delete runs.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'notification', 'feedback_notification', 'feedback_delivery', 'interview_feedback', 'interview_panelist',
    'calendar_block', 'assessment', 'interview', 'submission',
    'application_scorecard', 'application_interview_panel', 'application_interview', 'application_event', 'job_application',
    'checklist_item_event', 'checklist_item', 'bgc_event', 'bgc', 'document_access', 'document', 'file_object', 'resume',
    'module_progress', 'candidate_event', 'candidate_nonresponse', 'candidate_team_share',
    'import_identity', 'import_link', 'import_natural_key',
    'candidate', 'work_authorization_notice', 'work_authorization', 'person']
  LOOP
    EXECUTE format('SET ROLE eureka_owner');
    EXECUTE format('CREATE POLICY candidate_purge_read ON eureka.%I FOR SELECT TO authz_definer USING ((SELECT authz.candidate_purging()))', t);
    EXECUTE format('CREATE POLICY candidate_purge_delete ON eureka.%I FOR DELETE TO authz_definer USING ((SELECT authz.candidate_purging()))', t);
    EXECUTE format('RESET ROLE');
    EXECUTE format('GRANT SELECT, DELETE ON eureka.%I TO authz_definer', t);
  END LOOP;
END $$;
