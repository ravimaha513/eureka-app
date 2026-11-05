-- "Admin is only admin" per user (owner decision 2026-11-05; docs/roles-api.md "Admin separation",
-- docs/admin-api.md AD-3a; follows 0470). Role classes:
--   * admin: the role has the admin trait (eureka.role.is_admin), whatever it holds;
--   * admin_compatible_only: no admin trait, and every permission it holds is admin-compatible
--     (catalog ADMIN_COMPATIBLE_PERMISSIONS: staff directory, reference data, chat), or none;
--   * data: every other role, i.e. no admin trait and at least one other permission (a business
--     permission, or an admin-only one on a role that should not carry it).
-- A user holds admin roles or data roles, never both; admin_compatible_only roles go with either.
-- authz.role_separation (db/functions), called by request_role and approve_role_request (single
-- grant, bulk import, approvals), refuses a grant that would mix them (separation_of_duties) and a
-- role that itself breaks the role-level rule of 0470 (role_violates_admin_separation).
-- The trigger below stops the other way in: adding a business permission to a custom
-- admin_compatible_only role that an admin holds (role_held_by_admin).
-- Users who already mix are NOT changed: one WARNING per user (ids only), and
-- GET /admin/users/violations (authz.user_admin_violations) lists them.

SET ROLE authz_definer;

-- Class of every role (definition above). Plain SQL, invoker rights: GET /admin/roles reads it as
-- eureka_app, which can read these reference tables anyway (0311).
CREATE FUNCTION authz.role_classes()
 RETURNS TABLE(role_key text, classification text)
 LANGUAGE sql STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
  SELECT r.key,
         CASE WHEN r.is_admin THEN 'admin'
              WHEN EXISTS (SELECT 1 FROM eureka.role_permission rp JOIN eureka.permission p ON p.key = rp.permission
                            WHERE rp.role_key = r.key AND NOT p.is_admin_compatible) THEN 'data'
              ELSE 'admin_compatible_only' END
    FROM eureka.role r
$$;
REVOKE ALL ON FUNCTION authz.role_classes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.role_classes() TO eureka_app;

-- Users whose current roles mix admin and data classes. Internal (owner only): the report below and
-- authz.user_admin_violations read it.
CREATE FUNCTION authz.user_admin_conflicts()
 RETURNS TABLE(user_id uuid, admin_roles text[], data_roles text[])
 LANGUAGE sql STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
  SELECT h.user_id,
         pg_catalog.array_agg(DISTINCT h.role_key ORDER BY h.role_key) FILTER (WHERE h.classification = 'admin'),
         pg_catalog.array_agg(DISTINCT h.role_key ORDER BY h.role_key) FILTER (WHERE h.classification = 'data')
    FROM (SELECT ur.user_id, ur.role_key, c.classification
            FROM eureka.user_role ur JOIN authz.role_classes() c ON c.role_key = ur.role_key
           WHERE ur.valid @> pg_catalog.now()) h
   GROUP BY h.user_id
  HAVING pg_catalog.bool_or(h.classification = 'admin') AND pg_catalog.bool_or(h.classification = 'data')
$$;
REVOKE ALL ON FUNCTION authz.user_admin_conflicts() FROM PUBLIC;

-- GET /admin/users/violations (access:manage): users holding admin and data roles at once, read-only.
-- Ids, display names, status and role keys only.
CREATE FUNCTION authz.user_admin_violations()
 RETURNS TABLE(user_id uuid, display_name text, status text, admin_roles text[], data_roles text[])
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
  PERFORM authz.admin_guard(NULL);
  RETURN QUERY
    SELECT c.user_id, u.display_name::text, u.status::text, c.admin_roles, c.data_roles
      FROM authz.user_admin_conflicts() c JOIN eureka.app_user u ON u.id = c.user_id
     ORDER BY u.display_name, c.user_id;
END $$;
REVOKE ALL ON FUNCTION authz.user_admin_violations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.user_admin_violations() TO eureka_app;

RESET ROLE;

SET ROLE eureka_owner;

-- A custom role that an admin holds stays admin_compatible_only: an INSERT that would give such a
-- role its first business permission is refused (role_held_by_admin). Roles that are already data
-- roles are not affected (no new mixing). The admin trait cannot change while a role is held
-- (role_update, role_in_use) and role_set_grants only updates scopes, so INSERT is the only way in.
-- System roles are left to the catalog: seedCatalog rewrites them, and catalog-consistency checks
-- that every non-admin system role is a data role.
CREATE FUNCTION eureka.role_permission_admin_holder_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (
       SELECT 1
         FROM (SELECT DISTINCT a.role_key FROM added a JOIN eureka.permission p ON p.key = a.permission
                WHERE NOT p.is_admin_compatible) n
         JOIN eureka.role r ON r.key = n.role_key AND NOT r.is_system AND NOT r.is_admin
        WHERE NOT EXISTS (
                SELECT 1 FROM eureka.role_permission rp JOIN eureka.permission p ON p.key = rp.permission
                 WHERE rp.role_key = n.role_key AND NOT p.is_admin_compatible
                   AND NOT EXISTS (SELECT 1 FROM added a WHERE a.role_key = rp.role_key AND a.permission = rp.permission))
          AND EXISTS (
                SELECT 1 FROM eureka.user_role ur
                  JOIN eureka.user_role ar ON ar.user_id = ur.user_id AND ar.valid @> pg_catalog.now()
                  JOIN eureka.role ad ON ad.key = ar.role_key AND ad.is_admin
                 WHERE ur.role_key = n.role_key AND ur.valid @> pg_catalog.now())) THEN
    RAISE EXCEPTION 'role_held_by_admin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION eureka.role_permission_admin_holder_guard() FROM PUBLIC;
CREATE TRIGGER role_permission_admin_holder_guard AFTER INSERT ON eureka.role_permission
  REFERENCING NEW TABLE AS added
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.role_permission_admin_holder_guard();

RESET ROLE;

-- Report, do not fail or strip (owner decision): one WARNING per user who already mixes. Ids only.
SET ROLE authz_definer;
DO $$
DECLARE v record;
BEGIN
  FOR v IN SELECT c.user_id, c.admin_roles, c.data_roles FROM authz.user_admin_conflicts() c ORDER BY c.user_id LOOP
    RAISE WARNING 'user % holds admin and data roles (docs/roles-api.md "Admin separation"): admin %, data %',
      v.user_id, v.admin_roles, v.data_roles;
  END LOOP;
END $$;
RESET ROLE;
