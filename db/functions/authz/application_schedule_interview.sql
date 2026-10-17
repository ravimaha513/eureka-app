-- authz.application_schedule_interview: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0062. Change this file, not a new migration.
-- Moved here in 0190, which added the applicant notice.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.application_schedule_interview(p_app uuid, p_type text, p_round text, p_lead uuid, p_panel uuid[], p_starts timestamp with time zone, p_minutes integer, p_link text)
 RETURNS TABLE(interview_id uuid, from_status text, to_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE a eureka.job_application; iid uuid; panel uuid[] := ARRAY(SELECT DISTINCT x FROM pg_catalog.unnest(coalesce(p_panel, '{}')) x WHERE x IS NOT NULL);
BEGIN
  a := authz.application_for_update(p_app);
  IF NOT coalesce(a.status IN ('applied', 'shortlisted', 'interview_scheduled', 'offered'), false) THEN
    RAISE EXCEPTION 'application_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF pg_catalog.cardinality(panel) > 10 THEN
    RAISE EXCEPTION 'invalid_panel' USING ERRCODE = 'check_violation';
  END IF;
  IF p_lead IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_lead AND u.status = 'active')
     OR (SELECT count(*) FROM eureka.app_user u WHERE u.id = ANY (panel) AND u.status = 'active') <> pg_catalog.cardinality(panel) THEN
    RAISE EXCEPTION 'invalid_interviewer' USING ERRCODE = 'check_violation';
  END IF;
  IF p_starts IS NULL OR p_starts < pg_catalog.now() - interval '1 day' THEN
    RAISE EXCEPTION 'invalid_slot' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.application_interview (application_id, interview_type, round, lead_user_id, starts_at, duration_minutes, meeting_link, created_by)
  VALUES (a.id, p_type, p_round, p_lead, p_starts, p_minutes, nullif(p_link, ''), authz.current_user_id())
  RETURNING id INTO iid;
  INSERT INTO eureka.application_interview_panel (interview_id, user_id) SELECT iid, x FROM pg_catalog.unnest(panel) x;
  INSERT INTO eureka.application_event (application_id, kind, actor_id) VALUES (a.id, 'interview_scheduled', authz.current_user_id());
  -- One email to the applicant with the interview details (0190); not a second one for the status.
  INSERT INTO eureka.applicant_notice (application_id, kind, interview_id) VALUES (a.id, 'interview', iid);
  IF a.status IN ('applied', 'shortlisted') THEN
    UPDATE eureka.job_application x SET status = 'interview_scheduled', status_changed_at = pg_catalog.now(), row_version = x.row_version + 1 WHERE x.id = a.id;
    INSERT INTO eureka.application_event (application_id, kind, actor_id, from_status, to_status)
    VALUES (a.id, 'status', authz.current_user_id(), a.status, 'interview_scheduled');
    RETURN QUERY SELECT iid, a.status, 'interview_scheduled'::text;
  ELSE
    RETURN QUERY SELECT iid, a.status, a.status;
  END IF;
END $function$;

REVOKE ALL ON FUNCTION authz.application_schedule_interview(uuid, text, text, uuid, uuid[], timestamp with time zone, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.application_schedule_interview(uuid, text, text, uuid, uuid[], timestamp with time zone, integer, text) TO eureka_app;
RESET ROLE;
