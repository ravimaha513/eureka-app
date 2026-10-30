-- authz.role_archive: current definition (repeatable; db/functions/README.md).
-- An admin retires a custom role nobody holds (docs/roles-api.md): it leaves the
-- pickers, its rows stay for the audit trail. Pending requests for it are rejected.
-- Raises not_permitted, unknown_role, system_role, role_in_use.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.role_archive(p_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid; r record;
BEGIN
  actor := authz.admin_guard(NULL);
  SELECT ro.* INTO r FROM eureka.role ro WHERE ro.key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_role' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.is_system THEN
    RAISE EXCEPTION 'system_role' USING ERRCODE = 'check_violation';
  END IF;
  IF r.archived_at IS NOT NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.role_key = p_key AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'role_in_use' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.role SET archived_at = pg_catalog.now() WHERE key = p_key;
  UPDATE eureka.role_request SET status = 'rejected', decided_by = actor, decided_at = pg_catalog.now()
   WHERE role_key = p_key AND status = 'pending';
END $function$;

REVOKE ALL ON FUNCTION authz.role_archive(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.role_archive(text) TO eureka_app;
RESET ROLE;
