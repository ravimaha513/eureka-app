-- Admin/data separation for roles (docs/roles-api.md "Admin separation"; security review C-01,
-- roadmap R-01 as adjusted by the owner: one admin may still grant admin roles alone, no second
-- approver). From now on:
--   * the admin-only permissions (catalog ADMIN_PERMISSIONS: access:manage, audit:read) go only to
--     roles with the admin trait;
--   * a role with the admin trait holds nothing else but the admin-compatible permissions (catalog
--     ADMIN_COMPATIBLE_PERMISSIONS: staff directory, reference data, chat), i.e. no business data (AD-1);
--   * authz.admin_guard, which gates every admin, import and approval function, also requires the
--     admin trait, so a mis-built role carrying access:manage cannot pass it.
-- authz.role_create / role_update / role_set_grants (db/functions) refuse changes that would add a
-- violation. Custom roles that already break the rule are NOT changed: this migration raises a
-- WARNING per role, and GET /admin/roles/violations (authz.role_admin_violations) lists them.

SET ROLE eureka_owner;
ALTER TABLE eureka.permission
  ADD COLUMN is_admin_only boolean NOT NULL DEFAULT false,
  ADD COLUMN is_admin_compatible boolean NOT NULL DEFAULT false;
-- seedCatalog (apps/api/src/db/migrate.ts) rewrites both flags from the catalog after every run;
-- set them here too so the report below is right on an existing database.
UPDATE eureka.permission SET
  is_admin_only = key IN ('access:manage', 'audit:read'),
  is_admin_compatible = key IN ('staff.contact:read', 'technology:create', 'chat:use');
RESET ROLE;

SET ROLE authz_definer;

-- Caller must hold access:manage (org) AND the admin trait, and must not be the target (AD-1, AD-2).
-- Internal: not executable by the API role; called by the admin definer functions.
CREATE OR REPLACE FUNCTION authz.admin_guard(p_target uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF actor IS NULL OR NOT coalesce(authz.has_org('access:manage'), false)
     OR NOT coalesce(authz.user_has_trait(actor, 'admin'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_target IS NOT NULL AND p_target = actor THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN actor;
END $$;
REVOKE ALL ON FUNCTION authz.admin_guard(uuid) FROM PUBLIC;

-- Every (role, permission) pair that breaks the separation. Internal (owner only): the report below
-- and authz.role_admin_violations read it.
CREATE FUNCTION authz.role_admin_conflicts()
 RETURNS TABLE(role_key text, permission text)
 LANGUAGE sql STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
  SELECT rp.role_key, rp.permission
    FROM eureka.role_permission rp
    JOIN eureka.role r ON r.key = rp.role_key
    JOIN eureka.permission p ON p.key = rp.permission
   WHERE CASE WHEN r.is_admin THEN NOT (p.is_admin_only OR p.is_admin_compatible) ELSE p.is_admin_only END
$$;
REVOKE ALL ON FUNCTION authz.role_admin_conflicts() FROM PUBLIC;

-- GET /admin/roles/violations (access:manage): roles that break the separation, read-only. Role keys,
-- labels and permission keys only; holders counts active users holding the role now.
CREATE FUNCTION authz.role_admin_violations()
 RETURNS TABLE(role_key text, label text, is_system boolean, is_admin boolean, archived boolean, holders integer, permissions text[])
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
  PERFORM authz.admin_guard(NULL);
  RETURN QUERY
    SELECT r.key, r.label, r.is_system, r.is_admin, r.archived_at IS NOT NULL,
           (SELECT pg_catalog.count(DISTINCT ur.user_id) FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
             WHERE ur.role_key = r.key AND ur.valid @> pg_catalog.now() AND u.status = 'active')::integer,
           pg_catalog.array_agg(c.permission ORDER BY c.permission)
      FROM authz.role_admin_conflicts() c JOIN eureka.role r ON r.key = c.role_key
     GROUP BY r.key, r.label, r.is_system, r.is_admin, r.archived_at
     ORDER BY r.key;
END $$;
REVOKE ALL ON FUNCTION authz.role_admin_violations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.role_admin_violations() TO eureka_app;

-- Report, do not fail or strip (owner decision): one WARNING per role that already breaks the rule.
DO $$
DECLARE v record;
BEGIN
  FOR v IN SELECT c.role_key, pg_catalog.string_agg(c.permission, ', ' ORDER BY c.permission) AS perms
             FROM authz.role_admin_conflicts() c GROUP BY c.role_key ORDER BY c.role_key LOOP
    RAISE WARNING 'role % breaks admin/data separation (docs/roles-api.md): %', v.role_key, v.perms;
  END LOOP;
END $$;

RESET ROLE;
