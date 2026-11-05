-- eureka.rebuild_reporting_closure: current definition (repeatable; db/functions/README.md).
-- since: 0521
-- Earlier body: migration 0002. Change this file, not a new migration.
-- Statement trigger on reporting_line: closure rebuild with cycle check, serialized by
-- advisory lock (B2.1, N10). The rebuild itself is eureka.reporting_closure_rebuild
-- (0506); the access_version bump is once per transaction, as in eureka.bump_access_version.
-- While a bulk flow defers the rebuild (authz.reporting_closure_defer, 0506) the trigger
-- only takes the lock and marks the closure pending: authz.reporting_closure_flush, or
-- the deferred constraint trigger reporting_closure_at_commit, rebuilds once.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.rebuild_reporting_closure()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF pg_catalog.current_setting('eureka.closure_defer', true) IS NOT DISTINCT FROM pg_catalog.pg_current_xact_id()::text THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.reporting_closure'));
    INSERT INTO authz.reporting_closure_pending (xact) VALUES (pg_catalog.pg_current_xact_id()) ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;
  PERFORM eureka.reporting_closure_rebuild();
  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION eureka.rebuild_reporting_closure() FROM PUBLIC;
RESET ROLE;
