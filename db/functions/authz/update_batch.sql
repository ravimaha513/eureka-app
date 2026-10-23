-- authz.update_batch: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migration 0065. The creator's first edit in the creating
-- transaction (docs/training-api.md TR-1a) added here. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.update_batch(p_batch uuid, p_version integer, p_name text, p_trainer uuid, p_start date, p_end date, p_size integer, p_color text, p_icon text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE b record; nm text := nullif(pg_catalog.btrim(p_name), ''); v integer; month date; fresh boolean;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR UPDATE;
  -- A batch the caller created in this transaction and has not edited yet: the
  -- training API creates and then names it in one transaction, so creators without
  -- training:manage there (Sales leadership, training.batch:create) can set its
  -- details. The batch guard sets created_by, created_at and row_version on insert.
  fresh := FOUND AND coalesce(b.created_by = authz.current_user_id() AND b.row_version = 1
                              AND b.created_at = pg_catalog.now(), false);
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(fresh OR authz.has_perm('candidate:read') OR authz.has_perm('training:read'), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(fresh OR b.location_id = ANY (authz.training_manage_location_ids()), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_version IS NULL OR p_version IS DISTINCT FROM b.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'raise_exception';
  END IF;
  IF (nm IS NOT NULL AND NOT coalesce(pg_catalog.char_length(nm) <= 80 AND nm !~ '[[:cntrl:]]', false))
     OR (p_size IS NOT NULL AND NOT coalesce(p_size BETWEEN 1 AND 500, false))
     OR p_color IS NULL OR p_color NOT IN ('indigo', 'teal', 'amber', 'rose', 'violet', 'sky')
     OR p_icon IS NULL OR p_icon NOT IN ('book', 'code', 'database', 'cloud', 'shield', 'chart', 'users', 'cap')
     OR (p_start IS NOT NULL AND NOT coalesce(p_start BETWEEN date '2000-01-01' AND date '2100-12-31', false)) THEN
    RAISE EXCEPTION 'invalid_batch' USING ERRCODE = 'check_violation';
  END IF;
  month := coalesce(pg_catalog.date_trunc('month', p_start)::date, b.start_month);
  IF p_end IS NOT NULL AND NOT coalesce(p_end >= coalesce(p_start, month) AND p_end <= date '2100-12-31', false) THEN
    RAISE EXCEPTION 'invalid_dates' USING ERRCODE = 'check_violation';
  END IF;
  -- The trainer is an active user who may record progress (any scope).
  IF p_trainer IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM eureka.user_role ur
      JOIN eureka.app_user u ON u.id = ur.user_id AND u.status = 'active'
      JOIN eureka.role_permission rp ON rp.role_key = ur.role_key AND rp.permission = 'training.progress:update'
      WHERE ur.user_id = p_trainer AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'invalid_trainer' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    UPDATE eureka.batch SET name = nm, trainer_id = p_trainer, start_date = p_start, end_date = p_end,
      start_month = month, size_planned = p_size, cover_color = p_color, cover_icon = p_icon
    WHERE id = p_batch RETURNING row_version INTO v;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'batch_exists' USING ERRCODE = 'unique_violation';
  END;
  RETURN v;
END $function$;

REVOKE ALL ON FUNCTION authz.update_batch(uuid, integer, text, uuid, date, date, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.update_batch(uuid, integer, text, uuid, date, date, integer, text, text) TO eureka_app;
RESET ROLE;
