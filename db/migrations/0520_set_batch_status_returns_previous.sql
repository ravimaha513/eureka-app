-- authz.set_batch_status returns the status the batch had before the change
-- (docs/backend-audit D-06 follow-up; docs/candidates-api.md "Batches").
--
-- The API audits batch.status as { from, to }. It used to take `from` from a read
-- made before the function locked the row, so a concurrent change between that
-- read and the lock could record the wrong `from`. The function reads the row
-- FOR UPDATE, so the status it saw is the one it changed: returning it lets both
-- callers (PUT /batches/:id/status, PUT /training/batches/:id/status) audit the
-- true previous value. Same signature and return type (text), so callers that
-- ignore the result are unaffected; checks and error codes are unchanged from 0065.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.set_batch_status(p_batch uuid, p_to text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(authz.has_perm('candidate:read') OR authz.has_perm('training:read'), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(b.location_id = ANY (authz.batch_manage_location_ids()), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to IS NULL OR NOT coalesce((b.status, p_to) IN (
      ('planned', 'in_training'), ('in_training', 'completed'),
      ('planned', 'cancelled'), ('in_training', 'cancelled')), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.batch SET status = p_to WHERE id = p_batch;
  -- The status locked above, i.e. the one this call changed (the audit's `from`).
  RETURN b.status;
END $$;
REVOKE ALL ON FUNCTION authz.set_batch_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_batch_status(uuid, text) TO eureka_app;
RESET ROLE;
