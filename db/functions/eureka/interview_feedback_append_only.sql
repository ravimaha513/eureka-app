-- eureka.interview_feedback_append_only: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0017. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.interview_feedback_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0330) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'interview feedback is append-only' USING ERRCODE = 'insufficient_privilege';
END $function$
;
REVOKE ALL ON FUNCTION eureka.interview_feedback_append_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.interview_feedback_append_only() TO eureka_app;
GRANT EXECUTE ON FUNCTION eureka.interview_feedback_append_only() TO eureka_worker;
GRANT EXECUTE ON FUNCTION eureka.interview_feedback_append_only() TO authz_definer;
RESET ROLE;
