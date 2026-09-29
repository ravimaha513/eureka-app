# Eureka App: Implementation Plan

Version 0.1 · September 2026 · Related: Eureka App SRS v0.1, System Design v0.3

## Summary

Eureka is built in five phases. The MVP is the end of Phase 2. At that point Sales, Location Admins and the Interview Coaching Team stop using the Hot List, interview and placement sheets. Authentication, the authorization engine and database row-level security come first, in Phase 1. Every later feature is built on top of them and inherits their tests.

**Planning assumptions:**
- Team: 3 full-stack engineers, 1 QA/automation engineer, a part-time designer and a product owner from Sales operations.
- Two-week sprints.
- The durations below are estimates for that team and should be re-planned after Phase 1.

| Phase | Name | Duration | Outcome |
|---|---|---|---|
| 0 | Foundations | 2 weeks | Repo, CI, environments, database baseline, walking skeleton |
| 1 | Identity and access | 3 weeks | SSO, sessions, RBAC engine, RLS, admin for users/teams/roles, audit |
| 2 | **MVP: Sales core** | 6 weeks | Candidates, Hot List, submissions, interview board and feedback, placements, dashboard; data migrated from sheets |
| 3 | Operations | 5 weeks | Paperwork, BGC, visa, employees, joinings and exits, notifications |
| 4 | Finance and insight | 4 weeks | Payments, recruiter performance, batch planning, reports and exports |
| 5 | Hardening and scale | ongoing | Performance, security review, penetration test, evolution items from design A10 |

## How we build: tests alongside code

These rules apply in every phase:

1. **Authorization first in every feature.** A new endpoint is incomplete until:
   - its permission and scope are in the catalog
   - its SRS golden expectations exist
   - its rows in the generated authorization matrix pass
   - its table has RLS enabled and forced, with a differential test
2. **Definition of done** for a story:
   - unit tests for domain logic
   - integration tests against real PostgreSQL
   - authorization matrix rows for every role
   - mass-assignment tests for write endpoints
   - OpenAPI updated
   - audit events for sensitive actions
   - a Playwright journey for new screens
3. **CI gates on every pull request:**
   - typecheck, lint
   - unit, integration and RLS tests
   - RLS coverage check
   - matrix tests
   - OpenAPI breaking-change check
   - dependency, secret and CodeQL scans
   - no merge on red
4. **Nightly:** Playwright per-role journeys on staging, ZAP baseline scan, restore-from-backup check (weekly).
5. **Fictional data only** in dev and staging; production data never leaves production.

## Phase 0: Foundations (2 weeks)

**Goal:** a deployable walking skeleton, where a request travels browser → API → PostgreSQL → back in dev and staging, with CI enforcing quality from the first commit.

**Scope:**
- Monorepo (pnpm workspaces): `apps/api` (NestJS), `apps/web` (React + Vite), `packages/shared`, `db/migrations`.
- CI in GitHub Actions: install, typecheck, unit tests, integration tests with a PostgreSQL service container, CodeQL, secret scanning, Dependabot.
- Terraform for dev and staging:
  - VPC and private subnets
  - RDS PostgreSQL
  - ECS Fargate services for API and worker
  - ALB
  - CloudFront and S3 for the SPA
  - WAF
  - KMS keys
  - Secrets Manager
  - GitHub OIDC deploy role
- Migration runner, baseline schema, database roles (`eureka_app`, `eureka_worker`, `authz_definer`) and the RLS coverage check.
- Structured logging, request ids, OpenTelemetry, health endpoints.
- **Spike (design N6):** can Google OIDC prove a fresh sign-in (`max_age`, `auth_time`)? Decide between Google step-up and in-app WebAuthn step-up.

**Exit criteria:**
- `GET /api/health` is served in staging through CloudFront, the ALB and ECS, and reads from RDS.
- CI runs in under 10 minutes and blocks merges on failure.
- The step-up approach is decided and recorded as an ADR.

