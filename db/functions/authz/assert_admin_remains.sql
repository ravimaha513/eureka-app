-- authz.assert_admin_remains: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0014, 0018, 0039. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.assert_admin_remains()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'read_committed_required' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Serialise concurrent admin removals explicitly (not via incidental row locks).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.org_admin_count'));
  IF NOT EXISTS (
      SELECT 1 FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
      WHERE ur.role_key = 'org_admin' AND ur.valid @> pg_catalog.now() AND u.status = 'active') THEN
    RAISE EXCEPTION 'last_admin' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $function$;

REVOKE ALL ON FUNCTION authz.assert_admin_remains() FROM PUBLIC;
RESET ROLE;
