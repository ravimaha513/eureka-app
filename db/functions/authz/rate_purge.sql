-- authz.rate_purge: current definition (repeatable; db/functions/README.md).
-- since: 0521
-- Created for migration 0516 (R-24). Change this file, not a new migration.
--
-- Deletes expired authz.rate_window rows (windows that ended before now) and
-- returns how many. For the worker's periodic purge (eureka_worker); a window
-- left behind is harmless (rate_take never reads an old window), it only takes space.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.rate_purge()
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH gone AS (DELETE FROM authz.rate_window w WHERE w.expires_at <= pg_catalog.now() RETURNING 1)
  SELECT pg_catalog.count(*)::integer FROM gone
$function$;

REVOKE ALL ON FUNCTION authz.rate_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.rate_purge() TO eureka_worker;
RESET ROLE;
