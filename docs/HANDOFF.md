# Handoff: state of Eureka and next tasks

Updated 2026-09-30. Read this first, then `docs/design.md`, `docs/implementation-plan.md`,
`docs/admin-api.md` and `docs/placements-api.md`.

## How to work in this repo

- `pnpm local` runs everything locally (Docker Postgres on 55432, seed, API :3000, web :5173).
- `pnpm -r typecheck` and `pnpm -r test` must pass before every commit (integration tests need
  PostgreSQL 16 at `TEST_PG_ADMIN_URL`, default `postgres://postgres:postgres@127.0.0.1:5432`).
- Browser journeys: `pnpm --filter @eureka/web e2e` against a running, freshly seeded stack.
- Migrations are append-only (`db/migrations/00NN_*.sql`, next is **0024**) and must apply as a
  non-superuser (Amazon RDS master): CI checks this.
- Commit small and atomic; get an independent review of every security-relevant change.

### Rules the reviews kept enforcing (do not regress)

1. Every plpgsql `IF` must be NULL-safe (`coalesce`, `IS DISTINCT FROM`, explicit `x IS NULL OR`).
2. Every function in schemas `authz`/`eureka`: `REVOKE ALL ... FROM PUBLIC`, pinned
   `SET search_path = pg_catalog, pg_temp`, EXECUTE granted to exactly the role that needs it.
3. RLS read policies never call definer functions per row; use
   `col = ANY ((SELECT authz.x('perm'))::uuid[])` (InitPlan) and `EXISTS` by primary key.
4. Clients never set server-managed columns (status, snapshots, timestamps): BEFORE INSERT guards.
5. No rates, phones, emails, free-text reasons or recording links in `audit_event` or `outbox_event`.
6. Writes to sensitive tables only through SECURITY DEFINER functions that re-check permission
   and scope in the database; the API checks too (read-before-write: 404 if not visible, 403 if not allowed).
7. Least privilege: `org_admin` holds no business role; restricted and org-wide-sensitive roles
   need a second approver; the worker role cannot become the API role.
8. E2E: form labels wrap their `<select>`, so address dropdowns with
   `getByRole("combobox", { name, exact: true })`, not `getByLabel(..., { exact: true })`.

## Built (on main, CI green)

- Sign-in (Google OIDC + dev sign-in), sessions, CSRF, 16-role RBAC enforced in API and RLS.
- Users & Access admin (roles with second approver, teams, reporting lines, team moves).
- Hot List (open to everyone, masked phones), candidates, profile with per-record `actions`.
- Submissions: state machine, duplicate warning, Submissions screen.
- Interviews: board API + screen, conflict check, consent, feedback; candidate feedback email
  (worker job) and public feedback form.
- Placements: schema (0022/0023), state machine, first-placement, assignments, outbox rows,
  idempotency keys, Placements screen and Create placement dialog; lookups with least privilege.
- Worker: lease-based job runner, nightly audit export to Object Lock storage.
- Outbox delivery (0024): placement events emailed to HR, Accounts, Immigration (one email per user per
  event, `outbox_delivery` dedupe marker, in-doubt never resent), daily prune of published rows
  (`OUTBOX_RETENTION_DAYS`, DB floor 7 days) and of Idempotency-Key rows older than 24 h. Enable with
  `OUTBOX_MAIL_MODE`, `OUTBOX_FROM_EMAIL`, `APP_PUBLIC_ORIGIN` (Terraform does not set them yet).
- AWS infra (~$30/month) and OIDC deploy workflow, never applied (see infra/README.md).

## Next tasks (Phase 2 to MVP), in suggested order

1. **(Done, see Built.) Outbox delivery job (worker):** grant the worker SELECT and UPDATE(published_at) on
   `outbox_event` with a narrow policy (the 0022 write guard currently blocks this); deliver
   `placement.created` / `placement.state_changed` to HR, Accounts and Immigration via SES; prune
   published rows after N days. Also a job deleting `idempotency_key` rows older than 24 h (add an index on created_at).
2. **Hot List extras:** saved views, bulk actions, export (capped, masked, audited).
3. **Candidate extras:** batches, resumes, `candidate_event` timeline, full duplicate check
   (email, phone, DOB blind index).
4. **Dashboards:** manager, lead and location views with activity counts and "needs attention".
5. **Sheet migration:** CSV import with normalization, cross-sheet matching, review queues,
   reconciliation report.
6. **Launch checks:** k6 load test (120 users, 50k candidates, p95 < 500 ms), ZAP baseline,
   restore-from-backup drill.
7. Fix older dialogs' focus after a failed submit (Create candidate, Log submission).

## Open product questions (ask Ravi, don't guess)

- Can recruiters see the rate on their own submissions/placements (they lack `rate:read`)?
- Can a submission skip steps? Should scheduling an interview advance the submission automatically?
- Placement: assignment start date = day marked `joined` or a user-entered date? Rate cap/unit for W2?
- May a candidate who failed BGC after joining be re-placed into the same job?
- Should the manual candidate edge `active → confirmation` be removed now that placements drive it?
- Does a pre-join `bgc_failed` count as an earlier placement for first-placement detection?
- Placement emails: should Associate HR (and the Lead/Manager, design C flow 3) also receive them, and may
  they name the candidate or client? Today: `hr`, `accounts`, `immigration` only, ids and statuses only.

## Waiting on Ravi (not code)

- One-time AWS bootstrap, Google Workspace domain, Google OAuth client (infra/README.md).
- Confirm the 3-year COMPLIANCE audit lock before the first production deploy (cannot be shortened).
