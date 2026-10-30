-- authz.role_restore: current definition (repeatable; db/functions/README.md).
-- Brings an archived custom role back (docs/roles-api.md). Raises not_permitted,
-- unknown_role, role_exists when a live role took its label meanwhile.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.role_restore(p_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r record;
BEGIN
  PERFORM authz.admin_guard(NULL);
  SELECT ro.* INTO r FROM eureka.role ro WHERE ro.key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_role' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.archived_at IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.role ro WHERE pg_catalog.lower(ro.label) = pg_catalog.lower(r.label)
             AND ro.archived_at IS NULL AND ro.key <> p_key) THEN
    RAISE EXCEPTION 'role_exists' USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE eureka.role SET archived_at = NULL WHERE key = p_key;
END $function$;

REVOKE ALL ON FUNCTION authz.role_restore(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.role_restore(text) TO eureka_app;
RESET ROLE;
