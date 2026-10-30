-- eureka.module_progress_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0065. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.module_progress_guard()
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
    RAISE EXCEPTION 'module_progress rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'module_progress rows are never updated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'no user context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.completed_at := pg_catalog.now();
  NEW.completed_by := authz.current_user_id();
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.module_progress_guard() FROM PUBLIC;
RESET ROLE;
