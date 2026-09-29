-- Admin safety rails (decided while building 0013, least-privilege defaults):
--   * the last active org_admin cannot be revoked or deactivated (no lock-out);
--   * a team lead cannot be deactivated until the team has a new lead
--     (team.lead_id is NOT NULL and scope resolution relies on it).
SET ROLE authz_definer;

CREATE FUNCTION authz.assert_admin_remains() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
      WHERE ur.role_key = 'org_admin' AND ur.valid @> pg_catalog.now() AND u.status = 'active') THEN
    RAISE EXCEPTION 'last_admin' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;
REVOKE ALL ON FUNCTION authz.assert_admin_remains() FROM PUBLIC;

CREATE OR REPLACE FUNCTION authz.admin_set_user_status(p_user uuid, p_active boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE was_admin boolean;
BEGIN
  PERFORM authz.admin_guard(p_user);
  PERFORM 1 FROM eureka.app_user u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_active THEN
    UPDATE eureka.app_user SET status = 'active', access_version = access_version + 1 WHERE id = p_user;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.team t WHERE t.lead_id = p_user) THEN
    RAISE EXCEPTION 'lead_of_team' USING ERRCODE = 'check_violation';
  END IF;
  was_admin := EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = p_user
                       AND ur.role_key = 'org_admin' AND ur.valid @> pg_catalog.now());
  UPDATE eureka.app_user SET status = 'inactive', access_version = access_version + 1 WHERE id = p_user;
  UPDATE eureka.user_role SET valid = authz.ended(valid)
    WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  UPDATE eureka.team_member SET valid = authz.ended(valid)
    WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  UPDATE eureka.coach_assignment SET valid = authz.ended(valid)
    WHERE coach_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  UPDATE eureka.session SET revoked_at = pg_catalog.now() WHERE user_id = p_user AND revoked_at IS NULL;
  IF was_admin THEN
    PERFORM authz.assert_admin_remains();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION authz.revoke_role(p_user uuid, p_role text, p_location uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  PERFORM authz.admin_guard(p_user);
  UPDATE eureka.user_role SET valid = authz.ended(valid)
    WHERE user_id = p_user AND role_key = p_role
      AND (p_location IS NULL OR location_id = p_location)
      AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'role_not_held' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_role = 'org_admin' THEN
    PERFORM authz.assert_admin_remains();
  END IF;
  RETURN n;
END $$;

RESET ROLE;
