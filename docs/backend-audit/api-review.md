# Eureka backend — API quality review

> Part of the 2026-11-05 backend audit ([architecture.md](architecture.md) has the method and the module map).
> Scope: 355 routes in 39 controllers. Static review; no contract changes proposed without explicit approval.

## 1. Verdict

The API is **consistent where a reference implementation exists, and inconsistent where it was added later**.
`jobs` and `applications` are the reference implementations: strict zod bodies, keyset pagination, `If-Match` with 428/412, `Idempotency-Key` with a canonical request hash, RFC 9457 errors and capped, audited, rate-limited CSV exports. Many older or larger modules adopted only part of that pattern. The most valuable API work is therefore **convergence on patterns the codebase already has**, not new design.

## 2. Conventions scorecard

| Area | State | Evidence | Gap / finding |
|---|---|---|---|
| Resource naming | Good | Plural nouns under `/api/v1/<area>`; sub-resources (`/candidates/:id/timeline`, `/batches/:id/candidates/bulk`) | Action sub-resources (`/transition`, `/status`) are pragmatic and consistent. `GET /hotlist` lives in the candidates controller while the rest of Hot List is in `hotlist/`. |
| Versioning | Mostly | 46 controllers under `/api/v1` | `api/auth`, `api/portal/*`, `api/public/feedback` and `api/health` are unversioned. Acceptable for auth and health; version the portal before it has external consumers. |
| Pagination | Good, mostly keyset | Microsecond-exact keyset cursors (`pipeline.ts:37-45`), `limit ≤ 200` in 20 schemas | Several lists are **silently truncated** at 200/500/2000 or unpaginated (A-12, B-07, C-09, D-10). Pipeline report uses OFFSET to 10,000 (E-03). No total counts anywhere, which is fine for keyset; summaries are separate endpoints. |
| Filtering / search | Functional, not scalable | `likeContains` escapes `%`/`_` correctly (`platform/sql.ts`) | Every name search is a leading-wildcard ILIKE on `first_name \|\| ' ' \|\| last_name`, and no trigram index exists (A-05, B-06, G-04, E-09). See performance-review.md. |
| Sorting | Allow-listed | `sort=name\|days\|priority` enums; no column-name interpolation found (G: "no SQL injection surface") | Expression sort keys have no index, so each page sorts the filtered set (A-05). |
| Validation | Strong | 210 `.strict()` zod schemas; mass-assignment harness covers every POST/PUT/PATCH | DB-level length and control-character checks are missing on some core free-text columns (G-10). The xlsx import bounds only the compressed size (C-08). |
| Error format | Strong | RFC 9457 `application/problem+json` for all errors (`platform/errors.ts`), with coded module errors | DB timeout, serialization, deadlock and too-many-connections codes fall through to 500 (F-11). OIDC failures surface as 500 (F-05). Version conflicts return 409 in paperwork but 412/428 in payments and jobs (B-03). |
| Status codes | Good | Read-before-write gives 404 (not visible) then 403 (not allowed); 422 for rule violations; 409 for conflicts | Some error-mapping inaccuracies remain (A-13). |
| Idempotency | Partial | Honoured on 5 POSTs (jobs, payments, …) | Implemented four times with drift (F-07). Missing on `POST /submissions`, whose duplicate check is a non-locking warning (A-06), and on several create-style POSTs (B-11). |
| Optimistic concurrency | Partial | `If-Match` in 11 modules | Missing or optional on candidates, submissions, interviews, paperwork/BGC, admin role grants and bill void (A-02, B-03, C-02, D-13, E-04). Theme **R-10**. |
| Documentation | Hand-written | `docs/<area>-api.md` per module; good prose | **No OpenAPI.** No machine-checkable contract, so breaking changes can't be detected in CI. Feedback has no doc (D-11). |
| Rate limiting | Partial | In-memory per-task limiters; API Gateway/WAF; DB-wide caps for portal | Limits multiply with task count and reset on deploy (F-06). The feedback route is keyed on the raw IP instead of the /64 (D-01). Portal global caps can be exhausted cheaply (E-01). |
| Resource-level authz | Strong | Engine + RLS + definer re-check; 404 before 403 | Route coverage relies on convention: 36 routes have no decorator and pass for any signed-in user (F-08). Each was checked and **none was found exploitable**, but there is no meta-test (D-12, B-12). |
| Backward compatibility | Good discipline | Breaking-change notes in module docs | With no OpenAPI, nothing enforces it. Making `If-Match` mandatory would be a breaking change, so roll it out as optional, then enforced (R-10). |

### OpenAPI recommendation (not in top 15; listed as R-19)

* **Problem:** 355 routes are documented only in prose, so there is no contract diffing, no generated client for `apps/web/src/api.ts` (a hot file) and no API inventory (OWASP API9).
* **Recommendation:** The zod schemas already exist. Generate OpenAPI 3.1 from them with `zod-to-openapi` (one dev dependency, justified by the 355-route inventory and the contract-diff CI check it enables), and add a CI step that fails on unapproved breaking diffs.
* **Alternative:** `@nestjs/swagger` decorators. Rejected because it duplicates the zod schemas and drifts.
* **Complexity:** M (incremental per module). **Risk:** none at runtime if served only in non-prod. **Tests:** a snapshot test of the generated spec.

## 3. Focus areas

### Candidate search (`GET /api/v1/candidates`, `GET /api/v1/hotlist`)

* **Good:** keyset paging (≤200), allow-listed sort, escaped LIKE, RLS scope in InitPlan form, per-page audit on Hot List, 60/min limiter.
* **Gaps:** search and sort are not index-backed (A-05/G-04, **R-13**); the profile GET makes 6 sequential queries; the duplicate-check endpoint is limited to 20/min, but the bulk dry-run gives the same "does this contact exist" answer for about 5,000 contacts/min (A-01, **R-15**); candidate edits are last-write-wins (A-02, **R-10**); birth year is returned outside the field policy (A-10).

### Job applications (`/api/v1/applications`, `/applicants`, portal)

* **Good:** shared state machine (`nextApplicationStatuses`), `If-Match` required on status change (428/412), keyset, contact fields masked by `applicant:read` / `applicant.phone:read` in JSON.
* **Gaps:** the CSV export bypasses the email masking (A-04, **R-04**). Applicant emails are sent fire-and-forget after commit, which is acceptable, but the portal's deferred-work queue is unbounded and not drained on shutdown (E-07).

### Recruitment pipeline (submissions, interviews, placements, pipeline-report)

* **Good:** transitions pre-checked in TS and enforced in definer functions; placements is a clean state machine.
* **Gaps:** submissions have no `row_version` at all (A-02); `POST /submissions` is not idempotent (A-06); interview edits are lost-update prone and clear-and-select checks before it writes without a lock (E-04); coach and panel double-booking is not prevented (E-10); the pipeline report evaluates its full-history CTE twice and pages with OFFSET (E-03).

### Bulk updates

| Endpoint | Cap | Execution | Semantics | Finding |
|---|---|---|---|---|
| Hot List bulk actions | 100 ids, 10 req/min | **Sequential, one transaction and pool checkout per id** (~600 round trips) | Per-record result, documented partial success | A-03 (PROVEN) |
| `POST /batches/:id/candidates/bulk` | 500 rows | One long transaction, row by row | All-or-nothing; dry-run reveals duplicates | A-07, A-01 |
| Training bulk add students | 200 | Up to 200 sequential definer calls with savepoints | Per-row | D-04 (PROVEN) |
| Admin org-chart apply / user import | 100 moves / N rows | Each row rebuilds the whole reporting closure under a global advisory lock | All-or-nothing | C-03 (PROVEN path) |

**Recommendation (R-12):** keep each endpoint's documented semantics. Batch the visibility/authz read once (`WHERE id = ANY($1)` plus the scope predicate), then write with a SAVEPOINT per row in **one** transaction, and defer the closure rebuild to once per statement or transaction. That removes the N+1 without changing the contract.

## 4. API findings

