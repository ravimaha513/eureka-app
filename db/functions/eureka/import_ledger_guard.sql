-- eureka.import_ledger_guard: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0028, 0033, 0041. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.import_ledger_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE b record;
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0320) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the import ledger is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ib.status, ib.approved_at, ib.approved_digest INTO b
    FROM eureka.import_batch ib WHERE ib.id = NEW.batch_id FOR SHARE;
  IF NOT FOUND OR b.status IS DISTINCT FROM 'approved'
     OR NOT coalesce(b.approved_at + pg_catalog.make_interval(days => (SELECT c.approval_days FROM eureka.import_config c)) > pg_catalog.now(), false) THEN
    RAISE EXCEPTION 'batch_not_approved' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.import_session s WHERE s.xact = pg_catalog.pg_current_xact_id_if_assigned()
                 AND s.pid = pg_catalog.pg_backend_pid() AND s.verified_batch = NEW.batch_id) THEN
    IF authz.import_batch_digest(NEW.batch_id) IS DISTINCT FROM b.approved_digest THEN
      RAISE EXCEPTION 'batch_changed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'import_link' THEN
    NEW.committed_at := pg_catalog.now();
  ELSE
    NEW.created_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION eureka.import_ledger_guard() FROM PUBLIC;
RESET ROLE;
