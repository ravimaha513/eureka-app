-- authz.admin_set_user_status: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0013, 0014, 0018. Change this file, not a new migration.

-- 0311: branches on role traits (authz.user_has_trait), never on the role key (docs/roles-api.md).
SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.admin_set_user_status(p_user uuid, p_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE was_admin boolean; actor uuid;
BEGIN
  actor := authz.admin_guard(p_user);
  -- Deleted users (migration 0280) are gone for every admin action.
  PERFORM 1 FROM eureka.app_user u WHERE u.id = p_user AND u.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_active THEN
    UPDATE eureka.app_user SET status = 'active', deactivated_at = NULL, access_version = access_version + 1 WHERE id = p_user;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.team t WHERE t.lead_id = p_user) THEN
    RAISE EXCEPTION 'lead_of_team' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.reporting_line rl WHERE rl.manager_id = p_user AND rl.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'has_reports' USING ERRCODE = 'check_violation';
  END IF;
  was_admin := authz.user_has_trait(p_user, 'admin');
  -- Re-deactivating keeps the first stamp, so the purge wait is not restarted.
  UPDATE eureka.app_user SET status = 'inactive', deactivated_at = coalesce(deactivated_at, pg_catalog.now()),
    access_version = access_version + 1 WHERE id = p_user;
  UPDATE eureka.user_role SET valid = authz.ended(valid)
    WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  UPDATE eureka.team_member SET valid = authz.ended(valid)
    WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  UPDATE eureka.coach_assignment SET valid = authz.ended(valid)
    WHERE coach_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  UPDATE eureka.reporting_line SET valid = authz.ended(valid)
    WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  -- Pending requests for or by this user can no longer be approved.
  UPDATE eureka.role_request SET status = 'rejected', decided_by = actor, decided_at = pg_catalog.now()
    WHERE status = 'pending' AND (user_id = p_user OR requested_by = p_user) AND user_id <> actor;
  UPDATE eureka.session SET revoked_at = pg_catalog.now() WHERE user_id = p_user AND revoked_at IS NULL;
  IF was_admin THEN
    PERFORM authz.assert_admin_remains();
  END IF;
END $function$;

REVOKE ALL ON FUNCTION authz.admin_set_user_status(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_set_user_status(uuid, boolean) TO eureka_app;
RESET ROLE;
