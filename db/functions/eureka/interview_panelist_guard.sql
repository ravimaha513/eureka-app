-- eureka.interview_panelist_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0080. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.interview_panelist_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0320) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND current_user = 'authz_definer' THEN
    NEW.added_by := authz.current_user_id();
    NEW.added_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND (current_user = 'authz_definer'
       OR coalesce(pg_catalog.pg_trigger_depth() > 1 AND current_user = 'eureka_owner', false)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'the interview panel changes only through authz.set_interview_panel'
    USING ERRCODE = 'insufficient_privilege';
END $function$
;
REVOKE ALL ON FUNCTION eureka.interview_panelist_guard() FROM PUBLIC;
RESET ROLE;
