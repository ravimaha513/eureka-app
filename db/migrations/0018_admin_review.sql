-- Admin security review follow-ups (2026-09-29):
-- * approving a request checks the grantee is still active and the requester
--   still holds org_admin; deactivation and org_admin revocation close pending
--   requests for/by that user (a deactivated user could regain a restricted
--   role on reactivation);
-- * separation of duties: org_admin holds no data role and vice versa;
-- * deactivation ends the user's reporting line and is refused while they
--   still have direct reports (has_reports);
-- * assert_admin_remains serialises with an advisory lock.
-- role.is_restricted is re-seeded by the migration runner from the widened
-- isRestrictedRole() (org-wide sensitive permissions now need a second approver).
SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.assert_admin_remains() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Serialise concurrent admin removals explicitly (not via incidental row locks).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.org_admin_count'));
  IF NOT EXISTS (
      SELECT 1 FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
      WHERE ur.role_key = 'org_admin' AND ur.valid @> pg_catalog.now() AND u.status = 'active') THEN
    RAISE EXCEPTION 'last_admin' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION authz.request_role(p_user uuid, p_role text, p_location uuid)
RETURNS TABLE (request_id uuid, request_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid; r record; req uuid;
BEGIN
  actor := authz.admin_guard(p_user);
  PERFORM authz.admin_user_status(p_user);
  SELECT ro.is_location_bound, ro.is_restricted INTO r FROM eureka.role ro WHERE ro.key = p_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_role' USING ERRCODE = 'check_violation';
  END IF;
  -- Separation of duties: org_admin holds no data role and vice versa.
  IF (p_role = 'org_admin' AND EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = p_user
        AND ur.role_key <> 'org_admin' AND ur.valid @> pg_catalog.now()))
     OR (p_role <> 'org_admin' AND EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = p_user
        AND ur.role_key = 'org_admin' AND ur.valid @> pg_catalog.now())) THEN
    RAISE EXCEPTION 'separation_of_duties' USING ERRCODE = 'check_violation';
  END IF;
  IF r.is_location_bound AND p_location IS NULL THEN
    RAISE EXCEPTION 'location_required' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT r.is_location_bound AND p_location IS NOT NULL THEN
    RAISE EXCEPTION 'location_not_allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = p_user AND ur.role_key = p_role
             AND ur.location_id IS NOT DISTINCT FROM p_location AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'role_already_held' USING ERRCODE = 'unique_violation';
  END IF;

  UPDATE eureka.role_request q SET status = 'expired'
    WHERE q.user_id = p_user AND q.role_key = p_role AND q.location_id IS NOT DISTINCT FROM p_location
      AND q.status = 'pending' AND q.expires_at <= pg_catalog.now();

  IF r.is_restricted THEN
    IF EXISTS (SELECT 1 FROM eureka.role_request q WHERE q.user_id = p_user AND q.role_key = p_role
               AND q.location_id IS NOT DISTINCT FROM p_location AND q.status = 'pending') THEN
      RAISE EXCEPTION 'request_pending' USING ERRCODE = 'unique_violation';
    END IF;
    INSERT INTO eureka.role_request (user_id, role_key, location_id, requested_by, status)
    VALUES (p_user, p_role, p_location, actor, 'pending')
    RETURNING id INTO req;
    RETURN QUERY SELECT req, 'pending_approval'::text;
  ELSE
    INSERT INTO eureka.user_role (user_id, role_key, location_id, created_by)
    VALUES (p_user, p_role, p_location, actor);
    INSERT INTO eureka.role_request (user_id, role_key, location_id, requested_by, status, decided_at)
    VALUES (p_user, p_role, p_location, actor, 'applied', pg_catalog.now())
    RETURNING id INTO req;
    RETURN QUERY SELECT req, 'applied'::text;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION authz.approve_role_request(p_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid; q record;
BEGIN
  actor := authz.admin_guard(NULL);
  SELECT rq.* INTO q FROM eureka.role_request rq WHERE rq.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF q.status <> 'pending' THEN
    RAISE EXCEPTION 'request_not_pending' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF q.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'request_expired' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The grantee must still be active (security review: approval after deactivation).
  IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = q.user_id AND u.status = 'active' FOR SHARE) THEN
    RAISE EXCEPTION 'user_inactive' USING ERRCODE = 'check_violation';
  END IF;
  -- The requester must still hold access:manage.
  IF NOT EXISTS (SELECT 1 FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
                 WHERE ur.user_id = q.requested_by AND ur.role_key = 'org_admin'
                   AND ur.valid @> pg_catalog.now() AND u.status = 'active') THEN
    RAISE EXCEPTION 'requester_not_admin' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Separation of duties: org_admin holds no data role and vice versa.
  IF (q.role_key = 'org_admin' AND EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = q.user_id
        AND ur.role_key <> 'org_admin' AND ur.valid @> pg_catalog.now()))
     OR (q.role_key <> 'org_admin' AND EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = q.user_id
        AND ur.role_key = 'org_admin' AND ur.valid @> pg_catalog.now())) THEN
    RAISE EXCEPTION 'separation_of_duties' USING ERRCODE = 'check_violation';
  END IF;
  IF actor = q.user_id OR actor = q.requested_by THEN
    RAISE EXCEPTION 'second_approver_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = q.user_id AND ur.role_key = q.role_key
             AND ur.location_id IS NOT DISTINCT FROM q.location_id AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'role_already_held' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.user_role (user_id, role_key, location_id, created_by, approved_by)
  VALUES (q.user_id, q.role_key, q.location_id, q.requested_by, actor);
  UPDATE eureka.role_request SET status = 'approved', decided_by = actor, decided_at = pg_catalog.now()
    WHERE id = p_id;
  RETURN 'approved';
END $$;

CREATE OR REPLACE FUNCTION authz.admin_set_user_status(p_user uuid, p_active boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE was_admin boolean; actor uuid;
BEGIN
  actor := authz.admin_guard(p_user);
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
  IF EXISTS (SELECT 1 FROM eureka.reporting_line rl WHERE rl.manager_id = p_user AND rl.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'has_reports' USING ERRCODE = 'check_violation';
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
  UPDATE eureka.reporting_line SET valid = authz.ended(valid)
    WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  -- Pending requests for or by this user can no longer be approved.
  UPDATE eureka.role_request SET status = 'rejected', decided_by = actor, decided_at = pg_catalog.now()
    WHERE status = 'pending' AND (user_id = p_user OR requested_by = p_user) AND user_id <> actor;
  UPDATE eureka.session SET revoked_at = pg_catalog.now() WHERE user_id = p_user AND revoked_at IS NULL;
  IF was_admin THEN
    PERFORM authz.assert_admin_remains();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION authz.revoke_role(p_user uuid, p_role text, p_location uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer; actor uuid;
BEGIN
  actor := authz.admin_guard(p_user);
  UPDATE eureka.user_role SET valid = authz.ended(valid)
    WHERE user_id = p_user AND role_key = p_role
      AND (p_location IS NULL OR location_id = p_location)
      AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'role_not_held' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_role = 'org_admin' THEN
    UPDATE eureka.role_request SET status = 'rejected', decided_by = actor, decided_at = pg_catalog.now()
      WHERE status = 'pending' AND requested_by = p_user AND user_id <> actor;
    PERFORM authz.assert_admin_remains();
  END IF;
  RETURN n;
END $$;

RESET ROLE;
