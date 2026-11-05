---
name: eureka-migration
description: Add or review a versioned SQL migration in db/migrations. Use whenever adding a table, column, index, policy, grant, trigger or new function to the Eureka database, bumping a migration number, or reviewing a diff that adds db/migrations/00NN_*.sql — even if the user only says "add a column" or "store X".
---

# Eureka migration

Migrations are append-only and checksum-pinned once applied. A wrong number or an in-place edit
breaks every other session and staging. Follow these steps in order.

## 1. Pick the number

1. Re-run `scripts/session-brief.sh`. Trust its "Next free migration block" (a multiple of 10,
   e.g. `0470`) and "Taken on other branches" over any doc or memory.
2. Use numbers only inside your block: `0470`, `0471`, … `0479`.
3. File name: `db/migrations/0470_<snake_case_topic>.sql`.
4. Right after creating the first migration: commit, push, and open a **draft PR** so the block
   shows as taken for other sessions. Put `Migrations: 0470–0479 (used: 0470)` in the PR `## Handoff`.

## 2. Never edit, never copy functions

- Never change an applied migration (checksum test fails; staging diverges). Fix forward.
- If the function you need to change has a file in `db/functions/<schema>/<name>.sql`, edit that
  file instead (see the `eureka-definer-fn` skill). A migration after 0180 must not
  `CREATE [OR REPLACE] FUNCTION` such a function — `apps/api/src/db/migrate.test.ts` enforces it.
- A signature/return-type change: `DROP FUNCTION` in the migration, then the db/functions file
  creates the new one. Update callers (policies, other functions) in that same migration.
- Brand-new functions may be created in the migration (as 0461 does) or moved to db/functions.

## 3. File shape (copy from a recent migration, e.g. 0461)

```sql
-- <What and why, with doc refs: docs/<area>-api.md XX-n>. Note rule 5 if free text is involved.

SET ROLE eureka_owner;          -- tables, policies, guard triggers owned by eureka_owner
ALTER TABLE eureka.x ADD COLUMN ...;
CREATE POLICY ... ;             -- see eureka-rls-policy skill
RESET ROLE;

GRANT UPDATE (col_a, col_b) ON eureka.x TO authz_definer;   -- column-level, least privilege

SET ROLE authz_definer;         -- SECURITY DEFINER write functions owned by authz_definer
CREATE FUNCTION authz.update_x(...) ... ;                    -- see eureka-definer-fn skill
REVOKE ALL ON FUNCTION authz.update_x(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.update_x(...) TO eureka_app;
RESET ROLE;
```

## 4. Checklist (the rules reviews keep enforcing)

- [ ] Applies as a **non-superuser** (RDS master): no `ALTER SYSTEM`, no superuser-only
      extensions or settings, objects created under `SET ROLE <owner>`. CI checks this.
- [ ] Every plpgsql `IF` is NULL-safe: `coalesce(...)`, `IS DISTINCT FROM`, explicit `x IS NULL OR`.
- [ ] New functions: `REVOKE ALL ... FROM PUBLIC`, `SET search_path = pg_catalog, pg_temp`,
      EXECUTE granted to exactly one needed role; references schema-qualified (`pg_catalog.now()`).
- [ ] New tables: RLS enabled + forced, read policies follow rule 3 (InitPlan, never per-row
      definer calls), writes only via definer functions for sensitive tables.
- [ ] Server-managed columns (status, snapshots, timestamps, created_by, version) set by a
      BEFORE INSERT/UPDATE guard, never trusted from the client.
- [ ] No rates, phones, emails, free-text reasons or recording links reach `audit_event` /
      `outbox_event`.
- [ ] CHECK constraints on free text: length bounds and `!~ '[[:cntrl:]]'`.
- [ ] Indexes for new FK columns and policy predicates.

## 5. Verify

```bash
pnpm test:api test/migrate.int.test.ts --reporter=dot 2>&1 | tail -20
pnpm test:api src/db/migrate.test.ts --reporter=dot 2>&1 | tail -20   # numbering, checksum, db/functions rules
```

The migrated test template is cached by hash; set `TEST_FRESH_TEMPLATE=1` if results look stale.
Then run the module's `.db.int.test.ts` and `.api.int.test.ts` (see `eureka-test-run`).
