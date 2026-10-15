-- Sheet import sign-off in single-admin mode (0084; owner decision 2026-10-15).
-- With single_admin_mode = 'on' (staging today; written by seedCatalog from
-- SINGLE_ADMIN_MODE on every migrate run) the admin who staged a batch may also
-- approve it, as request_role already lets one admin approve their own role
-- request there. With it off (production), approval still needs a second org
-- admin: the check moves from the table into authz.import_approve_batch.
-- Everything else about approval is unchanged (0041): an active org admin,
-- analysed after the last decision, verified, quoting the preview's digest.
-- Rules 1-7 of docs/HANDOFF.md apply.
SET search_path = eureka, public;

SET ROLE eureka_owner;
ALTER TABLE eureka.import_batch DROP CONSTRAINT import_batch_second_person;
RESET ROLE;

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.import_approve_batch(p_batch uuid, p_digest text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.import_require_admin(); b record; d text;
BEGIN
  SELECT ib.id, ib.status, ib.operator_id, ib.analysed_at, ib.purged_at INTO b
    FROM eureka.import_batch ib WHERE ib.id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found'; END IF;
  IF b.operator_id IS NULL OR (b.operator_id = actor AND NOT coalesce(authz.single_admin_mode(), false)) THEN
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
END $$;
RESET ROLE;

REVOKE ALL ON FUNCTION authz.import_approve_batch(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.import_approve_batch(uuid, text) TO eureka_app;
-- The upload page (staging) checks the caller is an org admin before reading batches as eureka_import.
GRANT EXECUTE ON FUNCTION authz.import_require_admin() TO eureka_app;
