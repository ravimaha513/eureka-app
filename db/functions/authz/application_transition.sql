-- authz.application_transition: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0062. Change this file, not a new migration.
-- Moved here in 0190, which added the applicant notice.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.application_transition(p_app uuid, p_to text, p_comment text, p_version integer)
 RETURNS TABLE(from_status text, to_status text, row_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE a eureka.job_application;
BEGIN
  a := authz.application_for_update(p_app);
  IF p_version IS NULL OR a.row_version IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'serialization_failure';
  END IF;
  IF NOT authz.application_transition_ok(a.status, p_to) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.job_application x SET status = p_to, status_changed_at = pg_catalog.now(), row_version = x.row_version + 1 WHERE x.id = a.id;
  IF p_to IN ('hired', 'rejected') THEN
    UPDATE eureka.application_interview i SET status = 'cancelled', updated_at = pg_catalog.now()
     WHERE i.application_id = a.id AND i.status = 'scheduled' AND i.starts_at > pg_catalog.now();
  END IF;
  INSERT INTO eureka.application_event (application_id, kind, actor_id, from_status, to_status, comment)
  VALUES (a.id, 'status', authz.current_user_id(), a.status, p_to, nullif(pg_catalog.btrim(p_comment), ''));
  -- The applicant is emailed the new status (0190), never the comment.
  INSERT INTO eureka.applicant_notice (application_id, kind, to_status) VALUES (a.id, 'status', p_to);
  RETURN QUERY SELECT a.status, p_to, a.row_version + 1;
END $function$;

REVOKE ALL ON FUNCTION authz.application_transition(uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.application_transition(uuid, text, text, integer) TO eureka_app;
RESET ROLE;
