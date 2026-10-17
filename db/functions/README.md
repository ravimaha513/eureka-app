# Repeatable function files

Each file holds the **current** definition of one SQL function: `SET ROLE <owner>`, the
`CREATE OR REPLACE FUNCTION`, its `REVOKE`/`GRANT`s, `RESET ROLE`. `migrate.ts` applies the
versioned migrations first, then every file here whose checksum differs from the last applied one
(tracked in `public.schema_function`), then seeds the catalog.

Why: functions such as `authz.notification_recipients` used to be copied whole into each new
migration. Slices written in parallel each replaced the body, and the last one silently dropped the
others' branches (repaired in 0180). An edit here is a normal diff that git can show and conflict on.

Rules (enforced by `apps/api/src/db/migrate.test.ts`):

- A function that has a file here is changed only here. A migration after 0180 must not
  `CREATE [OR REPLACE] FUNCTION` it.
- One function per file, at `<schema>/<name>.sql`, keeping `SET search_path`, `SECURITY DEFINER`
  and the grants of the original (design rule 2: no PUBLIC execute, granted to exactly the callers).
- Changing the signature or return type needs a `DROP FUNCTION` in a versioned migration first
  (`CREATE OR REPLACE` cannot change either); this file then creates the new one. Policies or
  later migrations that call the old signature must be updated in that same migration.
- Moving another function here: copy `pg_get_functiondef()` from a migrated database, add the
  owner and grants, and check that `pg_get_functiondef` and `proacl` match before and after.
