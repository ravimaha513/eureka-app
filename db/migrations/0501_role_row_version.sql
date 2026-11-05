-- Optimistic concurrency on role edits (docs/roles-api.md "Concurrency"; api review C-02, roadmap R-10
-- phase 1). PUT /admin/roles/:key/grants and PATCH /admin/roles/:key take an optional If-Match with the
-- rowVersion from GET /admin/roles; a stale one is refused (412) inside the definer function, under the
-- role's row lock, so the check and the write are atomic. Without the header nothing changes.
-- authz.role_set_grants and authz.role_update gain a p_expected_version argument (DEFAULT NULL, so the
-- two-argument calls still resolve): the signature change needs the DROP here; the db/functions files
-- create the new versions. Nothing else calls either function.

SET ROLE eureka_owner;
ALTER TABLE eureka.role ADD COLUMN row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1);
RESET ROLE;

-- Server-managed: only the definer functions bump it (rule 4); eureka_app has SELECT on role only.
GRANT UPDATE (row_version) ON eureka.role TO authz_definer;

SET ROLE authz_definer;
DROP FUNCTION IF EXISTS authz.role_set_grants(text, jsonb);
DROP FUNCTION IF EXISTS authz.role_update(text, jsonb);
RESET ROLE;
