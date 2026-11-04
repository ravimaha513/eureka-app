-- authz.delete_batch: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0065 (training:manage locations only). Sales leadership
-- (Lead and above, authz.batch_manager) may now delete an empty batch at the
-- locations where they plan batches, as for create_batch and set_batch_status.
-- Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.delete_batch(p_batch uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(authz.has_perm('candidate:read') OR authz.has_perm('training:read'), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  -- training:manage locations, plus Sales leadership's batch locations.
  IF NOT coalesce(b.location_id = ANY (authz.batch_manage_location_ids()), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- set_batch_student holds FOR SHARE on the batch row, so it waits for this lock; a
  -- concurrent profile edit that still sets batch_id makes the DELETE fail on the foreign key.
  IF EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.batch_id = p_batch) THEN
    RAISE EXCEPTION 'batch_has_students' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.module_progress WHERE batch_id = p_batch;
  DELETE FROM eureka.batch WHERE id = p_batch;
END $function$;

REVOKE ALL ON FUNCTION authz.delete_batch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.delete_batch(uuid) TO eureka_app;
RESET ROLE;
