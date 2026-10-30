-- eureka.rebuild_reporting_closure: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0002. Change this file, not a new migration.
-- Statement trigger on reporting_line: closure rebuild with cycle check, serialized by
-- advisory lock (B2.1, N10). The access_version bump is once per transaction, as in
-- eureka.bump_access_version.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.rebuild_reporting_closure()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('eureka.reporting_closure'));
  IF EXISTS (
    WITH RECURSIVE up(u, path) AS (
      SELECT rl.user_id, ARRAY[rl.user_id] FROM eureka.reporting_line rl WHERE rl.valid @> now()
      UNION ALL
      SELECT rl.manager_id, up.path || rl.manager_id
      FROM up JOIN eureka.reporting_line rl ON rl.user_id = up.u AND rl.valid @> now()
      WHERE NOT rl.manager_id = ANY(up.path) AND array_length(up.path,1) < 64
    )
    SELECT 1 FROM up JOIN eureka.reporting_line rl ON rl.user_id = up.u AND rl.valid @> now()
    WHERE rl.manager_id = ANY(up.path)
  ) THEN
    RAISE EXCEPTION 'reporting line cycle detected' USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM eureka.reporting_closure;
  INSERT INTO eureka.reporting_closure (ancestor_id, descendant_id, depth)
  WITH RECURSIVE c(anc, des, d) AS (
    SELECT rl.manager_id, rl.user_id, 1 FROM eureka.reporting_line rl WHERE rl.valid @> now()
    UNION ALL
    SELECT rl.manager_id, c.des, c.d + 1
    FROM c JOIN eureka.reporting_line rl ON rl.user_id = c.anc AND rl.valid @> now()
    WHERE c.d < 64
  )
  SELECT anc, des, min(d) FROM c GROUP BY anc, des;

  -- Bump access_version for everyone: org changes are rare, correctness first.
  IF pg_catalog.current_setting('eureka.access_bumped', true) IS DISTINCT FROM pg_catalog.txid_current()::text THEN
    UPDATE eureka.app_user SET access_version = access_version + 1;
    PERFORM pg_catalog.set_config('eureka.access_bumped', pg_catalog.txid_current()::text, true);
  END IF;
  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION eureka.rebuild_reporting_closure() FROM PUBLIC;
RESET ROLE;
