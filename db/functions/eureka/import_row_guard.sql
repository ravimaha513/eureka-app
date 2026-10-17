-- eureka.import_row_guard: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0028, 0033, 0041. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.import_row_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE b text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import rows are not deleted; purge clears their data' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ib.status INTO b FROM eureka.import_batch ib WHERE ib.id = NEW.batch_id FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF b IS DISTINCT FROM 'staged' OR NEW.state IS NOT DISTINCT FROM 'committed' OR NEW.committed_entity IS NOT NULL
       OR NEW.commit_error IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.batch_id, NEW.sheet, NEW.row_no, NEW.row_key)
     IS DISTINCT FROM (OLD.id, OLD.batch_id, OLD.sheet, OLD.row_no, OLD.row_key) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.raw IS NULL AND NEW.norm IS NULL
     AND (NEW.status_key, NEW.person_key, NEW.state, NEW.reasons, NEW.commit_error, NEW.committed_entity)
         IS NOT DISTINCT FROM (OLD.status_key, OLD.person_key, OLD.state, OLD.reasons, OLD.commit_error, OLD.committed_entity) THEN
    RETURN NEW;
  END IF;
  IF (NEW.raw, NEW.norm, NEW.status_key, NEW.person_key, NEW.state, NEW.reasons, NEW.committed_entity)
     IS NOT DISTINCT FROM (OLD.raw, OLD.norm, OLD.status_key, OLD.person_key, OLD.state, OLD.reasons, OLD.committed_entity) THEN
    RETURN NEW;
  END IF;
  IF OLD.state IS NOT DISTINCT FROM 'committed' THEN
    RAISE EXCEPTION 'row already committed' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'authz_definer' THEN
    IF (NEW.raw, NEW.norm, NEW.status_key, NEW.person_key, NEW.reasons)
       IS DISTINCT FROM (OLD.raw, OLD.norm, OLD.status_key, OLD.person_key, OLD.reasons)
       OR NOT coalesce(OLD.state = 'clean' AND NEW.state = 'committed' AND NEW.committed_entity IS NOT NULL, false)
       OR b IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS NOT DISTINCT FROM 'committed' OR NEW.committed_entity IS DISTINCT FROM OLD.committed_entity THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF b IS DISTINCT FROM 'staged' THEN
    RAISE EXCEPTION 'batch_not_staged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION eureka.import_row_guard() FROM PUBLIC;
RESET ROLE;
