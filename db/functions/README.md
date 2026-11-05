# Repeatable function files

Each file holds the **current** definition of one SQL function: `SET ROLE <owner>`, the
`CREATE OR REPLACE FUNCTION`, its `REVOKE`/`GRANT`s, `RESET ROLE`. `migrate.ts` interleaves the
two (one ordering, `planRun`, for fresh and incremental databases alike): a file whose checksum
differs from the last applied one (tracked in `public.schema_function`) is applied right after the
migration named on its `-- since: NNNN` line. A file without that line defaults to
`FUNCTIONS_BASELINE` (`0499`), i.e. after every migration up to 0499 — the historical
"migrations first, then functions" order. From 0500 on, add `-- since: NNNN` to a function file
whose body needs migration NNNN, so later migrations see the current body. The catalog is seeded
last. Each file runs with a reset session (`RESET ROLE`, `RESET ALL`, `DISCARD TEMP`).

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
