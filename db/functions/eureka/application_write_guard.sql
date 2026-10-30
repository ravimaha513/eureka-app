-- eureka.application_write_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0062. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.application_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0320) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'application data changes only through application functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'application_interview_panel' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'application data is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'application_event' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'application_event is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.application_write_guard() FROM PUBLIC;
RESET ROLE;
