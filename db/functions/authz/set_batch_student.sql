-- authz.set_batch_student: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0065. The batch's creator added here (docs/training-api.md
-- TR-8). Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.set_batch_student(p_batch uuid, p_candidate uuid, p_member boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE b record; c record; creator boolean;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR SHARE;
  -- The creator counts only while they may still plan batches (first check of create_batch).
  creator := FOUND AND coalesce(b.created_by = authz.current_user_id()
                                AND (authz.batch_manager() OR authz.has_perm('training:manage')
                                     OR authz.has_perm('training.batch:create')), false);
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(creator OR p_batch = ANY (authz.training_batch_ids('training:read')), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(creator OR p_batch = ANY (authz.training_batch_ids('training:manage')), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_member IS NULL THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x.id, x.batch_id, x.location_id INTO c FROM eureka.candidate x WHERE x.id = p_candidate FOR UPDATE;
  -- One answer for "no such candidate", "not readable by the caller" and "not at this location".
  IF NOT FOUND OR c.location_id IS DISTINCT FROM b.location_id
     OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false) THEN
    RAISE EXCEPTION 'candidate_not_eligible' USING ERRCODE = 'check_violation';
  END IF;
  IF p_member THEN
    IF c.batch_id IS NOT DISTINCT FROM p_batch THEN RETURN; END IF;
    IF b.status NOT IN ('planned', 'in_training') THEN
      RAISE EXCEPTION 'batch_closed' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.candidate SET batch_id = p_batch WHERE id = p_candidate;
  ELSE
    IF c.batch_id IS DISTINCT FROM p_batch THEN
      RAISE EXCEPTION 'not_in_batch' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.candidate SET batch_id = NULL WHERE id = p_candidate;
  END IF;
END $function$;

REVOKE ALL ON FUNCTION authz.set_batch_student(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_batch_student(uuid, uuid, boolean) TO eureka_app;
RESET ROLE;
