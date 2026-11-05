---
name: eureka-sql-review
description: Review a diff that touches SQL — db/migrations/*.sql, db/functions/**, or inline SQL in apps/api services — against Eureka's database rules. Use for "review this migration", "check my SQL", before committing any .sql change, or when a PR touches policies, grants, triggers or definer functions.
---

# Eureka SQL review

Get the diff: `git diff origin/main...HEAD -- db/ apps/api/src/**/*.ts`. Review each changed
statement against the rules below. Output one line per finding:
`path:line: <severity>: <problem>. <fix>.` Severity: `blocker` (security/data loss/breaks
migrate), `major` (perf/rule violation), `minor`. No praise, no style nits.

## Rules (from CLAUDE.md / docs/HANDOFF.md "How to work")

1. **NULL-safe IF** — every plpgsql `IF`/`ELSIF`/`WHEN`: does a NULL operand skip a security
   branch? Need `coalesce`, `IS DISTINCT FROM`, or `x IS NULL OR`. `IF NOT authz.has_perm(..)`
   without coalesce = blocker.
2. **Function hardening** in `authz`/`eureka`: `REVOKE ALL ... FROM PUBLIC`;
   `SET search_path = pg_catalog, pg_temp`; EXECUTE to exactly the needed role; owner via
   `SET ROLE authz_definer` / `eureka_owner`; unqualified identifiers in a definer body = blocker.
3. **RLS reads** — no per-row definer calls; InitPlan `= ANY ((SELECT ..)::uuid[])` for small
   sets, `IN (SELECT unnest((SELECT ..)))` for large; `EXISTS` by PK.
4. **Server-managed columns** (status, snapshots, timestamps, created_by, version) set by BEFORE
   INSERT/UPDATE guards; no client path writes them.
5. **No PII in events** — no rates, phones, emails, free-text reasons or recording links in
   `audit_event` / `outbox_event` payloads (ids, type keys, field names, dates only).
6. **Sensitive writes** only via SECURITY DEFINER functions that re-check permission + scope
   (404 not visible before 403 not allowed). Direct `GRANT INSERT/UPDATE` to `eureka_app` on a
   sensitive table = blocker.
7. **Non-superuser apply** — nothing needing superuser (RDS master).
8. **Migration hygiene** — number inside this session's block (`scripts/session-brief.sh`);
   no edit to an applied migration; no `CREATE OR REPLACE FUNCTION` for a function that has a
   `db/functions/` file; signature changes have a `DROP FUNCTION` and caller updates.

## Also check

- Least privilege: `org_admin` gains no business permission; column-level grants, not table-wide.
- Race conditions: check-then-insert without `FOR UPDATE` / advisory lock / unique constraint.
- Free-text columns have length CHECK and `!~ '[[:cntrl:]]'`.
- FKs and policy predicate columns indexed.
- `ON DELETE` behaviour consistent with `authz.delete_candidate` / anonymisation paths.
- Error messages map to an HTTP code in the module's `<area>.errors.ts`.
- Tests: `.db.int.test.ts` covers deny paths and NULL inputs for each new function/policy.

End with a one-line verdict: `ship` / `fix blockers first`.