**Tests introduced:** CI pipeline, migration test (up from empty), RLS coverage check (passes trivially).

## Phase 1: Identity and access (3 weeks)

**Goal:** every user signs in with their company Google account and receives exactly the data and actions their role allows. This is enforced twice, in the API and in PostgreSQL, and proven by tests before any business screen exists.

**Scope:**
- Google OIDC sign-in through the BFF:
  - server-side sessions, CSRF protection, idle and absolute timeouts
  - logout
  - revoke on deactivation
  - `access_version` checks
- Org model:
  - locations, teams, team membership, reporting lines, reporting closure (with triggers, cycle check and advisory lock), coach assignments
  - team invariants
- Authorization:
  - catalog and engine (already started in `packages/shared`)
  - NestJS guard, request-scoped transaction with `set_config('eureka.user_id', …)`
  - `authz` schema functions with hardening
  - RLS on the first protected tables (person, candidate)
  - column allowlist trigger
- Admin screens:
  - users, role assignment (no self-change, second approver for restricted roles)
  - teams and reporting lines
- Audit: append-only `audit_event`, nightly export to an Object Lock bucket.
- Web app shell:
  - login
  - role-aware navigation from `GET /api/v1/me`
  - empty states for each module

**Exit criteria:**
- 16 roles are seeded from the catalog.
- The SRS golden expectations and the generated authorization matrix pass for `/me`, `/admin/*` and `/candidates` (read).
- Differential RLS tests show that the database alone returns the same candidate rows as the application.
- Security review sign-off on the auth flows (internal).

**Tests introduced:**
- session and CSRF tests
- OIDC callback tests with a mock provider
- scope resolution tests against real org data
- RLS differential tests
- column-trigger tests
- admin self-escalation tests
- Playwright: sign-in as each role and see the correct navigation

## Phase 2: MVP, Sales core (6 weeks)

**Goal:** Sales, Location Admins and Interview Coaches run their daily work in Eureka instead of the Hot List, Interview Monitoring and Placements sheets.

**Scope (SRS references):**
- Candidates and batches: FR-CAN-01 to 10, including the timeline, resumes and duplicate check.
- Hot List with saved views, filters, bulk actions, quick view and export (FR-HOT-01 to 07).
- Submissions pipeline with the state machine and 90-day duplicate warning (FR-SUB-01 to 06).
- Interview board:
  - cleared toggle, links and consent flag
  - candidate feedback email one hour after the interview and the public feedback form
  - location admin and coach feedback
  - conflict check
  - (FR-INT-01 to 10)
- Placements:
  - form with paperwork checklist creation
  - first-placement detection
  - notifications to HR, Accounts and Immigration (FR-PLC-01 to 07)
- Role dashboards (manager, lead, location) with activity counts and "needs attention".
- Worker: outbox relay, `pg-boss` queue, feedback-email job, SES integration.
- **Data migration:**
  - CSV import pipeline with normalization, cross-sheet matching and review queues
  - reconciliation report
  - two-week parallel run with the sheets read-only

**Exit criteria (MVP launch):**
- All Phase 2 FRs are accepted by the product owner against the Given/When/Then criteria.
- The sheets are migrated with reconciliation signed off. Sales users are trained.
- Hot List and interview board meet p95 < 500 ms at 120 concurrent users and 50k candidates (k6).
- There are no open high or critical findings from ZAP, CodeQL or dependency scans.
- Restore from backup has been tested within the RTO.

**Tests introduced:**
- state-machine tests
- feedback token tests (GET does not consume; single use; expiry)
- duplicate-check oracle tests
- mass-assignment tests for all write endpoints
- export masking tests
- Playwright journeys:
  - recruiter logs a submission and interview
  - lead sees the team pipeline
  - location admin clears an interview
  - coach sees coached teams only
  - candidate submits feedback
- k6 load test
- migration dry-run tests

## Phase 3: Operations (5 weeks)

