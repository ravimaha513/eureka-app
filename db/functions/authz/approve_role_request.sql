-- authz.approve_role_request: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0013, 0018, 0084. Change this file, not a new migration.

-- 0311: branches on role traits (authz.user_has_trait), never on the role key (docs/roles-api.md).
SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.approve_role_request(p_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
  -- The requester must still be an admin.
  IF NOT authz.user_has_trait(q.requested_by, 'admin') THEN
    RAISE EXCEPTION 'requester_not_admin' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The role may have been archived or bound to a department since the request.
  PERFORM authz.role_grantable(q.role_key, q.user_id);
  -- Separation of duties: an admin role is held with no data role and vice versa.
  PERFORM authz.role_separation(q.role_key, q.user_id);
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
END $function$;

REVOKE ALL ON FUNCTION authz.approve_role_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.approve_role_request(uuid) TO eureka_app;
RESET ROLE;
