-- eureka.calendar_block_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0088. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.calendar_block_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0330) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF authz.current_user_id() IS NULL THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.status := 'active';
    NEW.created_by := authz.current_user_id();
    NEW.created_at := pg_catalog.now();
    NEW.released_by := NULL;
    NEW.released_at := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM 'active' OR NEW.status IS DISTINCT FROM 'released'
       OR (pg_catalog.to_jsonb(NEW) - 'status' - 'released_by' - 'released_at')
          IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'status' - 'released_by' - 'released_at') THEN
      RAISE EXCEPTION 'a calendar block can only be released' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.released_by := authz.current_user_id();
    NEW.released_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'calendar blocks are never deleted' USING ERRCODE = 'insufficient_privilege';
END $function$
;
REVOKE ALL ON FUNCTION eureka.calendar_block_guard() FROM PUBLIC;
RESET ROLE;
