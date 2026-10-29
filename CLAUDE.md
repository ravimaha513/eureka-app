# Eureka App

Internal talent-ops platform. pnpm monorepo, Node 22+, Postgres 16.

## Layout
- `packages/shared` — authz catalog (roles, permissions, scoped grants) + engine
- `apps/api` — NestJS API + worker. `src/modules/<area>/{<area>.controller,service,schemas}.ts`; `src/platform/` = auth, db, audit, mail, storage; `src/db/` = migrate + dev seeds; `test/*.int.test.ts` = integration
- `apps/web` — React + Vite. `src/<area>/`; `e2e/` = Playwright
- `db/migrations/00NN_*.sql` — append-only, checksum-pinned. Next number = highest + 1 (`ls db/migrations | tail -1`). Functions with a file in `db/functions/` are edited there, never in a new migration
- `infra/` — Terraform/Terragrunt (AWS compute currently deleted; ignore unless asked)

## Commands
- `pnpm local` — full stack (Docker PG :55432, API :3000, web :5173)
- `pnpm -r typecheck` and `pnpm -r test` before commit
- API tests: `pnpm test:api` (full suite, ~4 min) or `pnpm test:api test/<file> --reporter=dot`. Starts the throwaway tmpfs Postgres `testdb` on :55433 (durability off, 600 connections); the dev DB on :55432 allows only 100, too few for the default fork count. Migrated template is cached by hash (`TEST_FRESH_TEMPLATE=1` rebuilds); `TEST_MAX_FORKS` caps parallelism. Don't run web + api suites at once
- A file too slow to run alone gets split: cases module + `<name>.N.api.int.test.ts` shard files (`test/shard.ts`, e.g. mass-assignment)

## Parallel sessions
Several Claude sessions work this repo at once. The SessionStart hook (`scripts/session-brief.sh`) prints worktrees, open PRs and taken migration numbers; trust it over any doc. Re-run it before picking a migration number.
- One worktree + one branch per session. Never edit files in another session's worktree; the main checkout is for merging/review only
- Migrations: take the brief's "next free block" (multiples of 10, e.g. 0200) and use numbers inside it only. Open a draft PR right after creating the first migration so the block shows as taken
- Hot files (`packages/shared/src/authz/catalog.ts`, `apps/api/src/app.module.ts`, `apps/web/src/nav.ts`, `apps/web/src/api.ts`, `styles.css`, `docs/design.md`): merge `origin/main` first, keep edits small. New API docs go in `docs/<area>-api.md`
- Handoff lives in the PR description, updated before you stop:
  ```
  ## Handoff
  Done: …   Left: …   Gotchas: …   Migrations: 02x0–02x9 (used: …)
  ```
  Unfinished work: push + draft PR, never only local. Pick up someone's work with `gh pr view N`
- On merge, add one line to `docs/HANDOFF.md` "Built"; nothing else there per session

## Token hygiene
- Big files — grep or read a range, never whole: `docs/design.md` (100K), `docs/HANDOFF.md` (30K), `apps/web/src/styles.css`, `apps/api/test/mass-assignment.cases.ts`, large migrations
- `docs/<area>-api.md` documents each module; read the one you need, not all
- Pipe noisy output: `... 2>&1 | tail -40`, or `grep -E 'FAIL|Error'`
- Never read `pnpm-lock.yaml`, `node_modules`, `dist`, `.terraform*`, `.terragrunt-cache`

## Rules (do not regress; detail in `docs/HANDOFF.md` "How to work")
1. plpgsql `IF` NULL-safe (`coalesce`, `IS DISTINCT FROM`)
2. Functions in `authz`/`eureka`: `REVOKE ALL FROM PUBLIC`, `SET search_path = pg_catalog, pg_temp`, EXECUTE to exactly the needed role
3. RLS read policies: no per-row definer calls; use InitPlan `= ANY ((SELECT authz.x(..))::uuid[])` for small sets, `IN (SELECT unnest(...))` for large
4. Clients never set server-managed columns (BEFORE INSERT guards)
5. No rates/phones/emails/free text/recording links in `audit_event` or `outbox_event`
6. Sensitive writes only via SECURITY DEFINER functions re-checking permission + scope; API checks too (404 not visible, 403 not allowed)
7. Migrations must apply as non-superuser (RDS master)
8. E2E selects: `getByRole("combobox", { name, exact: true })`
