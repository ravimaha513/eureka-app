-- Single-admin mode (2026-10-05, owner decision): an internal company with one
-- administrator cannot satisfy AD-3 (second approver for restricted roles).
--   * authz.policy_setting single_admin_mode = 'on' makes request_role apply a
--     restricted role at once (status 'applied', approved_by NULL: the table
--     check forbids approved_by = created_by) and lets the requester approve a
--     request that was left pending.
--   * No migration sets it. seedCatalog writes it from SINGLE_ADMIN_MODE=on|off
--     (default off) on every migrate run, so a deploy can turn the rule back on.
--   * Unchanged: an admin cannot change their own roles (admin_guard
--     self_change), the grantee never approves, org_admin holds no data role
--     and vice versa, the grantee must be active, every change is audited.
SET search_path = eureka, public;
SET ROLE authz_definer;

ALTER TABLE authz.policy_setting
  ADD CONSTRAINT policy_setting_single_admin CHECK (key <> 'single_admin_mode' OR value IN ('on', 'off'));

CREATE FUNCTION authz.single_admin_mode() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM authz.policy_setting s WHERE s.key = 'single_admin_mode' AND s.value = 'on')
$$;
REVOKE ALL ON FUNCTION authz.single_admin_mode() FROM PUBLIC;

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

  IF r.is_restricted AND NOT authz.single_admin_mode() THEN
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
  IF actor = q.user_id OR (actor = q.requested_by AND NOT authz.single_admin_mode()) THEN
    RAISE EXCEPTION 'second_approver_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = q.user_id AND ur.role_key = q.role_key
             AND ur.location_id IS NOT DISTINCT FROM q.location_id AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'role_already_held' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.user_role (user_id, role_key, location_id, created_by, approved_by)
  VALUES (q.user_id, q.role_key, q.location_id, q.requested_by,
          CASE WHEN actor = q.requested_by THEN NULL ELSE actor END);
  -- role_request CHECK: 'approved' needs decided_by <> requested_by; a self-approval is recorded as 'applied'.
  UPDATE eureka.role_request SET status = CASE WHEN actor = q.requested_by THEN 'applied' ELSE 'approved' END, decided_by = actor, decided_at = pg_catalog.now()
    WHERE id = p_id;
  RETURN 'approved';
END $$;
