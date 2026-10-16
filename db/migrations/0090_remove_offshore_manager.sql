-- Remove the Offshore Office Manager role (2026-10-07, owner decision: not part of
-- the company's org chart). The role is gone from the catalog, so seedCatalog no
-- longer writes its role_permission rows and the API ignores it (access.service
-- filters unknown keys; the admin schemas refuse it). The eureka.role row stays:
-- user_role and role_request history reference it.
--   * Current and future grants end now (same rule as authz.ended / revoke_role); the
--     statement trigger bumps access_version, so open sessions reload access.
--   * Pending requests for the role expire.
SET search_path = eureka, public;
-- authz_definer: column grants on user_role.valid and role_request.status, and the
-- definer_update policy (role_request forces RLS, so its owner would match no row).
SET ROLE authz_definer;

UPDATE eureka.user_role
  SET valid = CASE WHEN pg_catalog.lower_inf(valid) OR pg_catalog.lower(valid) <= pg_catalog.now()
                   THEN pg_catalog.tstzrange(pg_catalog.lower(valid), pg_catalog.now())
                   ELSE 'empty'::pg_catalog.tstzrange END
  WHERE role_key = 'offshore_manager'
    AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());

UPDATE eureka.role_request SET status = 'expired'
  WHERE role_key = 'offshore_manager' AND status = 'pending';

SET ROLE eureka_owner;
UPDATE eureka.role SET label = 'Offshore Office Manager (removed)'
  WHERE key = 'offshore_manager';

RESET ROLE;