| ID | Severity | Title |
|---|---|---|
| [A-02](#a-02--candidate-and-submission-edits-have-no-optimistic-concurrency-row_version-unused-or-absent) | Medium | Candidate and submission edits have no optimistic concurrency (row_version unused, or absent) |
| [A-06](#a-06--post-submissions-has-no-idempotency-and-the-duplicate-check-is-a-non-locking-warning) | Medium | `POST /submissions` has no idempotency, and the duplicate check is a non-locking warning |
| [B-03](#b-03--optimistic-concurrency-is-optional-or-absent-on-shared-hrpaperwork-records-inconsistent-status-codes) | Medium | Optimistic concurrency is optional or absent on shared HR/paperwork records; inconsistent status codes |
| [C-02](#c-02--role-grants-and-traits-are-replaced-with-no-optimistic-concurrency-lost-update-on-a-security-critical-record) | Medium | Role grants and traits are replaced with no optimistic concurrency (lost update on a security-critical record) |
| [E-04](#e-04--interview-edits-have-no-optimistic-concurrency-lost-updates-and-clear-and-select-checks-before-it-writes) | Medium | Interview edits have no optimistic concurrency (lost updates), and clear-and-select checks before it writes |
| [F-05](#f-05--oidc-sign-in-failures-surface-as-500-json-token-exchange-has-no-timeout) | Medium | OIDC sign-in failures surface as 500 JSON; token exchange has no timeout |
| [F-07](#f-07--idempotency-is-implemented-four-times-with-drift-and-covers-only-five-posts) | Medium | Idempotency is implemented four times with drift and covers only five POSTs |
| [A-12](#a-12--get-batches-truncates-at-200-rows-without-telling-the-client) | Low | `GET /batches` truncates at 200 rows without telling the client |
| [A-13](#a-13--error-mapping-inaccuracies-dead-branch-mislabelled-bulk-error) | Low | Error-mapping inaccuracies (dead branch, mislabelled bulk error) |
| [B-07](#b-07--silent-truncation-without-pagination-on-several-lists-access-log-keyset-loses-ties) | Low | Silent truncation without pagination on several lists; access-log keyset loses ties |
| [B-11](#b-11--idempotency-gaps-and-ordering-differences-on-create-style-posts) | Low | Idempotency gaps and ordering differences on create-style POSTs |
| [C-09](#c-09--several-adminstaff-lists-are-unpaginated-or-silently-truncated) | Low | Several admin/staff lists are unpaginated or silently truncated |
| [D-07](#d-07--batch-status-route-permission-contradicts-the-docs-and-the-db-rule) | Low | Batch status route permission contradicts the docs and the DB rule |
| [D-10](#d-10--lists-that-are-silently-capped-or-paginated-without-pagination) | Low | Lists that are silently capped or "paginated" without pagination |
| [D-11](#d-11--public-feedback-endpoint-no-api-doc-sql-in-the-controller-no-abuse-telemetry) | Low | Public feedback endpoint: no API doc, SQL in the controller, no abuse telemetry |
| [D-13](#d-13--bill-void-has-no-optimistic-concurrency-token) | Low | Bill void has no optimistic-concurrency token |
| [F-11](#f-11--central-db-error-mapping-misses-timeout-serialization-deadlock-and-connection-limit-codes) | Low | Central DB error mapping misses timeout, serialization, deadlock and connection-limit codes |

### Talent core (candidates, applications, submissions, hotlist, resumes, jobs)

#### A-02 · Candidate and submission edits have no optimistic concurrency (row_version unused, or absent)

- Module / files: `candidates.controller.ts:75-79, 124-155`; `candidates.service.ts:603-628, 715-731, 755-796`; `submissions.controller.ts:37-48`; `submissions.service.ts:391-439`; `db/functions/eureka/candidate_column_guard.sql` (`NEW.row_version := OLD.row_version + 1`); contrast `jobs.service.ts:319-353` and `applications.service.ts:245-246`
- Category: Design / Transactions (security-gate rule: "optimistic concurrency on shared-record edits")
- Severity: Medium
- Existing implementation: `GET /candidates/:id` returns `rowVersion` (`candidates.service.ts:405`), and the guard bumps it on every update. But `updateProfile` runs `UPDATE eureka.candidate SET … WHERE id = $1` (`:621`), `setRecruiter` runs `UPDATE … SET recruiter_id = $2 WHERE id = $1` (`:764`) and `setRating` does the same (`:774`), none of them checking a version. `setCompliance` reads the current values and merges them in the API (`:639-647`) before calling the definer, which is a read-modify-write with no lock. On submissions, `PATCH /:id` (`authz.edit_submission`) and `PATCH /:id/status` take no version, and `eureka.submission` has no `row_version` column at all. Jobs and applications both require `If-Match` (428/412).
- Problem: A candidate is edited by several roles: recruiter, lead, compliance and HR. Two editors working at the same time silently overwrite each other's profile fields, compliance links or recruiter assignment. The compliance read-merge-write can also put back a value another user just cleared. Submission detail corrections such as rate or client have the same problem.
- Recommended solution: Accept `If-Match: "<rowVersion>"` on `PATCH /candidates/:id`, `PUT …/compliance|recruiter|technical-rating|visibility` and `POST …/transition`, and add `AND row_version = $n` with 0 rows → 412, as `jobs.service.ts` does. Return the new `rowVersion`. For submissions, add `row_version` with a guard bump, as in migration 0003 for candidate, and pass it into `authz.edit_submission`. Start with an optional header so older clients keep working, then require it (428) once the web app sends it everywhere.
- Alternatives & trade-offs: `SELECT … FOR UPDATE` in `loadForWrite` stops interleaving inside one request but does not stop lost updates between users who loaded the page earlier. Per-field patching (already the case) shrinks the conflict window but does not remove it.
- Expected benefit: No more silent lost updates on shared candidate and submission records. Consistent API semantics across modules.
- Complexity: M
- Regression risks: The web client must send the header. Hot List bulk actions call the single-record methods and need a "no version" internal path or a `?force` decision.
- Required tests: Stale If-Match gives 412 for each route. A missing header gives 428 once enforced. Bulk still works.
- Breaking API change?: no if introduced as optional, yes once 428 is enforced

#### A-06 · `POST /submissions` has no idempotency, and the duplicate check is a non-locking warning

- Module / files: `apps/api/src/modules/submissions/submissions.controller.ts:11-15`; `submissions.service.ts:267-293`; contrast `jobs.service.ts:261-298` (Idempotency-Key with request hash)
- Category: API / Transactions
- Severity: Medium
- Existing implementation: `create()` calls `authz.recent_submission_exists(candidate, client)` and then INSERTs regardless of the answer. It returns `duplicateWarning` and audits the yes/no. There is no Idempotency-Key and no lock or unique key on `(candidate_id, client_id, …)`.
- Problem: A double-click, a client retry after a timeout, or two recruiters submitting the same candidate to the same client at the same moment all create duplicate submissions. In concurrent cases both responses say `duplicateWarning: false`, because each transaction cannot see the other's uncommitted row. Duplicate submissions to a client are a real risk in staffing, and they inflate the funnel counts in `summary`.
- Recommended solution: Accept an optional `Idempotency-Key`, reusing `platform/idempotency.ts` and the `eureka.idempotency_key` table as jobs do. Inside the create transaction, take `pg_advisory_xact_lock(hashtextextended('submission:'||candidate||client,0))` before `recent_submission_exists`, so concurrent submissions of the same pair are serialized and the warning is accurate.
- Alternatives & trade-offs: A hard unique constraint would block legitimate resubmissions after 90 days. A partial unique index is impossible with a time window.
- Expected benefit: No duplicate submissions from retries, and accurate duplicate warnings under concurrency.
- Complexity: S
- Regression risks: Minimal. The lock is per (candidate, client) pair.
- Required tests: Same key and body give the same id. Same key with a different body gives 409. Two parallel creates of the same pair give one `duplicateWarning: true`.
- Breaking API change?: no

#### A-12 · `GET /batches` truncates at 200 rows without telling the client

- Module / files: `candidates.service.ts:1062-1096` (`LIMIT 200` at `:1080`)
- Category: API
- Severity: Low
- Existing implementation: A hard `LIMIT 200` with no `nextCursor`, total or truncation flag. There is also a correlated `count(*)` per batch (`:1074`).
- Problem: Once an org has more than 200 batches (monthly × technology × location), older batches silently disappear from the picker and the filter.
- Recommended solution: Keyset paging on `(start_month, id)` with `nextCursor`, or at least return `truncated: true`.
- Alternatives & trade-offs: Default the filter to recent months.
- Expected benefit: Complete results.
- Complexity: S
- Regression risks: The UI must page or handle the flag.
- Required tests: 201 batches gives a cursor or the flag.
- Breaking API change?: no (additive)

#### A-13 · Error-mapping inaccuracies (dead branch, mislabelled bulk error)

- Module / files: `candidates.service.ts:859-860`; `hotlist.service.ts:236-248`
- Category: Observability / maintainability
- Severity: Low
- Existing implementation: (1) `create()` with `initialStatus: "active"` checks `err.code === "insufficient_privilege"`. `pg` errors carry the SQLSTATE `42501`, so this branch never matches; it only works because `ProblemFilter` maps 42501 to 403 by itself. (2) `bulkError` maps any other 422 to `"invalid_transition"` (`:246`), so a priority or profile validation failure in `bulk/priority` is reported as `invalid_transition`.
- Problem: The code reads as handled when it is not, and bulk results give the UI misleading reasons.
- Recommended solution: Compare against `"42501"`, or use the mapper. Add an `"invalid"` BulkError for other 422s.
- Alternatives & trade-offs: None needed.
- Expected benefit: Accurate client error codes and clearer code.
- Complexity: S
- Regression risks: Clients that match on `invalid_transition` for priority (unlikely).
- Required tests: A bulk priority failure reports the correct code.
- Breaking API change?: no (adds an enum value to the bulk result)

### Placements & HR (placements, payments, contracts, work-authorization, paperwork, documents, employees)

#### B-03 · Optimistic concurrency is optional or absent on shared HR/paperwork records; inconsistent status codes

- Module / files: `paperwork.schemas.ts:30,53,102,110`; `db/functions/authz/update_bgc.sql:49`; `db/migrations/0044_paperwork_bgc.sql:569`; `0460_bgc_history_entries.sql:135`; `documents.schemas.ts:116,127`; `employees.controller.ts:96-107`; `0150_employees_gaps.sql:201` (`set_assignment_employment(uuid, jsonb)`); compare `payments.service.ts:418-420`, `work-authorization.service.ts:160-161`.
- Category: API / Design (concurrency)
- Severity: Medium
- Existing implementation: Paperwork items, BGC, BGC entries and documents accept `expectedVersion` as optional; the SQL checks `IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM b.version` and silently skips otherwise. `PUT /assignments/:id/planned-end-date` and `PATCH /assignments/:id/employment` (pay rate, payroll company, E-Verify) take no version at all. Mismatch returns 409 `version_mismatch` here, 412 `stale` in payments/work-auth (428 when missing).
- Problem: HR, Accounts and Associate HR edit the same BGC/checklist/employment rows; a client that omits the version (or an older UI tab) overwrites concurrent edits (BGC notes, verification, pay rate) without warning. Two different concurrency contracts for one API surface.
- Recommended solution: Require the version on every PATCH/PUT/DELETE of shared records (make it mandatory in zod and in SQL: `IF p_expected_version IS NULL OR ... THEN RAISE 'stale'`), carry it in `If-Match` via `parseIfMatch` like payments, and map to 428/412 uniformly. Add `row_version` to `assignment_plan`/`assignment_employment` and to the two employment functions.
- Alternatives & trade-offs: Keep body field but mandatory (smaller change, still inconsistent with payments). Field-level merge (complex).
- Expected benefit: No lost updates on compliance/payroll data; one concurrency contract.
- Complexity: M
- Regression risks: Web client must send versions everywhere; old clients get 428.
- Required tests: per endpoint: missing version → 428, stale → 412, fresh → 200; mass-assignment cases unchanged.
- Breaking API change?: yes (version becomes required; status code 409→412).

#### B-07 · Silent truncation without pagination on several lists; access-log keyset loses ties

- Module / files: `payments.service.ts:287-303` (`/invoices/placements`, `LIMIT` only); `documents.service.ts:157` (`LIMIT 200`), `:295-302` (`a.at < $before`, `ORDER BY a.at DESC, a.id DESC`); `contracts.service.ts:94-98` (unbounded); `employees.service.ts:309` (history `LIMIT 200`).
- Category: API
- Severity: Low
- Existing implementation: as cited; responses carry no `nextCursor`/`truncated` flag.
- Problem: Clients cannot reach items beyond the cap and cannot tell they are missing (e.g. the "new invoice" picker after 200 joined placements; a candidate with >200 documents). The access-log cursor uses `at` alone, so rows sharing a timestamp at a page boundary are skipped, which matters for an audit trail.
- Recommended solution: Add keyset cursors (`(joined_at,id)`, `(created_at,id)`, `(at,id)`) or at least a `truncated` boolean; for contracts add `LIMIT`.
- Alternatives & trade-offs: Raise caps (only delays the issue).
- Expected benefit: Complete, predictable listings; reliable audit paging.
- Complexity: S
- Regression risks: Minimal; additive fields.
- Required tests: >cap fixtures; equal-timestamp access-log rows across a page boundary.
- Breaking API change?: no (additive)

#### B-11 · Idempotency gaps and ordering differences on create-style POSTs

- Module / files: `placements.service.ts:337-352` (key claimed before visibility/permission); `payments.service.ts:387-402` (claimed after, by design); `documents.controller.ts:30-46` (upload request, no key); `contracts.controller.ts:17-21` (no key).
- Category: API
- Severity: Low
- Existing implementation: Placement create replays `{ id, isFirstPlacement }` before re-checking access; document upload requests and contract creation are not idempotent.
- Problem: A retried upload request creates a second pending `document`/`file_object` (counted against DOC-3's limit of 5 pending), a retried contract POST creates a duplicate contract and a duplicate `contract.created` notification. Placement replay to a caller who lost access leaks only an id, but the order differs from payments, which documents the safer order.
- Recommended solution: Reuse the payments `claim()` helper (move to `platform/idempotency.ts`) for placements (after the visibility check), contracts and document upload requests (optional key first, then required).
- Alternatives & trade-offs: Natural-key dedupe for contracts (kind+title+dates) — fragile.
- Expected benefit: Safe client retries; one idempotency pattern.
- Complexity: S
- Regression risks: Clients must send keys once required.
- Required tests: replay same body → same response; different body → 409; replay after access revoked → 404.
- Breaking API change?: yes if the key becomes required (no if optional).

### Administration & identity (admin, identity, staff, lookups, preferred-vendors, imports, datahub)

#### C-02 · Role grants and traits are replaced with no optimistic concurrency (lost update on a security-critical record)

- Module / files: apps/api/src/modules/admin/admin.controller.ts:156-166; admin.service.ts:612-636; admin.schemas.ts:99-112; db/functions/authz/role_set_grants.sql:57-68
- Category: API / Security (integrity)
- Severity: Medium
- Existing implementation: `PUT /admin/roles/:key/grants` sends the full desired grant map; `role_set_grants` diffs it against current rows under `FOR UPDATE` and deletes whatever is missing (`removed := ... NOT EXISTS (... w.value IS NOT NULL)`). `PATCH /admin/roles/:key` likewise. There is no If-Match or row_version (docs/roles-api.md has no concurrency section).
- Problem: Two admins editing the same role from stale screens: the second PUT silently removes the first admin's additions, or re-adds grants the first removed. The audit trail records the diff, but nobody is told. The rubric requires If-Match on shared-record edits. Other modules (datahub, preferred-vendors) already do this.
- Recommended solution: Add `row_version` to `eureka.role` (bumped by a trigger on role and on role_permission changes), return it in `GET /admin/roles`, require `If-Match` on PUT grants / PATCH / archive (428/412 via `parseIfMatch`), and pass the expected version into `role_set_grants`/`role_update` so the check is atomic.
- Alternatives & trade-offs: A PATCH-style delta (`{add, remove}`) avoids most lost updates without versions, but still races on scope changes.
- Expected benefit: No silent permission loss or reintroduction.
- Complexity: M
- Regression risks: Web Roles screen must send If-Match; tests updating grants need the header.
- Required tests: stale If-Match → 412; missing → 428; concurrent PUTs → one 412.
- Breaking API change?: yes (If-Match becomes required; can be phased by accepting absent header for one release)

#### C-09 · Several admin/staff lists are unpaginated or silently truncated

- Module / files: apps/api/src/modules/admin/admin.service.ts:772 (`listRoleRequests` LIMIT 500), :673 (`orgChart` LIMIT 2000), :818-856 (`listTeams`: all teams + all memberships org-wide), :946-972 (`listLocations` + all location role holders), :1242 (`myTeams.addable` LIMIT 500); apps/api/src/modules/staff/birthdays.controller.ts:33 (LIMIT 2000); apps/api/src/modules/lookups/lookups.controller.ts:56-62
- Category: API / Performance (HYPOTHESIS)
- Severity: Low
- Existing implementation: Hard caps with no cursor and no `truncated` flag; lookups return complete client/vendor/IP tables.
- Problem: Past the cap, records silently disappear from the UI. Role-request history beyond 500 cannot be reached, and the org chart and birthday directory drop people after 2000 with no signal. Response size grows linearly for the unbounded ones.
- Recommended solution: Keyset cursors (`requested_at,id` for role requests; `display_name,id` for people), or at least return `truncated: true` when `rows.length > cap`. For lookups, add `?q=` search with LIMIT for clients/vendors.
- Alternatives & trade-offs: Raising the caps defers the problem.
- Expected benefit: Correctness at scale, bounded payloads.
- Complexity: S–M
- Regression risks: Web screens that assume complete lists.
- Required tests: paging over cap+1 rows.
- Breaking API change?: no (additive fields/params)

### Operations (facilities, training, performance, feedback, notifications, chat)

#### D-07 · Batch status route permission contradicts the docs and the DB rule

- Module / files: `apps/api/src/modules/training/training.controller.ts:62-66` (`@RequirePermission("training:manage")`); `db/migrations/0065_training.sql:483` (`set_batch_status` checks `batch_manage_location_ids()`, which includes Sales `batch_manager` locations); `docs/training-api.md:27-28` ("Sales planning rights reach `create_batch`, `set_batch_status` and `delete_batch`"; "status changes by non-Sales creators ... still need training:manage") vs `:52` (`PUT /batches/:id/status (training:manage)`)
- Category: API
- Severity: Low
- Existing implementation: Sales leadership without `training:manage` is refused by the guard before the DB rule, which would allow them, is reached. Delete (`training:read` plus the service's `deletable` check) honours the same DB set, so delete and status behave differently for the same people.
- Problem: Either the API under-grants a documented capability (Sales leads cannot start or cancel the batches they plan), or the docs and DB over-grant. The ambiguity in authority is itself the risk.
- Recommended solution: Decide which is intended. If Sales should be able to change status: use `training:read` plus a service check of `batch_manage_location_ids` (as delete does), and expose `actions.changeStatus`. If not: tighten `set_batch_status` to `training_manage_location_ids()` and fix TR-1/TR-1a.
- Alternatives & trade-offs: None; this is a policy decision.
- Expected benefit: The API, DB and docs agree.
- Complexity: S
- Regression risks: Only the role whose access changes is affected.
- Required tests: A Sales-lead fixture calling `PUT /status` gets the decided outcome, plus a deny path for a coach.
- Breaking API change?: no (behaviour fix)

#### D-10 · Lists that are silently capped or "paginated" without pagination

- Module / files: `apps/api/src/modules/training/training.service.ts:540-556` (courses `LIMIT 500`, `nextCursor: null`), `:300-336` (students: unbounded, `nextCursor: null`), `:338-372` (eligible `LIMIT 200`, `nextCursor: null`); `apps/api/src/modules/performance/performance.schemas.ts:88` + `performance.service.ts:262-271` (OFFSET up to 10,000 with `count(*) OVER ()`)
- Category: API / Performance (PROVEN OFFSET)
- Severity: Low
- Existing implementation: Shown above. The training lists return a `nextCursor` field that is always null, even when the cap was reached.
- Problem: Clients cannot tell a full result from a truncated one (unlike facilities exports and performance targets, which return `truncated`). The OFFSET drill-down re-sorts and counts the whole period on every page.
- Recommended solution: Return `truncated: true` (or a real cursor) when the cap is hit. Switch `activity` to keyset on (`ts DESC`, `id`) and return the total only on the first page.
- Alternatives & trade-offs: Keeping OFFSET is simpler for the "jump to page" UI.
- Expected benefit: Honest API contracts and bounded deep-page cost.
- Complexity: S
- Regression risks: The web client may rely on `offset`.
- Required tests: A cap-reached case returns `truncated`; keyset paging is stable under ties.
- Breaking API change?: yes for `activity` if OFFSET is removed (it can be additive: accept a cursor alongside offset)

#### D-11 · Public feedback endpoint: no API doc, SQL in the controller, no abuse telemetry

- Module / files: `apps/api/src/modules/feedback/feedback.controller.ts:16-48`; no `docs/*feedback*` and no doc mentions `/api/public/feedback`
- Category: Observability / API (OWASP API9)
- Severity: Low
- Existing implementation: The controller runs `eureka.feedback_view` and `eureka.feedback_submit` through `db.system`. 404 and 429 are thrown without any log or metric. The schema and limits live only in code.
- Problem: The only unauthenticated write surface in this group is missing from the API inventory, and spray attempts (many 404s or 429s per IP) leave no trace.
- Recommended solution: Add `docs/feedback-api.md` (token format, limits, responses). Move the SQL into a `FeedbackService`. Emit a structured log or counter on 429 and on repeated 404 per IP key, with the IP masked as in `client-info.ts`.
- Alternatives & trade-offs: WAF logs cover part of this but are not joined to app semantics.
- Expected benefit: Inventory completeness and abuse detection.
- Complexity: S
- Regression risks: None.
- Required tests: The existing feedback tests, plus a log assertion on 429.
- Breaking API change?: no

#### D-13 · Bill void has no optimistic-concurrency token

- Module / files: `apps/api/src/modules/facilities/facilities.controller.ts:230-235`; `apps/api/src/modules/facilities/bills.service.ts:232-239`; `db/migrations/0054_companies_facilities.sql:1015-1028`
- Category: API / Concurrency
- Severity: Low
- Existing implementation: `POST /bills/:id/void { reason }` takes no If-Match. `bill_void` locks the row and refuses a second void (409 `bill_voided`), but does not compare `row_version`.
- Problem: Voiding is final and removes the bill from every total. A user can void a bill that another user corrected moments earlier without seeing the change. Every other write on shared facilities records requires If-Match.
- Recommended solution: Accept and require `If-Match` on void (428 without it, 412 when stale) and pass the version to `bill_void`.
- Alternatives & trade-offs: Optional If-Match during a transition period.
- Expected benefit: Consistent concurrency semantics on money records.
- Complexity: S
- Regression risks: The web client must send the header.
- Required tests: 428 without the header; 412 after a concurrent edit.
- Breaking API change?: yes (new required header), or no if made optional first

### Interviews, reporting & portal (interviews, interview-reports, calendar, dashboard, pipeline-report, reports, portal)

#### E-04 · Interview edits have no optimistic concurrency (lost updates), and clear-and-select checks before it writes

- Module / files: `apps/api/src/modules/interviews/interviews.controller.ts:43-47`; `interviews.service.ts:350-403` (update), `:412-454` (clearAndSelect); `interviews.schemas.ts:161-189` (no rowVersion field); `db/migrations/0017_pipeline.sql:131` (only `updated_at`, no `row_version`)
- Category: DB / Design (Transactions & concurrency)
- Severity: Medium
- Existing implementation: `update()` loads the row (`load`), computes the consent check and the end time from the loaded values, then issues `UPDATE eureka.interview SET … WHERE id = $1` with no version predicate and no `FOR UPDATE`. A Sales editor and a Location editor routinely edit the same interview, with different field allowlists. `panelIds` replaces the whole panel. `clearAndSelect` checks `result='rejected'` on sibling rounds (:424-426) and then writes, without locking the submission or its siblings.
- Problem: Two editors overwrite each other's changes. A durationMin edit uses a stale `starts_at` (:361) if a concurrent edit moved the start. A concurrent panel edit silently drops members. A round rejected concurrently can still let the submission advance to `selected`. This contradicts the security-gate rule that shared-record edits use If-Match/row_version, which assessments and staff profile already follow.
- Recommended solution: Add `row_version` (server-managed, bumped by `interview_guard`). Require `If-Match` on PATCH and clear-and-select (428/412 via `parseIfMatch`, as in `pipeline-report.controller.ts:41-48`), with `WHERE id=$1 AND row_version=$2`. In `clearAndSelect`, `SELECT … FROM eureka.submission WHERE id=$1 FOR UPDATE` before the sibling check.
- Alternatives & trade-offs: `SELECT … FOR UPDATE` in `load()` alone prevents interleaving within the check-then-write but does not catch human edit conflicts (a stale UI). If-Match does both but needs a web change.
- Expected benefit: No silent overwrites on a hot shared record.
- Complexity: M (migration, guard, API, web `api.ts`)
- Regression risks: Web clients must send If-Match. Mass-assignment cases must include `rowVersion`.
- Required tests: 428 without the header, 412 on a stale version, a concurrent clear vs. reject test.
- Breaking API change?: yes (If-Match becomes required; can be phased in by warning first)

### Platform & cross-cutting (auth, data access, worker/outbox, shared authz, test infra)

#### F-05 · OIDC sign-in failures surface as 500 JSON; token exchange has no timeout

- Module / files: apps/api/src/modules/identity/auth.controller.ts:53-65, 90-91; apps/api/src/platform/oidc.service.ts:75-88, 104, 112, 118; apps/api/src/platform/errors.ts:52-53
- Category: API / Errors (Security OWASP API10 unsafe consumption, availability)
- Severity: Medium
- Existing implementation: `callback()` awaits `this.oidc.exchange(...)` and `this.oidc.verify(...)` without try/catch. These throw plain `Error`s ("token exchange failed: 400", "nonce mismatch", "account is not in the company domain") or JOSE errors whose `code` is `ERR_JWT_*`. `toProblem` maps any unknown code to `{status: 500, title: "Internal Server Error"}` and logs it as a server error. `exchange()` calls `fetch(GOOGLE_TOKEN, …)` with no `signal`. The calendar provider, by contrast, uses `AbortSignal.timeout(15_000)` (`calendar.provider.ts:75`). The step-up callback handles the same failures properly (`step-up.controller.ts:117-129`).
- Problem: an outside-domain Google account, a replayed or expired code (browser back), or a JWKS hiccup each gives the user a raw `application/problem+json` 500 page on a top-level navigation. Error alerting fills with expected events. A hung Google token endpoint holds the request until the 29 s gateway limit. The final `ForbiddenException("No active Eureka account…")` (line 91) also renders as raw JSON instead of a sign-in screen message.
- Recommended solution: wrap exchange, verify and link in try/catch. On failure, log a `warn` with a reason code (no email) and `302` to `${PUBLIC_BASE_URL}/login?error=signin_failed|not_provisioned|domain`, matching the step-up pattern. Add `signal: AbortSignal.timeout(10_000)` to `exchange()`.
- Alternatives & trade-offs: map JOSE and OIDC errors to 401 in `toProblem`. Simpler, but still a JSON page for the user.
- Expected benefit: a usable failure UX and clean 5xx metrics.
- Complexity: S
- Regression risks: keep the `auth.denied` audit row written before the redirect (it commits inside `withSystemTx`).
- Required tests: api.int cases for wrong-domain token, nonce mismatch and token endpoint 400, each expecting a 302 to `/login?error=…`; a fake fetch that never resolves, expecting a timeout.
- Breaking API change?: no (browser-only route)

#### F-07 · Idempotency is implemented four times with drift and covers only five POSTs

- Module / files: apps/api/src/platform/idempotency.ts:1-12 (only the key regex and `canonical`); modules/jobs/jobs.service.ts:265-290; modules/datahub/datahub.service.ts:188-215; modules/payments/payments.service.ts:362-385, 389, 470; modules/placements/placements.service.ts:337-383
- Category: API / Design
- Severity: Medium
- Existing implementation: each service repeats the same `INSERT INTO eureka.idempotency_key … ON CONFLICT DO NOTHING RETURNING key` → `SELECT request_hash, response` → `UPDATE … SET response` sequence. The copies have drifted:
  - datahub hashes `JSON.stringify(body)` (`datahub.service.ts:193`) while the others use `canonical(body)`;
  - error codes differ: `invalid_idempotency_key` (jobs, datahub) vs `idempotency_key_required` (payments, placements);
  - the key is required for placements and payments but optional for jobs and datahub.
  The header is honoured only by POST /jobs, /datahub folders, /placements, /payments invoices and payment records (grep `idempotency-key` in controllers). Candidate create, submission create, applications, document upload-init and bulk operations ignore it. Chat uses its own `clientId` scheme. Concurrency handling itself is correct: the claim sits in the business tx, so a failed request releases the key, and a concurrent duplicate blocks on the uncommitted row.
- Problem: copy-paste means behaviour diverges (hash and error codes), and new endpoints must re-implement it. Network retries on the uncovered creates can produce duplicate candidates or submissions.
- Recommended solution: a platform helper `idempotent(c, user, endpoint, rawKey, body, {required}, fn)` that uses `canonical`, a single error vocabulary, and stores `{status, body}`. Call it from the 4 existing sites. Extend it to candidate create, submission create and application create (optional key). Document it in docs/<area>-api.md.
- Alternatives & trade-offs: a Nest interceptor reading the header. Harder to keep in the same tx as the write, so the helper is better.
- Expected benefit: one implementation, consistent semantics, safe retries on the creates that matter most.
- Complexity: S–M
- Regression risks: changing datahub's hash invalidates keys in flight (24 h retention; negligible).
- Required tests: a shared idempotency test table run against every endpoint that declares support (same key + same body → same response; different body → 409; failure → key reusable).
- Breaking API change?: no (error code names could be unified with aliases)

#### F-11 · Central DB error mapping misses timeout, serialization, deadlock and connection-limit codes

- Module / files: apps/api/src/platform/errors.ts:40-54; ad-hoc 57014 handling in modules/employees/reports.service.ts:88, modules/interview-reports/interview-reports.service.ts:84, modules/performance/performance.service.ts:157
- Category: Errors / Design
- Severity: Low
- Existing implementation: `toProblem` maps 42501→403, P0002→404, 23505→409, 23503/23514/22P02→422 and everything else to 500. Three services re-implement `57014 → ServiceUnavailableException`.
- Problem: a statement timeout outside those services, `40001` serialization failure, `40P01` deadlock, `55P03` lock_not_available and `53300` too_many_connections all become an opaque 500 with no `Retry-After`. Clients cannot tell a retryable failure from a bug, and 5xx alerting fires.
- Recommended solution: add these in `toProblem`: 57014 → 503 "query_timeout"; 40001/40P01/55P03 → 503 (or 409) with `Retry-After: 1`; 53300 and pool-connect timeout → 503. Remove the per-service copies.
- Alternatives & trade-offs: automatic retry of 40001 inside `withUser`. Only safe for idempotent transactions.
- Expected benefit: correct semantics and one place to maintain.
- Complexity: S
- Regression risks: tests asserting 500 for these cases (none found).
- Required tests: unit tests on `toProblem` for each code.
- Breaking API change?: no (status changes from 500 to 503)


## Appendix — endpoint inventory

Compiled per module group by the reviewers: method, path, permission, pagination and notes.

### Talent core (candidates, applications, submissions, hotlist, resumes, jobs)

| Method | Path | Permission | Paginated? | Notes |
|---|---|---|---|---|
| GET | /api/v1/hotlist | hotlist:read | keyset (≤200) | Open policy via `authz.hotlist_page`; 60/min; every page audited |
| GET | /api/v1/candidates | candidate:read | keyset (≤200) | ILIKE name search (A-05); sort keys unindexed; no totals |
| GET | /api/v1/candidates/:id | candidate:read | – | 6 queries; dobMasked leak (A-10) |
| GET | /api/v1/candidates/:id/timeline | candidate:read | keyset (≤200) | Non-owners: no actor, events since last opened |
| GET | /api/v1/candidates/:id/metrics | candidate:read | – | Per-section read scopes |
| POST | /api/v1/candidates | candidate:create | – | Duplicate check (20/min) + trigger backstop; no If-Match needed |
| POST | /api/v1/candidates/duplicate-check | candidate:create | – | 20/min, audited |
| PATCH | /api/v1/candidates/:id | candidate:update | – | No If-Match (A-02) |
| DELETE | /api/v1/candidates/:id | candidate:delete | – | Definer re-check; 409 when placed |
| PUT | /api/v1/candidates/:id/compliance | candidate.compliance:update | – | Read-merge-write without version (A-02) |
| GET | /api/v1/candidate-companies | candidate.compliance:update | no | |
| GET | /api/v1/candidate-create-teams | candidate:create | no | |
| PUT | /api/v1/candidates/:id/team | candidate:create | – | Only when team is null |
| GET | /api/v1/candidate-share-teams | candidate.visibility:update | no | All teams (names) |
| PUT | /api/v1/candidates/:id/visibility | candidate.visibility:update | – | Definer `set_candidate_visibility` |
| GET | /api/v1/candidates/:id/recruiter-options | candidate:assign | no | |
| PUT | /api/v1/candidates/:id/recruiter | candidate:assign | – | Direct UPDATE + column guard; no If-Match |
| PUT | /api/v1/candidates/:id/technical-rating | candidate.rating:update | – | Direct UPDATE + column guard; no If-Match |
| POST | /api/v1/candidates/:id/transition | candidate:update | – | Shared state machine + `authz.transition_candidate` |
| GET | /api/v1/batches | candidate:read | no (hard LIMIT 200) | A-12 |
| POST | /api/v1/batches | candidate:create (+canCreateBatch) | – | Definer `create_batch` |
| GET | /api/v1/batches/candidate-template | candidate:create | – | Static xlsx, fixed filename |
| POST | /api/v1/batches/:id/candidates/bulk | candidate:create | – | ≤500 rows, all-or-nothing, 10/min; oracle (A-01), long tx (A-07) |
| PUT | /api/v1/batches/:id/status | candidate:create (+canCreateBatch) | – | Definer `set_batch_status` |
| GET | /api/v1/applications | none (RLS) | keyset (≤200) | HR all / hiring manager / interviewer |
| POST | /api/v1/applications/export | application:read | capped 5,000 | Raw emails (A-04); 10/10 min |
| GET | /api/v1/applications/:id | none (RLS) | – | History LIMIT 200 |
| POST | /api/v1/applications/:id/status | none (definer manage check) | – | If-Match required; emails applicant post-commit |
| POST | /api/v1/applications/:id/interviews | none (definer manage check) | – | https-only link |
| POST | /api/v1/applications/:id/candidate | candidate:create | – | Same-tx link via callback |
| POST | /api/v1/application-interviews/:id/status | none (definer manage check) | – | |
| PUT | /api/v1/application-interviews/:id/people | none (definer manage check) | – | |
| PUT | /api/v1/application-interviews/:id/scorecard | none (definer reviewer check) | – | |
| GET | /api/v1/applicants | applicant:read | keyset (≤200) | Phone masked without applicant.phone:read |
| POST | /api/v1/applicants/export | applicant:read | capped 5,000 | Audited with phones flag |
| POST | /api/v1/submissions | submission:create | – | No idempotency, warning-only dup check (A-06) |
| GET | /api/v1/submissions | submission:read | keyset (≤200) | ILIKE filters (A-05) |
| GET | /api/v1/submissions/summary | submission:read | unbounded aggregate | A-09 |
| GET | /api/v1/submissions/:id | submission:read | – | Rate gated by rate:read |
| PATCH | /api/v1/submissions/:id | submission.details:update | – | Definer `edit_submission`; no row_version (A-02) |
| PATCH | /api/v1/submissions/:id/status | submission:update | – | Shared state machine + `transition_submission` FOR UPDATE |
| GET | /api/v1/hotlist/views | hotlist:read | no (≤50 per owner) | Owner-only RLS |
| POST | /api/v1/hotlist/views | hotlist:read | – | |
| PATCH | /api/v1/hotlist/views/:id | hotlist:read | – | RLS → 404 for others' views |
| DELETE | /api/v1/hotlist/views/:id | hotlist:read | – | |
| POST | /api/v1/hotlist/bulk/visibility | candidate.visibility:update | ≤100 ids | Sequential per-record tx (A-03) |
| POST | /api/v1/hotlist/bulk/status | candidate:update | ≤100 ids | A-03 |
| POST | /api/v1/hotlist/bulk/priority | candidate:update | ≤100 ids | A-03, A-13 |
| GET | /api/v1/hotlist/filter-options | hotlist:read | no | Names only |
| POST | /api/v1/hotlist/export | report:export | capped 50,000 | In-memory CSV, 60 s timeout (A-08) |
| GET | /api/v1/candidates/:id/resumes | document:read | no (LIMIT 50) | |
| POST | /api/v1/candidates/:id/resumes | document:upload | – | Presigned POST to quarantine, 10/min |
| POST | /api/v1/candidates/:id/resumes/:resumeId/download | document:read | – | 60 s presigned GET, bound to candidate, audited |
| GET | /api/v1/jobs | job:read | keyset (≤200) | |
| GET | /api/v1/jobs/options | job:manage | no | Staff limited by picker scope |
| GET | /api/v1/jobs/company-options | job:manage (+internal_opening kind) | no | |
| GET | /api/v1/jobs/:id | none (RLS; hiring manager) | – | |
| POST | /api/v1/jobs | job:manage | – | Optional Idempotency-Key |
| PATCH | /api/v1/jobs/:id | job:manage | – | If-Match required; status free-form (A-11) |

### Placements & HR (placements, payments, contracts, work-authorization, paperwork, documents, employees)

| Method | Path | Permission | Paginated? | Notes |
|---|---|---|---|---|
| GET | /api/v1/placements | placement:read | keyset (≤200) | rate gated by rate:read |
| POST | /api/v1/placements/export | report:export (+placement:read in svc) | cap 5000 | CSV, rate-limited (in-memory), audited, no rates/contacts |
| GET | /api/v1/placements/teams | placement:read | no (small set) | union of placement/interview scopes |
| GET | /api/v1/placements/:id | placement:read | n/a | contacts, checklist, bgc (document:read), assignment (assignment:read) |
| POST | /api/v1/placements | placement:create (+submission:update in svc) | n/a | Idempotency-Key required; definer create_placement |
| PATCH | /api/v1/placements/:id/status | placement:update (+placement.bgc_status:update for bgc_failed) | n/a | shared state machine + transition_placement under lock; no If-Match |
| GET | /api/v1/placements/:id/contracts | placement:read | no (unbounded) | B-07 |
| POST | /api/v1/placements/:id/contracts | placement:read (DB decides) | n/a | B-04, no idempotency |
| GET | /api/v1/invoices | invoice:read | keyset (≤200) | money gated by rate:read |
| GET | /api/v1/invoices/summary | invoice:read | n/a (aggregate) | B-02 |
| GET | /api/v1/invoices/placements | invoice:read | limit only (≤200) | B-07 |
| GET | /api/v1/invoices/:id | invoice:read | n/a | payments listed |
| POST | /api/v1/invoices | invoice:update | n/a | Idempotency-Key required |
| PATCH | /api/v1/invoices/:id | invoice:update | n/a | If-Match required (428/412) |
| POST | /api/v1/invoices/:id/void | invoice:update | n/a | If-Match required |
| POST | /api/v1/invoices/:id/payments | invoice:update | n/a | Idempotency-Key required |
| POST | /api/v1/invoices/:id/payments/:paymentId/void | invoice:update | n/a | locked + already-void check; no version |
| GET | /api/v1/candidates/:id/work-authorizations | visa:read | LIMIT 50 | number masked |
| POST | /api/v1/candidates/:id/work-authorizations | visa:update | n/a | number encrypted in API |
| PATCH | /api/v1/candidates/:id/work-authorizations/:waId | visa:update | n/a | If-Match required |
| POST | /api/v1/candidates/:id/work-authorizations/:waId/reveal | visa:read | n/a | step-up + SQL rate limit + audit |
| GET | /api/v1/paperwork | document:read | keyset (≤200) | B-05 |
| GET | /api/v1/paperwork/templates | document:read | no | |
| POST | /api/v1/paperwork/templates | document:verify | n/a | expectedVersion required |
| GET | /api/v1/paperwork/placements/:id | document:read | n/a | bgc entries (addresses) included |
| PATCH | /api/v1/paperwork/placements/:id/bgc | document:read (bgc:update / bgc_status in svc+DB) | n/a | optional version (B-03) |
| POST | /api/v1/paperwork/placements/:id/bgc/entries | document:read (bgc:update in svc+DB) | n/a | |
| PATCH | /api/v1/paperwork/placements/:id/bgc/entries/:entryId | document:read (bgc:update in svc+DB) | n/a | optional version |
| DELETE | /api/v1/paperwork/placements/:id/bgc/entries/:entryId | document:read (bgc:update in svc+DB) | n/a | optional version (query) |
| GET | /api/v1/paperwork/items/:id/history | document:read | LIMIT 200 | |
| PATCH | /api/v1/paperwork/items/:id | document:upload (verify in svc+DB for some fields) | n/a | optional version |
| GET | /api/v1/document-types | document:read | no | |
| GET | /api/v1/candidates/:id/documents | document:read | LIMIT 200 | B-07 |
| POST | /api/v1/candidates/:id/documents | document:upload | n/a | presigned POST 120 s; no idempotency |
| GET | /api/v1/placements/:id/documents | document:read | LIMIT 200 | |
| POST | /api/v1/placements/:id/documents | document:upload | n/a | |
| POST | /api/v1/documents/:documentId/download | document:read (+restricted in svc+DB) | n/a | B-01: no step-up; TTL 60/300 s |
| PATCH | /api/v1/documents/:documentId | document:upload | n/a | optional version |
| POST | /api/v1/documents/:documentId/replace | document:upload | n/a | optional version |
| GET | /api/v1/document-access | none (svc: audit:read or document.restricted:read) | keyset on `at` only (≤200) | B-12, B-07 |
| GET | /api/v1/employees | employee:read (org) | keyset (≤200) | contacts masked |
| POST | /api/v1/employees/export | report:export (+employee:read org) | cap EXPORT_ROW_CAP | in-memory limiter |
| GET | /api/v1/employees/payroll-companies | employee:read | no | |
| GET | /api/v1/employees/teams | assignment:update (+employee:read org) | no | |
| GET | /api/v1/employees/:id | employee:read (org) | assignments all, history LIMIT 200 | pay rate via definer |
| POST | /api/v1/employees/:id/exit | assignment:update | n/a | |
| POST | /api/v1/employees/:id/return-to-market | assignment:update | n/a | |
| POST | /api/v1/employees/:id/assign-team | assignment:update | n/a | |
| POST | /api/v1/assignments/:id/end | assignment:update | n/a | |
| PUT | /api/v1/assignments/:id/planned-end-date | assignment:update | n/a | no version (B-03) |
| PATCH | /api/v1/assignments/:id/employment | assignment:update (+rate:read for payRate) | n/a | no version (B-03) |
| GET | /api/v1/reports/joinings-exits | report:read | cap 1000 | |
| GET | /api/v1/reports/active-employees | report:read | n/a | |
| POST | /api/v1/reports/joinings-exits/export | report:export | cap EXPORT_ROW_CAP | |

### Administration & identity (admin, identity, staff, lookups, preferred-vendors, imports, datahub)

| Method | Path | Permission | Paginated? | Notes |
|---|---|---|---|---|
| GET | /api/v1/admin/meta | access:manage | n/a | roles, locations, singleAdminMode |
| GET | /api/v1/admin/users | access:manage | keyset (id), ≤200 | search ILIKE name/email |
| GET | /api/v1/admin/users/summary | access:manage | n/a | counts |
| POST | /api/v1/admin/users | access:manage | – | optional temp password / invite (staging) |
| POST | /api/v1/admin/users/bulk | access:manage | – | ≤500 rows, dryRun, all-or-nothing; C-03 |
| GET | /api/v1/admin/users/bulk/template | access:manage | – | xlsx |
| POST | /api/v1/admin/users/:id/password | access:manage | – | staging only; not restricted-role targets |
| POST | /api/v1/admin/users/:id/password-invite | access:manage | – | staging only; 256-bit token, 72h |
| POST | /api/v1/admin/users/:id/deactivate | access:manage | – | not self |
| POST | /api/v1/admin/users/:id/reactivate | access:manage | – | not self |
| DELETE | /api/v1/admin/users/:id | access:manage | – | anonymise deactivated user |
| PUT | /api/v1/admin/users/:id/designation | access:manage | – | |
| PUT | /api/v1/admin/users/:id/department | access:manage | – | |
| PUT | /api/v1/admin/users/:id/manager | access:manage | – | closure rebuild |
| DELETE | /api/v1/admin/users/:id/roles/:role | access:manage | – | ?locationId |
| GET | /api/v1/admin/roles | access:manage | no | ?includeArchived |
| GET | /api/v1/admin/permissions | access:manage | n/a | catalog |
| POST | /api/v1/admin/roles | access:manage | – | clone; C-01 |
| PATCH | /api/v1/admin/roles/:key | access:manage | – | no If-Match (C-02) |
| PUT | /api/v1/admin/roles/:key/grants | access:manage | – | no If-Match (C-02); C-01 |
| POST | /api/v1/admin/roles/:key/archive | access:manage | – | |
| POST | /api/v1/admin/roles/:key/restore | access:manage | – | |
| GET | /api/v1/admin/org-chart | access:manage | cap 2000 | C-09 |
| GET | /api/v1/admin/org-chart/preview | access:manage | n/a | |
| POST | /api/v1/admin/org-chart/apply | access:manage | – | ≤100 changes; C-03 |
| POST | /api/v1/admin/role-requests | access:manage | – | restricted → pending |
| GET | /api/v1/admin/role-requests | access:manage | cap 500 | C-09 |
| POST | /api/v1/admin/role-requests/:id/approve | access:manage | – | second approver |
| POST | /api/v1/admin/role-requests/:id/reject | access:manage | – | |
| GET | /api/v1/admin/locations | access:manage | no | |
| GET | /api/v1/admin/locations/:id | access:manage | no | |
| POST | /api/v1/admin/locations | access:manage | – | audit has name (C-05) |
| PATCH | /api/v1/admin/locations/:id | access:manage | – | |
| GET | /api/v1/admin/departments | access:manage | no | |
| POST | /api/v1/admin/departments | access:manage | – | |
| PATCH | /api/v1/admin/departments/:id | access:manage | – | |
| GET | /api/v1/admin/teams | access:manage | no | all members org-wide |
| POST | /api/v1/admin/teams | access:manage | – | audit has name (C-05) |
| PATCH | /api/v1/admin/teams/:id | access:manage | – | |
| GET | /api/v1/admin/teams/:id/delete-impact | access:manage | n/a | |
| DELETE | /api/v1/admin/teams/:id | access:manage | – | ?toTeamId |
| PUT | /api/v1/admin/teams/:id/lead | access:manage | – | |
| POST | /api/v1/admin/teams/:id/members | access:manage | – | |
| POST | /api/v1/admin/teams/:id/members/bulk | access:manage | – | ≤100, per-user tx |
| DELETE | /api/v1/admin/teams/:id/members/:userId | access:manage | – | |
| POST | /api/v1/admin/teams/:id/coaches | access:manage | – | |
| DELETE | /api/v1/admin/teams/:id/coaches/:userId | access:manage | – | |
| GET | /api/v1/teams/mine | team:add_member | cap 500 addable | C-06 |
| POST | /api/v1/teams/:id/members | team:add_member | – | lead/hierarchy scope |
| DELETE | /api/v1/teams/:id/members/:userId | team:add_member | – | |
| POST | /api/v1/teams/:id/coaches | coach:assign | – | hierarchy scope |
| DELETE | /api/v1/teams/:id/coaches/:userId | coach:assign | – | |
| POST | /api/v1/teams/:id/move-member | team:move_member | – | both teams in scope |
| GET | /api/v1/coach-assignments | coach:assign | no | |
| PUT | /api/v1/users/:id/designation | designation:change | – | hierarchy scope |
| GET | /api/auth/methods | public | n/a | |
| GET | /api/auth/login | public | – | OIDC start (PKCE) |
| GET | /api/auth/callback | public | – | state/nonce/iss/aud/hd |
| POST | /api/auth/dev-login | public (dev only) | – | refused in production |
| POST | /api/auth/logout | session | – | |
| POST | /api/auth/password-login | public (staging) | – | per-IP limit + DB lockout; C-07 |
| POST | /api/auth/password/setup | public (staging) | – | token redeem |
| POST | /api/auth/password/change | session | – | |
| GET | /api/auth/step-up | session | n/a | |
| POST | /api/auth/step-up/start | session | – | |
| GET | /api/auth/step-up/callback | session | – | |
| POST | /api/auth/step-up/password | session (staging) | – | |
| POST | /api/auth/step-up/dev | session (dev only) | – | |
| GET | /api/v1/me | session | n/a | csrfToken |
| GET/PUT | /api/v1/settings/profile | session (own) | – | If-Match on PUT |
| GET | /api/v1/settings/notifications | session (own) | n/a | |
| PUT | /api/v1/settings/notifications/:type | session (own) | – | |
| GET | /api/v1/settings/sessions | session (own) | 30-day window | |
| POST | /api/v1/settings/sessions/:id/revoke | session (own) | – | |
| POST | /api/v1/settings/sessions/revoke-others | session (own) | – | |
| GET | /api/v1/staff/birthdays | staff.birthday:manage | cap 2000 | C-09 |
| PUT | /api/v1/staff/:id/birthday | staff.birthday:manage | – | |
| GET | /api/v1/lookups | session (shaped by perms) | no | C-09 |
| POST | /api/v1/lookups/technologies | technology:create (in handler) | – | |
| POST | /api/v1/lookups/clients | client:create (in handler) | – | |
| POST | /api/v1/lookups/vendors | vendor:create (in handler) | – | |
| GET | /api/v1/preferred-vendors | vendor.preferred:create or :read (in service) | offset ≤10k, ≤200 | total |
| GET | /api/v1/preferred-vendors/:id | same | – | |
| POST | /api/v1/preferred-vendors | vendor.preferred:create | – | |
| PATCH | /api/v1/preferred-vendors/:id | vendor.preferred:create | – | If-Match |
| DELETE | /api/v1/preferred-vendors/:id | vendor.preferred:create | – | archive |
| POST | /api/v1/imports/tickets | access:manage | – | 256-bit ticket |
| GET | /api/v1/imports/:id | access:manage | n/a | |
| GET | /api/v1/imports/:id/review | access:manage | no (batch-bounded) | |
| POST | /api/v1/imports/:id/decisions | access:manage | – | |
| GET | /api/v1/imports/:id/preview | access:manage | no (batch-bounded) | PII for sign-off; audited |
| POST | /api/v1/imports/:id/approve | access:manage | – | operator ≠ approver, digest |
| GET | /api/v1/datahub/folders | datahub:read | no | |
| POST | /api/v1/datahub/folders | datahub:read (+manage/create in service) | – | Idempotency-Key |
| GET | /api/v1/datahub/folders/:id | datahub:read | – | |
| PATCH | /api/v1/datahub/folders/:id | datahub:read (+manage) | – | If-Match |
| DELETE | /api/v1/datahub/folders/:id | datahub:read (+manage) | – | If-Match |
| GET | /api/v1/datahub/folders/:id/members | datahub:read (+manage) | no | |
| PUT | /api/v1/datahub/folders/:id/members/:userId | datahub:read (+manage) | – | |
| DELETE | /api/v1/datahub/folders/:id/members/:userId | datahub:read (+manage) | – | |
| GET | /api/v1/datahub/folders/:id/access-log | datahub:read (+manage) | keyset ≤200 | |
| GET | /api/v1/datahub/folders/:id/files | datahub:read (+readable) | keyset ≤200 | |
| POST | /api/v1/datahub/folders/:id/files | datahub:read (+upload right) | – | presigned POST, 20/min |
| GET | /api/v1/datahub/files/:id/versions | datahub:read (RLS) | no | |
| DELETE | /api/v1/datahub/files/:id | datahub:read (+owner/manage) | – | |
| POST | /api/v1/datahub/versions/:id/download | datahub:read (+step-up if restricted) | – | 30/min, logged |
| GET | /api/v1/datahub/search | datahub:read (RLS) | limit ≤50 | contains LIKE |
| GET | /api/v1/datahub/people | datahub:read (+manage/create) | limit ≤50 | |

### Operations (facilities, training, performance, feedback, notifications, chat)

| Method | Path | Permission | Paginated? | Notes |
|---|---|---|---|---|
| GET | /api/v1/{companies,facilities} | company:read / facility:read | keyset (max 200) | |
| POST | /api/v1/{companies,facilities} | company:manage / facility:manage | n/a | location coverage checked before the definer |
| GET | /api/v1/{companies,facilities}/stats | *:read | n/a | KPI counts under RLS |
| GET | /api/v1/{companies,facilities}/bills-summary | bill:read | n/a | ≤60 months; 4 queries |
| GET | /api/v1/{companies,facilities}/export.csv | *:read | cap 5000 | 10 per 10 min per task; audited |
| GET | /api/v1/{companies,facilities}/:id | *:read | n/a | facility detail includes owner contact |
| PATCH | /api/v1/{companies,facilities}/:id | *:manage | n/a | If-Match |
| GET | /api/v1/{companies,facilities}/:id/incharges | *:read | no (small) | |
| GET | /api/v1/{companies,facilities}/:id/incharge-options | *:manage | LIMIT 50 | |
| POST | /api/v1/{companies,facilities}/:id/incharges | *:manage | n/a | |
| DELETE | /api/v1/{companies,facilities}/:id/incharges/:userId | *:manage | n/a | 204 |
| GET | /api/v1/{companies,facilities}/:id/utilities | utility:read | no (small) | no password columns |
| POST | /api/v1/{companies,facilities}/:id/utilities | utility:manage | n/a | password sealed in the API |
| GET | /api/v1/{companies,facilities}/:id/bills | bill:read | keyset (default 200, max 500) | derived status filter |
| POST | /api/v1/{companies,facilities}/:id/bills | bill:manage | n/a | |
| GET | /api/v1/{companies,facilities}/:id/bills/export.csv | bill:read | cap 5000 | audited |
| GET | /api/v1/companies/:id/employees | company:read | no | email only with employee:read |
| POST | /api/v1/companies/:id/employees | company:manage | n/a | |
| POST | /api/v1/companies/:id/employees/:employeeId/end | company:manage | n/a | |
| GET | /api/v1/companies/:id/employee-options | company:manage | LIMIT 50 | |
| PATCH | /api/v1/utilities/:id | utility:manage | n/a | If-Match |
| POST | /api/v1/utilities/:id/reveal-password | utility.secret:read | n/a | step-up, DB rate limit, audited |
| PATCH | /api/v1/bills/:id | bill:manage | n/a | If-Match |
| POST | /api/v1/bills/:id/void | bill:manage | n/a | no If-Match (D-13) |
| POST | /api/v1/bills/:id/invoice | bill:manage | n/a | presigned upload to quarantine |
| GET | /api/v1/bills/:id/invoice | bill:read | n/a | 60 s link; access log |
| GET | /api/v1/training/batches | training:read | keyset (max 100) | full visible-set evaluation (D-03) |
| POST | /api/v1/training/batches | training:read (+ canPlanBatch) | n/a | |
| GET | /api/v1/training/batches/:id | training:read | n/a | |
| PATCH | /api/v1/training/batches/:id | training:manage | n/a | If-Match |
| PUT | /api/v1/training/batches/:id/status | training:manage | n/a | no If-Match; contradicts docs (D-07) |
| DELETE | /api/v1/training/batches/:id | training:read (+ deletable) | n/a | |
| POST | /api/v1/training/batches/:id/courses | training:manage | n/a | advisory lock |
| PUT | /api/v1/training/batches/:id/courses/order | training:manage | n/a | |
| DELETE | /api/v1/training/batches/:id/courses/:courseId | training:manage | n/a | |
| GET | /api/v1/training/batches/:id/students | training:read | no (`nextCursor: null`) | |
| GET | /api/v1/training/batches/:id/eligible-students | training:read (+ staffable) | LIMIT 200, `nextCursor: null` | |
| POST | /api/v1/training/batches/:id/students | training:read (+ staffable) | n/a | |
| POST | /api/v1/training/batches/:id/students/bulk | training:read (+ staffable) | ≤200 ids | N+1 loop (D-04) |
| DELETE | /api/v1/training/batches/:id/students/:candidateId | training:read (+ staffable) | n/a | |
| PUT | /api/v1/training/batches/:id/students/:candidateId/modules/:moduleId | training.progress:update | n/a | |
| GET | /api/v1/training/trainers | training:read (+ canPlanBatch) | no | org-wide list |
| GET | /api/v1/training/courses | training:read | LIMIT 500, `nextCursor: null` | |
| POST | /api/v1/training/courses | training:manage | n/a | direct DML under RLS |
| GET | /api/v1/training/courses/:id | training:read | n/a | |
| PATCH | /api/v1/training/courses/:id | training:manage | n/a | If-Match |
| DELETE | /api/v1/training/courses/:id | training:manage | n/a | 409 when in use |
| POST | /api/v1/training/courses/:id/modules | training:manage | n/a | advisory lock |
| PUT | /api/v1/training/courses/:id/modules/order | training:manage | n/a | |
| PATCH | /api/v1/training/courses/:id/modules/:moduleId | training:manage | n/a | If-Match |
| DELETE | /api/v1/training/courses/:id/modules/:moduleId | training:manage | n/a | |
| GET | /api/v1/candidates/:id/training | training:read | n/a | |
| PUT | /api/v1/candidates/:id/training/batch | training:read (+ definer) | n/a | |
| GET | /api/v1/performance/summary | performance:read | n/a | 60 s timeout at org scope (D-05) |
| GET | /api/v1/performance/activity | performance:read | OFFSET ≤10k, max 200 | `count(*) OVER()` |
| GET | /api/v1/performance/active-candidates | performance:read | cap 500 + truncated | |
| GET | /api/v1/performance/people | performance:read | no | |
| GET | /api/v1/performance/targets | performance:read | cap 500 + truncated | correlated counts (D-09) |
| PUT | /api/v1/performance/targets | performance.target:manage | n/a | upsert via definer |
| DELETE | /api/v1/performance/targets/:id | performance.target:manage | n/a | |
| GET | /api/public/feedback/:token | @Public (token) | n/a | 30/min per IP and per token (D-01) |
| POST | /api/public/feedback/:token | @Public (token) | n/a | single use |
| GET | /api/v1/notifications | session only | keyset (max 50) | |
| GET | /api/v1/notifications/unread-count | session only | n/a | capped at 1000 |
| POST | /api/v1/notifications/:id/read | session only | n/a | 204 |
| POST | /api/v1/notifications/:id/unread | session only | n/a | 204 |
| POST | /api/v1/notifications/read-all | session only | n/a | `before` bound |
| GET | /api/v1/chat/conversations | chat:use | keyset (max 100) | D-08 |
| GET | /api/v1/chat/unread | chat:use | n/a | capped at 999 |
| GET | /api/v1/chat/people | chat:use | LIMIT 50 | no presence |
| POST | /api/v1/chat/conversations/direct | chat:use | n/a | 201/200 |
| POST | /api/v1/chat/conversations/group | chat:use | n/a | ≤99 members |
| GET | /api/v1/chat/conversations/:id | chat:use | n/a | 404 for non-members |
| PATCH | /api/v1/chat/conversations/:id | chat:use | n/a | If-Match; owners |
| DELETE | /api/v1/chat/conversations/:id | chat:use | n/a | hide direct / delete group |
| POST | /api/v1/chat/conversations/:id/leave | chat:use | n/a | |
| PATCH | /api/v1/chat/conversations/:id/preferences | chat:use | n/a | last write wins (own row) |
| POST | /api/v1/chat/conversations/:id/members | chat:use | n/a | ≤99 ids |
| DELETE | /api/v1/chat/conversations/:id/members/:userId | chat:use | n/a | |
| PATCH | /api/v1/chat/conversations/:id/members/:userId | chat:use | n/a | |
| GET | /api/v1/chat/conversations/:id/messages | chat:use | seq `before` (max 100) / rev `after` (200) | |
| POST | /api/v1/chat/conversations/:id/messages | chat:use | n/a | idempotent per clientId; body ≤4000; ≤5 files |
| POST | /api/v1/chat/conversations/:id/read | chat:use | n/a | |
| PATCH | /api/v1/chat/messages/:messageId | chat:use | n/a | sender only (definer) |
| DELETE | /api/v1/chat/messages/:messageId | chat:use | n/a | |
| POST | /api/v1/chat/attachments/:attachmentId/download | chat:use | n/a | 60 s link |

### Interviews, reporting & portal (interviews, interview-reports, calendar, dashboard, pipeline-report, reports, portal)

| Method | Path | Permission | Paginated? | Notes |
|---|---|---|---|---|
| GET | /api/v1/interviews/coaches | interview:create | no | Small directory, names only |
| GET | /api/v1/interviews/panel-options | interview:create | no (LIMIT 500) | Scope-filtered picker |
| GET | /api/v1/interviews | interview:read | keyset, ≤200 | Search uses a per-row definer call (E-09) |
| GET | /api/v1/interviews/:id | interview:read | – | Panel included |
| POST | /api/v1/interviews | interview:create (+submission:update scope) | – | No Idempotency-Key; the overlap EXCLUDE dedups identical slots |
| PATCH | /api/v1/interviews/:id | interview:update (field allowlist) | – | No If-Match (E-04); audit free text (E-08) |
| POST | /api/v1/interviews/:id/clear-and-select | interview:update + submission:update | – | Check-then-write (E-04) |
| GET | /api/v1/interviews/:id/calendar.ics | interview:read | – | Audited; server-derived filename |
| GET | /api/v1/interviews/:id/feedback | interview:read | no | Per interview, small |
| POST | /api/v1/interviews/:id/feedback | interview.feedback:create | – | Kind gated by scope |
| GET | /api/v1/reports/interviews | report:read (+interview:read) | groups capped 1000 | Two transactions (E-11), 60 s |
| POST | /api/v1/reports/interviews/export | report:export | capped 50 000 | Audited, 5/10 min |
| GET | /api/v1/reports/interviews/daily | report:read | capped 1000 | ≤26 h window |
| POST | /api/v1/reports/interviews/daily/export | report:export | capped 50 000 | Contains candidate feedback text (export, audited) |
| GET | /api/v1/calendar/support | calendar:block | – | |
| GET | /api/v1/calendar/support/connect | calendar:block | – | Sets a signed state cookie, 302 to Google |
| GET | /api/v1/calendar/support/callback | calendar:block | – | State bound to user; upserts the org connection |
| POST | /api/v1/calendar/support/disconnect | calendar:block | – | |
| GET | /api/v1/calendar/support/busy | calendar:block OR interview:create (inline `can`, no decorator) | – | ≤31 d; no rate limit; 2 Google calls per request (E-05) |
| GET | /api/v1/calendar/support/dev/events | calendar:block | – | 404 in production / non-dev provider |
| GET | /api/v1/interviews/:id/calendar-block | interview:read | – | |
| POST | /api/v1/interviews/:id/calendar-block | calendar:block | – | Google call inside transaction (E-05) |
| POST | /api/v1/interviews/:id/calendar-block/release | calendar:block | – | Google call inside transaction (E-05) |
| GET | /api/v1/dashboard | report:read | groups ≤500 | 20/min; attention lists (E-06); 60 s at org scope |
| POST | /api/v1/dashboard/export | report:export | groups ≤500 | Audited |
| GET | /api/v1/reports/pipeline | report:read + candidate:read | offset ≤10 000, ≤200 | Double CTE (E-03) |
| GET | /api/v1/submissions/:id/assessments | submission:read | no | |
| POST | /api/v1/submissions/:id/assessments | submission:update | – | Definer `assessment_create` |
| PATCH | /api/v1/assessments/:id | submission:update | – | If-Match required (428/412) |
| GET | /api/v1/candidates/:id/non-response | candidate:read | LIMIT 10 | |
| POST | /api/v1/candidates/:id/non-response | candidate:update | – | Definer `nonresponse_flag` |
| POST | /api/v1/candidates/:id/non-response/resolve | candidate:update | – | Definer `nonresponse_resolve` |
| GET | /api/v1/reports/market | report.market:read | no (groups) | 30/min, always 60 s (E-02) |
| POST | /api/v1/reports/market/export | report.market:read + report:export | no | Audited |
| POST | /api/portal/auth/sign-up | public (+x-eureka-portal) | – | 202 uniform; per-IP 20/15 min; global caps (E-01) |
| POST | /api/portal/auth/request-link | public (+x-eureka-portal) | – | 202 uniform |
| POST | /api/portal/auth/verify | public (+x-eureka-portal) | – | 30/15 min per IP; 204 + cookie |
| POST | /api/portal/auth/sign-out-all | portal session + CSRF | – | |
| POST | /api/portal/auth/sign-out | portal session + CSRF | – | |
| GET | /api/portal/me | portal session | – | Returns the CSRF token |
| GET | /api/portal/dev/mailbox | public, dev only | – | 404 unless dev mode, non-production, dev mail port |
| GET | /api/portal/jobs | portal session | keyset, 30 | RLS: published open internal openings |
| GET | /api/portal/jobs/:id | portal session | – | |
| POST | /api/portal/jobs/:id/apply | portal session + CSRF | – | Definer `application_apply`; 409 already_applied |
| GET | /api/portal/applications | portal session | no (LIMIT 200) | Own only |
| GET | /api/portal/applications/:id | portal session | – | Meeting link only while scheduled |
| POST | /api/portal/applications/:id/withdraw | portal session + CSRF | – | Definer `application_withdraw` |

Notes: There is no resume or file upload on the portal yet (docs/jobs-portal-api.md:183), so public upload risk does not apply today. Doc drift: jobs-portal-api.md:84 says an unverified applicant's name and phone "are replaced" at sign-up, but the code applies them only at link redemption.

### Platform & cross-cutting (auth, data access, worker/outbox, shared authz, test infra)

| Method | Path | Permission | Paginated? | Notes |
|---|---|---|---|---|
| GET | /api/health | Public | n/a | `SELECT 1` through the pool. Also the ECS liveness check (loopback exempt from the origin guard) (F-02) |
| GET | /api/auth/login | Public | n/a | Only when AUTH_MODE=google; sets sealed `eureka_oidc` cookie (path /api/auth, 10 min), 302 to Google |
| GET | /api/auth/callback | Public | n/a | state/nonce/PKCE; links by sub, then email once; audit `auth.linked`/`auth.denied`. Failures return 500 (F-05) |
| POST | /api/auth/dev-login | Public | n/a | 404 unless AUTH_MODE=dev and not production; strict zod |
| POST | /api/auth/logout | Authenticated + CSRF | n/a | `@AllowPasswordChange`; revokes the session |
| GET | /api/auth/methods | Public | n/a | Which sign-in methods are on |
| POST | /api/auth/password-login | Public | n/a | 404 unless PASSWORD_LOGIN=on (staging/local only); per-IP 30/10 min in memory (F-06) plus DB lockout and WAF 100/5 min |
| POST | /api/auth/password/setup | Public | n/a | Same gating and per-IP limiter; token hashed |
| POST | /api/auth/password/change | Authenticated + CSRF | n/a | `@AllowPasswordChange`; DB verifies (`authz.password_change`) |
| GET | /api/auth/step-up | Authenticated | n/a | Grant status; 2 extra txs (F-03) |
| POST | /api/auth/step-up/start | Authenticated + CSRF | n/a | Google only; DB rate cap `too_many_step_ups` → 429; returnTo strict |
| GET | /api/auth/step-up/callback | Authenticated (Lax cookie) | n/a | Single-use challenge; failures recorded and redirected; return path re-validated |
| POST | /api/auth/step-up/password | Authenticated + CSRF | n/a | PASSWORD_LOGIN only; DB lockout |
| POST | /api/auth/step-up/dev | Authenticated + CSRF | n/a | Dev only, also gated by DB policy_setting |
| GET | /api/v1/me | Authenticated | n/a | `@AllowPasswordChange`; returns csrfToken, roles, capabilities; 1–2 extra txs (F-03) |
| GET | /api/v1/settings/profile | Authenticated (self-service) | n/a | Own row only |
| PUT | /api/v1/settings/profile | Authenticated + CSRF | n/a | If-Match row version (`parseVersion`); strict zod |
| GET | /api/v1/settings/notifications | Authenticated (self-service) | n/a | |
| PUT | /api/v1/settings/notifications/:type | Authenticated + CSRF | n/a | Type validated by zod enum |
| GET | /api/v1/settings/sessions | Authenticated (self-service) | No (bounded by a created_at window in days) | `WHERE user_id = $1` (F-13) |
| POST | /api/v1/settings/sessions/:id/revoke | Authenticated + CSRF | n/a | ParseUUIDPipe; own sessions only, not the current one (422 `current_session`) |
| POST | /api/v1/settings/sessions/revoke-others | Authenticated + CSRF | n/a | Audited with a count only |
| POST | /api/local-storage/upload | None (signed policy) | n/a | Local driver only (refused in production by config); verifies HMAC policy, exact key/type/size, quarantine/ prefix |
| GET | /api/local-storage/object | None (signed policy) | n/a | Local driver only; serves clean/ and restricted/ keys as attachments; server-derived Content-Disposition |
