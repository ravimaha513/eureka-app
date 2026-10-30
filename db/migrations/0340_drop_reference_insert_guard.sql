-- Staging carries BEFORE INSERT triggers on client, vendor and implementation_partner
-- (eureka.reference_insert_guard) from an unmerged import branch's migration
-- 0086_import_team_workbook. They refuse authz_definer inserts outside an import, so
-- authz.create_client / authz.create_vendor (0320, the one write path) fail with
-- server_managed_field and "Add a new client/vendor…" never works there. Main never
-- defined them; drop them wherever they exist. No-op on databases built from main.

DROP TRIGGER IF EXISTS client_insert_guard ON eureka.client;
DROP TRIGGER IF EXISTS vendor_insert_guard ON eureka.vendor;
DROP TRIGGER IF EXISTS implementation_partner_insert_guard ON eureka.implementation_partner;

-- The trigger function goes too when this role may drop it (owner or member of the owner).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'eureka' AND p.proname = 'reference_insert_guard' AND p.pronargs = 0
               AND pg_catalog.pg_has_role(p.proowner, 'USAGE')) THEN
    DROP FUNCTION eureka.reference_insert_guard();
  END IF;
END $$;
