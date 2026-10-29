-- authz.purge_inactive_users: current definition (repeatable; db/functions/README.md).
-- Worker (daily, worker/jobs/user-purge.ts): deletes users deactivated at least p_days
-- (7..365) days ago, by authz.anonymize_user (migration 0280). At most 200 per call,
-- oldest first; returns their ids for the audit rows. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.purge_inactive_users(p_days integer)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE ids uuid[]; v_id uuid;
BEGIN
  IF p_days IS NULL OR p_days < 7 OR p_days > 365 THEN
    RAISE EXCEPTION 'days must be between 7 and 365' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(pg_catalog.array_agg(x.id), '{}') INTO ids FROM (
    SELECT u.id FROM eureka.app_user u
     WHERE u.status = 'inactive' AND u.deleted_at IS NULL
       AND u.deactivated_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
     ORDER BY u.deactivated_at LIMIT 200
     FOR UPDATE SKIP LOCKED) x;
  FOREACH v_id IN ARRAY ids LOOP
    PERFORM authz.anonymize_user(v_id);
  END LOOP;
  RETURN ids;
END $function$;
REVOKE ALL ON FUNCTION authz.purge_inactive_users(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.purge_inactive_users(integer) TO eureka_worker;
RESET ROLE;
