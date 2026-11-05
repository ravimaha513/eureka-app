-- authz.admin_create_location runs as authz_definer, like every other definer (rule 2; R-26,
-- docs/backend-audit/architecture.md G-11).
--
-- 0091 created it without SET ROLE, so it is owned by whoever ran the migration: the RDS master
-- user in staging and production. A SECURITY DEFINER function owned by the master runs with the
-- master's privileges (every table, role management) instead of the one INSERT it needs. The
-- catalog lint (apps/api/test/db-lint.db.int.test.ts) found it as the only definer in authz/eureka
-- not owned by authz_definer or eureka_owner. authz_definer gets exactly the columns the function
-- writes and the id it returns; the body, signature and EXECUTE grant (eureka_app) are unchanged.
-- ALTER OWNER is allowed here as non-superuser: the migrating user owns the function and is a
-- member of authz_definer (rule 7).

GRANT INSERT (name, kind, state, timezone) ON eureka.location TO authz_definer;
GRANT SELECT (id) ON eureka.location TO authz_definer;
ALTER FUNCTION authz.admin_create_location(text, text, text, text) OWNER TO authz_definer;
