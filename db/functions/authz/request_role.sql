-- authz.request_role: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0013, 0018, 0084. Change this file, not a new migration.

-- 0311: branches on role traits (authz.user_has_trait), never on the role key (docs/roles-api.md).
SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.request_role(p_user uuid, p_role text, p_location uuid)
 RETURNS TABLE(request_id uuid, request_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid; r record; req uuid;
BEGIN
  actor := authz.admin_guard(p_user);
  PERFORM authz.admin_user_status(p_user);
  SELECT ro.is_location_bound, ro.is_restricted INTO r FROM eureka.role ro WHERE ro.key = p_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_role' USING ERRCODE = 'check_violation';
  END IF;
  -- Archived roles and department-bound roles outside the user's department (docs/roles-api.md).
  PERFORM authz.role_grantable(p_role, p_user);
  -- Separation of duties: an admin role is held with no data role and vice versa.
  PERFORM authz.role_separation(p_role, p_user);
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
END $function$;

REVOKE ALL ON FUNCTION authz.request_role(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.request_role(uuid, text, uuid) TO eureka_app;
RESET ROLE;
