-- eureka.submission_insert_guard: current definition (repeatable; db/functions/README.md).
-- since: 0521
-- Earlier body: migration 0019. Change this file, not a new migration.
-- New rows start clean: status, the details-edited stamps (0440) and row_version (0507) are server-managed.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.submission_insert_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM 'submitted' OR NEW.rejection_reason IS NOT NULL
     OR NEW.status_changed_at IS NOT NULL OR NEW.status_changed_by IS NOT NULL
     OR NEW.details_edited_at IS NOT NULL OR NEW.details_edited_by IS NOT NULL
     OR NEW.row_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.submission_insert_guard() FROM PUBLIC;
RESET ROLE;
