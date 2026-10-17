-- authz.import_approve_batch: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0028, 0033, 0041. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.import_approve_batch(p_batch uuid, p_digest text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid := authz.import_require_admin(); b record; d text;
BEGIN
  SELECT ib.id, ib.status, ib.operator_id, ib.analysed_at, ib.purged_at INTO b
    FROM eureka.import_batch ib WHERE ib.id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found'; END IF;
  IF b.operator_id IS NULL OR b.operator_id = actor THEN
    RAISE EXCEPTION 'second_person_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF b.status IS DISTINCT FROM 'staged' OR b.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.import_decision dd JOIN eureka.import_row r ON r.sheet = dd.sheet AND r.row_key = dd.row_key
             WHERE r.batch_id = p_batch AND dd.decided_at > b.analysed_at) THEN
    RAISE EXCEPTION 'needs_analysis' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM authz.import_verify_batch(p_batch)) THEN
    RAISE EXCEPTION 'verification_failed' USING ERRCODE = 'check_violation';
  END IF;
  d := authz.import_batch_digest(p_batch);
  IF p_digest IS NULL OR p_digest IS DISTINCT FROM d THEN
    RAISE EXCEPTION 'batch_changed' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.import_batch SET status = 'approved', approved_by = actor, approved_digest = d WHERE id = p_batch;
  RETURN 'approved';
END $function$;

REVOKE ALL ON FUNCTION authz.import_approve_batch(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.import_approve_batch(uuid, text) TO eureka_app;
RESET ROLE;
