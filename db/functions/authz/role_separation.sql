-- authz.role_separation: current definition (repeatable; db/functions/README.md).
-- Admin is only admin (AD-3a; docs/roles-api.md "Admin separation"; migrations 0470, 0480).
-- Called by request_role and approve_role_request (single grant, bulk import, approvals) before
-- they write eureka.user_role. Raises, when granting p_role to p_user:
--   role_violates_admin_separation: p_role itself breaks the role-level rule of 0470
--     (authz.role_admin_conflicts: admin-only permission without the admin trait, or a business
--     permission on an admin-trait role). Legacy roles like that stay held but are not granted again;
--   separation_of_duties: the grant would mix classes (authz.role_classes): an admin role for a
--     user holding a data role, or a data role for a user holding an admin role.
--     admin_compatible_only roles go with either.
-- Volatile on purpose: it takes a per-user advisory lock and a share lock on the role (role_set_grants
-- holds FOR UPDATE), then checks with fresh snapshots, so concurrent grants and grant edits serialise.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.role_separation(p_role text, p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE cls text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.user_role:' || coalesce(p_user::text, '')));
  PERFORM 1 FROM eureka.role ro WHERE ro.key = p_role FOR SHARE;
  IF EXISTS (SELECT 1 FROM authz.role_admin_conflicts() c WHERE c.role_key = p_role) THEN
    RAISE EXCEPTION 'role_violates_admin_separation' USING ERRCODE = 'check_violation';
  END IF;
  -- Unknown role (callers check first): treated as a data role.
  cls := coalesce((SELECT c.classification FROM authz.role_classes() c WHERE c.role_key = p_role), 'data');
  IF cls IN ('admin', 'data') AND EXISTS (
       SELECT 1 FROM eureka.user_role ur JOIN authz.role_classes() c ON c.role_key = ur.role_key
        WHERE ur.user_id = p_user AND ur.valid @> pg_catalog.now()
          AND c.classification = CASE cls WHEN 'admin' THEN 'data' ELSE 'admin' END) THEN
    RAISE EXCEPTION 'separation_of_duties' USING ERRCODE = 'check_violation';
  END IF;
END $function$;

REVOKE ALL ON FUNCTION authz.role_separation(text, uuid) FROM PUBLIC;
RESET ROLE;
