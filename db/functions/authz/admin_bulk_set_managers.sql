-- authz.admin_bulk_set_managers: current definition (repeatable; db/functions/README.md).
-- Sets the reporting line of many users at once (bulk user import, docs/admin-api.md):
-- p_users[i] reports to p_managers[i]. The same checks as authz.admin_set_manager
-- per pair, then one UPDATE and one INSERT, so the closure is rebuilt once instead
-- of once per user. Any failure aborts the whole call; the API checks each row first
-- to report problems per row. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.admin_bulk_set_managers(p_users uuid[], p_managers uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid; i int;
BEGIN
  actor := authz.admin_guard(NULL);
  IF pg_catalog.cardinality(p_users) IS DISTINCT FROM pg_catalog.cardinality(p_managers)
     OR pg_catalog.array_position(p_users, NULL) IS NOT NULL
     OR pg_catalog.array_position(p_managers, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT u) FROM unnest(p_users) u) <> pg_catalog.cardinality(p_users) THEN
    RAISE EXCEPTION 'duplicate_user' USING ERRCODE = 'check_violation';
  END IF;
  FOR i IN 1 .. coalesce(pg_catalog.cardinality(p_users), 0) LOOP
    PERFORM authz.admin_guard(p_users[i]);
    PERFORM authz.admin_user_status(p_users[i]);
    IF p_managers[i] = actor THEN
      RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_managers[i] = p_users[i] THEN
      RAISE EXCEPTION 'cycle' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_managers[i] AND u.status = 'active') THEN
      RAISE EXCEPTION 'invalid_manager' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF coalesce(pg_catalog.cardinality(p_users), 0) = 0 THEN
    RETURN;
  END IF;
  UPDATE eureka.reporting_line SET valid = authz.ended(valid)
    WHERE user_id = ANY (p_users) AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  BEGIN
    INSERT INTO eureka.reporting_line (user_id, manager_id)
    SELECT u, m FROM unnest(p_users, p_managers) AS x(u, m);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'cycle' USING ERRCODE = 'check_violation';
  END;
END $function$;

REVOKE ALL ON FUNCTION authz.admin_bulk_set_managers(uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_bulk_set_managers(uuid[], uuid[]) TO eureka_app;
RESET ROLE;
