-- eureka.import_batch_guard: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0028, 0033, 0041. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.import_batch_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user IS DISTINCT FROM 'authz_definer' OR NEW.status IS DISTINCT FROM 'staged'
       OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approved_digest IS NOT NULL
       OR NEW.committed_at IS NOT NULL OR NEW.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = NEW.operator_id AND u.status = 'active') THEN
      RAISE EXCEPTION 'operator_not_active' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.analysed_at := pg_catalog.now();
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.source_digest, NEW.files, NEW.operator_id, NEW.created_at, NEW.placements_commit)
     IS DISTINCT FROM (OLD.id, OLD.source_digest, OLD.files, OLD.operator_id, OLD.created_at, OLD.placements_commit) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
    IF OLD.purged_at IS NOT NULL OR NEW.purged_at IS NULL THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.purged_at := pg_catalog.now();
  END IF;
  IF NEW.analysed_at IS DISTINCT FROM OLD.analysed_at THEN
    IF OLD.status IS DISTINCT FROM 'staged' THEN
      RAISE EXCEPTION 'batch_not_staged' USING ERRCODE = 'check_violation';
    END IF;
    NEW.analysed_at := pg_catalog.clock_timestamp();
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF current_user IS DISTINCT FROM 'authz_definer' THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status IS NOT DISTINCT FROM 'approved' AND OLD.status = 'staged' THEN
      NEW.approved_at := pg_catalog.now();
    ELSIF NEW.status IS NOT DISTINCT FROM 'committed' AND OLD.status = 'approved' THEN
      NEW.committed_at := pg_catalog.now();
    ELSIF NEW.status IS NOT DISTINCT FROM 'staged' AND OLD.status = 'approved' THEN
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.approved_digest := NULL;
    ELSE
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.approved_by, NEW.approved_at, NEW.approved_digest, NEW.committed_at)
        IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.approved_digest, OLD.committed_at) THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION eureka.import_batch_guard() FROM PUBLIC;
RESET ROLE;
