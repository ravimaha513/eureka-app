-- eureka.bump_access_version: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0002. Change this file, not a new migration.
-- Statement trigger on user_role, team_member, coach_assignment and team (B4.3).
-- Bumps every user's access_version once per transaction: the bump only becomes
-- visible at commit, together with every change of the transaction, so one bump
-- invalidates the same sessions as one per statement. Bumping per statement made a
-- bulk import of N rows rewrite app_user N times. The marker is transaction-local
-- (reverted with a rolled-back savepoint) and holds the transaction id, so a
-- session-level value never matches.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.bump_access_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF pg_catalog.current_setting('eureka.access_bumped', true) IS DISTINCT FROM pg_catalog.txid_current()::text THEN
    UPDATE eureka.app_user SET access_version = access_version + 1;
    PERFORM pg_catalog.set_config('eureka.access_bumped', pg_catalog.txid_current()::text, true);
  END IF;
  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION eureka.bump_access_version() FROM PUBLIC;
RESET ROLE;
