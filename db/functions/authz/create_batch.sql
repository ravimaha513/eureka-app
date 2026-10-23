-- authz.create_batch: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0026, 0032, 0065. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.create_batch(p_location uuid, p_technology uuid, p_start_month date, p_size integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE new_id uuid;
BEGIN
  IF authz.current_user_id() IS NULL
     OR NOT coalesce(authz.batch_manager() OR authz.has_perm('training:manage'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_location IS NULL OR p_technology IS NULL OR p_start_month IS NULL
     OR NOT EXISTS (SELECT 1 FROM eureka.location l WHERE l.id = p_location)
     OR NOT EXISTS (SELECT 1 FROM eureka.technology t WHERE t.id = p_technology AND t.active)
     OR (p_size IS NOT NULL AND NOT coalesce(p_size BETWEEN 1 AND 500, false)) THEN
    RAISE EXCEPTION 'invalid_batch' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(p_location = ANY (authz.batch_manage_location_ids()), false) THEN
    RAISE EXCEPTION 'location_not_in_scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  BEGIN
    INSERT INTO eureka.batch (location_id, technology_id, start_month, size_planned)
    VALUES (p_location, p_technology, pg_catalog.date_trunc('month', p_start_month)::date, p_size)
    RETURNING id INTO new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'batch_exists' USING ERRCODE = 'unique_violation';
  END;
  RETURN new_id;
END $function$;

REVOKE ALL ON FUNCTION authz.create_batch(uuid, uuid, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_batch(uuid, uuid, date, integer) TO eureka_app;
RESET ROLE;
