-- authz.delete_candidate: current definition (repeatable; db/functions/README.md).
-- Hard-deletes a candidate and everything recorded about them (migration 0320,
-- docs/candidates-api.md "Deleting a candidate"). Refused while the candidate has a
-- placement or an employee record. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.delete_candidate(p_candidate uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  c record;
  v_subs uuid[]; v_ivs uuid[]; v_apps uuid[]; v_app_ivs uuid[]; v_docs uuid[]; v_files uuid[];
  v_items uuid[]; v_bgcs uuid[]; v_resumes uuid[]; v_was uuid[];
BEGIN
  SELECT * INTO c FROM eureka.candidate WHERE id = p_candidate FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(
       authz.owns('candidate:read', c.recruiter_id, c.team_id, c.location_id)
       OR (authz.all_teams('candidate:read') AND c.visibility = 'all_teams'
           AND c.marketing_status IN ('active','full_of_interviews'))
       OR c.id = ANY (authz.shared_candidate_ids('candidate:read')), false) THEN
    RAISE EXCEPTION 'candidate not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('candidate:delete', c.recruiter_id, c.team_id, c.location_id), false) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Contracts, invoices, payments and employment history hang off these: never deleted.
  IF EXISTS (SELECT 1 FROM eureka.placement p WHERE p.candidate_id = p_candidate)
     OR EXISTS (SELECT 1 FROM eureka.employee e WHERE e.candidate_id = p_candidate) THEN
    RAISE EXCEPTION 'candidate_placed' USING ERRCODE = 'check_violation';
  END IF;

  -- Opens the guard triggers and purge policies for this transaction only.
  INSERT INTO eureka.candidate_purge (xact, pid, candidate_id)
  VALUES (pg_catalog.pg_current_xact_id(), pg_catalog.pg_backend_pid(), p_candidate);

  v_subs := ARRAY(SELECT s.id FROM eureka.submission s WHERE s.candidate_id = p_candidate);
  v_ivs := ARRAY(SELECT i.id FROM eureka.interview i
                  WHERE i.candidate_id = p_candidate OR i.submission_id = ANY (v_subs));
  v_apps := ARRAY(SELECT a.id FROM eureka.job_application a WHERE a.candidate_id = p_candidate);
  v_app_ivs := ARRAY(SELECT ai.id FROM eureka.application_interview ai WHERE ai.application_id = ANY (v_apps));
  v_docs := ARRAY(SELECT d.id FROM eureka.document d WHERE d.candidate_id = p_candidate);
  v_files := ARRAY(SELECT d.file_id FROM eureka.document d WHERE d.id = ANY (v_docs) AND d.file_id IS NOT NULL);
  v_items := ARRAY(SELECT ci.id FROM eureka.checklist_item ci WHERE ci.candidate_id = p_candidate);
  v_bgcs := ARRAY(SELECT b.id FROM eureka.bgc b WHERE b.candidate_id = p_candidate);
  v_resumes := ARRAY(SELECT r.id FROM eureka.resume r WHERE r.candidate_id = p_candidate);

  DELETE FROM eureka.notification n
   WHERE (n.entity_type = 'candidate' AND n.entity_id = p_candidate)
      OR (n.entity_type = 'interview' AND (n.entity_id = ANY (v_ivs) OR n.entity_id = ANY (v_app_ivs)))
      OR (n.entity_type = 'application' AND n.entity_id = ANY (v_apps));

  -- Interviews
  DELETE FROM eureka.feedback_notification fn
   USING eureka.feedback_delivery fd WHERE fn.delivery_id = fd.id AND fd.interview_id = ANY (v_ivs);
  DELETE FROM eureka.feedback_delivery WHERE interview_id = ANY (v_ivs);
  DELETE FROM eureka.interview_feedback WHERE interview_id = ANY (v_ivs);
  DELETE FROM eureka.interview_panelist WHERE interview_id = ANY (v_ivs);
  DELETE FROM eureka.calendar_block WHERE interview_id = ANY (v_ivs);
  DELETE FROM eureka.assessment WHERE candidate_id = p_candidate OR submission_id = ANY (v_subs);
  DELETE FROM eureka.interview WHERE id = ANY (v_ivs);
  DELETE FROM eureka.submission WHERE id = ANY (v_subs);

  -- Jobs portal applications (the applicant account stays)
  DELETE FROM eureka.application_scorecard WHERE interview_id = ANY (v_app_ivs);
  DELETE FROM eureka.application_interview_panel WHERE interview_id = ANY (v_app_ivs);
  DELETE FROM eureka.application_interview WHERE id = ANY (v_app_ivs);
  DELETE FROM eureka.application_event WHERE application_id = ANY (v_apps);
  DELETE FROM eureka.job_application WHERE id = ANY (v_apps);

  -- Paperwork, documents, resumes
  DELETE FROM eureka.checklist_item_event WHERE item_id = ANY (v_items);
  DELETE FROM eureka.checklist_item WHERE id = ANY (v_items);
  DELETE FROM eureka.bgc_event WHERE bgc_id = ANY (v_bgcs);
  DELETE FROM eureka.bgc WHERE id = ANY (v_bgcs);
  DELETE FROM eureka.document_access WHERE document_id = ANY (v_docs);
  DELETE FROM eureka.document WHERE id = ANY (v_docs);
  DELETE FROM eureka.file_object f WHERE f.id = ANY (v_files)
     AND NOT EXISTS (SELECT 1 FROM eureka.document d WHERE d.file_id = f.id)
     AND NOT EXISTS (SELECT 1 FROM eureka.chat_attachment ca WHERE ca.file_id = f.id)
     AND NOT EXISTS (SELECT 1 FROM eureka.datahub_file_version v WHERE v.file_object_id = f.id);
  DELETE FROM eureka.resume WHERE id = ANY (v_resumes);

  -- The candidate
  DELETE FROM eureka.module_progress WHERE candidate_id = p_candidate;
  DELETE FROM eureka.candidate_event WHERE candidate_id = p_candidate;
  DELETE FROM eureka.candidate_nonresponse WHERE candidate_id = p_candidate;
  DELETE FROM eureka.candidate_team_share WHERE candidate_id = p_candidate;
  DELETE FROM eureka.import_identity WHERE candidate_id = p_candidate;
  DELETE FROM eureka.import_link WHERE entity_id = ANY (v_subs || v_ivs || v_apps || v_docs || v_resumes || ARRAY[p_candidate, c.person_id]);
  DELETE FROM eureka.import_natural_key WHERE entity_id = ANY (v_subs || v_ivs || v_apps || v_docs || v_resumes || ARRAY[p_candidate, c.person_id]);
  DELETE FROM eureka.candidate WHERE id = p_candidate;

  -- The person, unless another record still points at them
  IF c.person_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM eureka.candidate x WHERE x.person_id = c.person_id)
     AND NOT EXISTS (SELECT 1 FROM eureka.placement x WHERE x.person_id = c.person_id)
     AND NOT EXISTS (SELECT 1 FROM eureka.assignment x WHERE x.person_id = c.person_id)
     -- employment_event rows need an assignment, so the checks above cover them.
     AND NOT EXISTS (SELECT 1 FROM eureka.employee x WHERE x.person_id = c.person_id) THEN
    v_was := ARRAY(SELECT w.id FROM eureka.work_authorization w WHERE w.person_id = c.person_id);
    DELETE FROM eureka.work_authorization_notice WHERE work_authorization_id = ANY (v_was);
    DELETE FROM eureka.work_authorization WHERE id = ANY (v_was);
    DELETE FROM eureka.person WHERE id = c.person_id;
  END IF;

  DELETE FROM eureka.candidate_purge
   WHERE xact = pg_catalog.pg_current_xact_id_if_assigned() AND pid = pg_catalog.pg_backend_pid();
END $function$;
REVOKE ALL ON FUNCTION authz.delete_candidate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.delete_candidate(uuid) TO eureka_app;
RESET ROLE;