**Goal:** HR, Immigration, Accounts and the Documents Team manage paperwork, background checks, work authorization and employment in Eureka, with automatic reminders.

**Scope:**
- Documents: quarantine upload, malware scan and promotion, restricted-document access with step-up and access log (FR-PPR-01 to 03).
- Paperwork and onboarding checklists per placement type.
- BGC records and status, including "BGC failed" after the fact (FR-BGC-01 to 03, FR-PLC-06).
- Work authorization with encrypted numbers, expiry notices (FR-VIS-01 to 04).
- Employees, assignments, project exit → bench → reassignment flow, and joinings/exits reports (FR-EMP-01 to 09).
- Notification jobs FR-NTF-02 to 05 and 09 to 11; in-app inbox.
- Field encryption with KMS data keys, blind index for DOB, key rotation job.

**Exit criteria:**
- A restricted document can be viewed only by HR, Accounts and Immigration after step-up, and each view appears in the audit export.
- The paperwork and onboarding flow is used end to end on a real placement in staging.
- All Phase 3 notification jobs are tested with time-travel tests.

**Tests introduced:**
- upload flow tests (type, size, quarantine, infected path)
- step-up tests
- encryption and rotation tests
- worker-role RLS tests
- notification time-travel tests
- Playwright: HR opens a restricted document with step-up

## Phase 4: Finance and insight (4 weeks)

**Goal:** Accounts tracks vendor payments with automatic delay alerts, and leadership sees performance and batch-planning reports scoped to their role.

**Scope:**
- Invoices and payments; derived status; first-payment and delay notifications (FR-PAY-01 to 06, FR-NTF-07, 08).
- Incentive calculation once OD-02 is decided.
- Recruiter performance with targets and alerts (FR-PRF-01 to 04, FR-NTF-06).
- Batch planning for the CEO; joinings and exits and placement reports; exports (FR-RPT-01 to 11).
- Preferred vendors (FR-VEN-01 to 03); sample profiles once OD-06 is defined.

**Exit criteria:**
- Report totals match hand-calculated fixtures for each role scope.
- Exports are capped, masked and audited.

**Tests introduced:** date-math tests (expected date, delay days), report scope tests per role, export tests.

## Phase 5: Hardening and scale (ongoing)

- External penetration test and remediation before the Phase 3 go-live of restricted documents.
- Performance tuning from production telemetry; read replica if report load requires it.
- Evolution items from design A10 as triggers occur (OpenSearch, SQS/MSK, service extraction, second IdP).
- Accessibility audit (WCAG 2.1 AA) of the main screens.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Hot List visibility rule (AS-07) or D-01 changes after build | Rework in authorization | Rules live in one catalog and one engine; golden tests make changes explicit |
| Messy sheet data (dates, duplicates, colors) | Migration slips | Start the import pipeline in Phase 1 alongside auth work; weekly dry runs |
| Google step-up not verifiable | Restricted access weaker | Phase 0 spike; WebAuthn fallback |
| Adoption: users keep using sheets | Split data | Sheets read-only after parallel run; dashboards that save time from day one |
| Scope creep from open SRS questions | MVP delay | Product owner decides by the start of each phase; open decisions tracked in design B10 |

## Decisions needed before each phase

| Before | Decision |
|---|---|
| Phase 1 | OD-01 (Hot List rule), D-01, D-02, OD-07 (recruiter move) |
| Phase 2 | OD-05 (thresholds and targets), statuses and row-color mapping for migration (SRS Q6) |
| Phase 3 | OD-03 (retention), OD-04 (DOB visibility) |
| Phase 4 | OD-02 (incentive formula), OD-06 (sample profile) |

## Progress so far

The authorization catalog and engine from Phase 1 have been started ahead of schedule, because every other phase depends on them. The following is in `packages/shared/src/authz`:
- the catalog: 16 roles, 42 permissions, scoped grants
- the engine: scope resolution, visibility rules, field policy
- 55 unit and SRS-golden tests
