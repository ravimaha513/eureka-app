# Eureka backend — refactoring roadmap

> Output of the 2026-11-05 backend audit. **Status: top 15 implemented on `ccr-6973b23a-g6dxmm` (see §7 Remediation status).**
> Evidence for every item is in the linked findings ([architecture](architecture.md) ·
> [api](api-review.md) · [security](security-review.md) · [performance](performance-review.md)).

## 1. How items were ranked

Findings that share a root cause were merged into one item. For example, five modules lacking `If-Match` became R-10. Each item was then scored:

* **Impact** (1–5): user-visible correctness, data exposure or availability.
* **Risk reduction** (1–5): how much it lowers the chance or blast radius of an incident.
* **Effort** (S = 1, M = 2, L = 3).

**Priority = (Impact + Risk reduction) ÷ Effort.** Ties are broken toward security, then toward fewer files touched. All items are incremental, independently shippable and testable, and none needs a rewrite, a new service or an approved breaking change. Items that touch hot files (`catalog.ts`, `app.module.ts`) should merge `origin/main` first, per CLAUDE.md.

## 2. Top 15 improvements

| Rank | ID | Item | Findings | Sev | Impact | Risk↓ | Effort | Priority | Breaking? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | R-02 | API pool resilience: error listener, awaited session setup, acquire timeout | F-01 (+F-11) | High | 4 | 5 | S | 9.0 | No |
| 2 | R-04 | Mask applicant email in application CSV export | A-04 | Med | 3 | 4 | S | 7.0 | No |
| 3 | R-08 | Fix payments summary `outstanding` and money arithmetic | B-02 | Med | 4 | 2 | S | 6.0 | No (values corrected) |
| 4 | R-09 | Fail-closed route authorization and route inventory test | F-08, D-12, B-12 | Med | 2 | 4 | S | 6.0 | No |
| 5 | R-05 | Make portal sign-in caps abuse-resistant and alerting | E-01 | High | 4 | 4 | S–M | 5.3 | No |
| 6 | R-07 | DB least privilege: worker EXECUTE, `person`/`candidate` column grants | G-02, G-01, G-03 | Med | 3 | 5 | S–M | 5.3 | No |
| 7 | R-01 | Close the custom-role privilege escalation | C-01 | High | 5 | 5 | M | 5.0 | No |
| 8 | R-11 | Request correlation, structured logs, basic metrics | F-04, F-05 | Med | 3 | 4 | S–M | 4.7 | No (adds `x-request-id`) |
| 9 | R-03 | Stop report queries starving the pool | E-02, D-05, F-02 | High | 5 | 4 | M | 4.5 | No (503 on overload is new) |
| 10 | R-06 | Decide and enforce the restricted-document step-up policy | B-01 | High | 4 | 4 | M | 4.0 | No |
| 11 | R-14 | One idempotency helper; cover `POST /submissions` | F-07, A-06, B-11 | Med | 3 | 3 | S–M | 4.0 | No (optional header) |
| 12 | R-10 | Optimistic concurrency on shared records, starting with role grants | C-02, A-02, B-03, E-04, D-13 | Med | 4 | 3 | M | 3.5 | Optional → enforced later (approval needed) |
| 13 | R-15 | Close the bulk dry-run contact-existence oracle | A-01 | Med | 2 | 3 | S–M | 3.3 | No |
| 14 | R-13 | Index-backed name search (measure first) | G-04, A-05, B-06, E-09 | Med | 4 | 2 | M | 3.0 | No |
| 15 | R-12 | Remove N+1 in bulk operations | A-03, D-04, C-03, A-07 | Med | 3 | 2 | M | 2.5 | No |

IDs are stable labels used across the audit documents; **Rank** is the priority order. Ties are broken by severity. **Recommended execution order** groups related changes into waves, which keeps each PR small. R-01 runs in Wave 1 despite rank 7 because it is a High security fix:

* **Wave 1, security and stability (≈1–2 weeks):** R-02, R-04, R-08, R-09, R-05, R-07, R-01.
* **Wave 2, operability (≈2 weeks):** R-11, R-03, R-06 (needs a product/security decision first), R-14.
* **Wave 3, measure, then optimise (≈2–3 weeks):** run the measurement plan in [performance-review.md §7](performance-review.md#7-measurement-plan-do-this-before-any-perf-refactor), then R-10, R-15, R-13, R-12.

## 3. Item details (in ID order)

### R-01 · Close the custom-role privilege escalation (C-01)

- **Module / files:** shared-authz + admin. `packages/shared/src/authz/catalog.ts:407` (`RESTRICTED_PERMISSIONS`), `:911` (`ORG_SENSITIVE_PERMISSIONS`); `db/functions/authz/role_set_grants.sql`, `role_create.sql`, `request_role.sql`; `db/migrations/0013_admin.sql:136` (`admin_guard`).
- **Existing implementation:** `admin_guard` admits any user holding `access:manage` at org scope. `access:manage` and `audit:read` are in neither restricted list, so `request_role` applies a custom role carrying them immediately, without a second approver. `role_set_grants` also allows mixing admin and data permissions on one role.
- **Problem:** One admin acting alone can create further `access:manage` holders. Those holders can then serve as the "second approver" for restricted roles and import sign-offs, which defeats AD-3. An admin-trait role can also be given data permissions, which breaks AD-1 ("org_admin gets no business permission").
- **Severity:** High.
- **Recommended solution:** (1) Add an `ADMIN_PERMISSIONS` set (`access:manage`, `audit:read`), mirrored into `eureka.permission.is_admin_only` by the migration runner like `is_restricted`. (2) In `role_set_grants`/`role_create`, allow admin-only permissions only on `is_admin` roles and forbid business permissions on `is_admin` roles (a constraint trigger on `role_permission`). (3) Treat admin-only permissions as restricted, so granting them needs the second approver. (4) Have `admin_guard` also require the admin trait.
- **Alternatives and trade-offs:** Only add `access:manage` to `RESTRICTED_PERMISSIONS`: cheapest and restores the second approver, but still allows mixed roles. Forbid `access:manage` on custom roles entirely: simplest, but removes the "deputy admin" use case covered by `admin-roles` tests.
- **Expected benefit:** Restores the two-person rule for administrative power.
- **Complexity:** M (catalog + 3 definer files + 1 migration in the session's block).
- **Regression risks:** Existing custom roles that mix permissions will violate the new invariant. The migration must report them, not silently strip them. `catalog-consistency` and `admin-roles` tests will need updates.
- **Required tests:** DB: `role_set_grants` rejects `access:manage` on a non-admin role, rejects data permissions on an admin role, and `request_role` returns `pending_approval` for an admin-permission role. API: 422/403 deny paths. Security gate: run `eureka-security-gate` on the diff.

### R-02 · API pool resilience (F-01, F-11)

- **Module / files:** platform-data. `apps/api/src/platform/db.service.ts:17-22`, `platform/errors.ts` (`toProblem`).
- **Existing implementation:** The pool registers only a `connect` handler, `void c.query("SET statement_timeout = '5s'")`, and no `error` listener (the worker has one, `worker.ts:48`). There is no `connectionTimeoutMillis`. `toProblem` maps neither `57014` (statement timeout), `40001`/`40P01` (serialization/deadlock) nor `53300` (too many connections), so all become 500.
- **Problem:** An idle-client error, for example during an RDS failover or network reset, emits an unhandled `error` event, which **crashes the API process**. A failed `SET` is an unhandled rejection. Pool waits are unbounded. Transient DB conditions surface as opaque 500s.
- **Severity:** High.
- **Recommended solution:** `pool.on("error", log)`. Set `statement_timeout` via the pg `options`/`statement_timeout` client config instead of an un-awaited query. Set `connectionTimeoutMillis` (≈3 s) and map its error to 503 + `Retry-After`. Map `57014` to 503, `40001`/`40P01` to 409 (or retry once for idempotent reads), and `53300` to 503.
- **Alternatives and trade-offs:** Wrap `withUser` in a retry for serialization failures. More robust, but only safe for idempotent work. Defer it.
- **Expected benefit:** No process crash on DB blips; clients get retryable status codes.
- **Complexity:** S.
- **Regression risks:** Low. Statement-timeout semantics must stay identical (5 s default, reports raise it with `SET LOCAL`).
- **Required tests:** Unit: `toProblem` mapping for each code. Int: simulate idle-client termination (`pg_terminate_backend`) and assert the process survives and the next request succeeds. Pool-exhaustion test → 503.

### R-03 · Stop report queries starving the pool (E-02, D-05, F-02)

- **Module / files:** interview-reports, reports (market), performance, pipeline-report, dashboard, hotlist export; `platform/db.service.ts`; `HealthController` in `app.module.ts`; `infra/modules/stack/app.tf:565`.
- **Existing implementation:** 9 call sites `SET LOCAL statement_timeout` to 60 s on the shared 5-connection pool. API Gateway times out at 29 s. Nothing is cached. `/api/health` uses the same pool.
- **Problem:** A few concurrent heavy reports can hold every connection for up to 60 s, including 31 s after the client has gone. Sign-in and health checks then queue indefinitely, and ECS may replace a healthy task. The configuration is PROVEN; the frequency is a HYPOTHESIS.
- **Severity:** High.
- **Recommended solution:** Introduce one injectable `ReportExecutor`, the one Strategy-style abstraction this audit recommends. It holds a per-task semaphore of at most 2 concurrent report queries and returns 503 + `Retry-After` when that is full. It caps the timeout at 25 s, below the gateway, and applies the raised timeout only to org-scope callers. It offers an optional 30–120 s cache for point-in-time aggregates. Split health into `/api/health/live` (no DB) and `/api/health/ready`. Longer exports move to the worker (async job, S3 link), whose sink already exists.
- **Alternatives and trade-offs:** A read replica isolates load but adds cost and lag. Materialised daily rollups give the biggest win but return stale-by-design numbers. Raising `DB_POOL_MAX` is limited by the `db.t4g.micro` connection ceiling.
- **Expected benefit:** Interactive traffic is isolated from analytics; no cascading health-check failures.
- **Complexity:** M.
- **Regression risks:** Reports that legitimately take 25–60 s will start failing. Measure first, using the plan in performance-review.md §7, and move those to async. The ECS health-check path changes.
- **Required tests:** Concurrency test: N+1 simultaneous reports means the extra one gets 503, while `/me` still answers. Timeout test: a report over 25 s gets 503, not 500. Health live/ready split.

### R-04 · Mask applicant email in application CSV export (A-04)

- **Module / files:** applications. `apps/api/src/modules/applications/applications.service.ts:162-176` (`exportCsv`), `:98-99` (`email()`).
- **Existing implementation:** JSON responses pass the email through `this.email(access, v)`, which returns it only with `applicant:read` at all-scope. The CSV writes `r.email` raw and requires only `application:read`.
- **Problem:** A custom role with `application:read` but without `applicant:read` gets every applicant email in bulk (OWASP API3).
- **Severity:** Medium.
- **Recommended solution:** Use `this.email(user.access, r.email)` in the CSV row, or drop the column when the caller lacks `applicant:read`. Keep the header stable and leave masked cells empty.
- **Alternatives and trade-offs:** Require `applicant:read` for the whole export. Simpler, but it stops HR roles that legitimately export without contact details.
- **Expected benefit:** Closes a bulk PII leak path.
- **Complexity:** S (one line plus a test).
- **Regression risks:** HR users with full access must see no change.
- **Required tests:** API: export as a role with `application:read` only gives empty Email cells; as HR gives emails. Audit row unchanged.

### R-05 · Abuse-resistant portal caps (E-01)

- **Module / files:** portal. `apps/api/src/modules/portal/portal-auth.service.ts:30-36`; `db/migrations/0061_*.sql` (`portal_take`, around :173-220).
- **Existing implementation:** Per-address limit of 20 requests per 15 min (≈80/h) against DB-wide hourly caps of 600 links and 200 sign-ups, shared by everyone. When a cap is reached the API still answers with the generic "link sent" and logs nothing.
- **Problem:** About 8 addresses can exhaust the global budget, after which even verified applicants receive no link for the rest of the hour, silently (OWASP API6/API4).
- **Severity:** High.
- **Recommended solution:** Give verified applicants their own budget (or exempt them, keeping their per-applicant 10/h and 60 s cooldown) and cap only unverified sign-ups globally. Emit a structured warning and a `portal_cap_reached{kind}` metric when a cap is hit, and alert on it.
- **Alternatives and trade-offs:** CAPTCHA (Turnstile) on sign-up only: strong, but adds friction and an external dependency. Keying by /48 for IPv6 makes rotation harder but penalises shared carriers. Raising the cap weakens the email-reputation protection the cap exists for.
- **Expected benefit:** Existing applicants keep access during an abuse burst, and operators are told about it.
- **Complexity:** S–M (definer function change in `db/functions` or a new migration in the session block).
- **Regression risks:** Anti-enumeration must be preserved: the response must not differ by verified status.
- **Required tests:** DB: exhaust the unverified budget; a verified applicant still gets a link. API: identical response body in both cases; the metric or log is emitted.

### R-06 · Decide and enforce the restricted-document step-up policy (B-01)

- **Module / files:** documents, datahub, identity/step-up. `db/functions/authz/document_download.sql:34-37`; `datahub_download`; `docs/documents-api.md:40`; work-authorization reveal path.
- **Existing implementation:** Commit cd4d82e deliberately stopped requiring step-up, because Google sends no `auth_time` to unverified apps. It still records a grant if one exists. Docs, comments and service code still say step-up is required. Restricted links live 300 s against 60 s for internal files. Work-authorization reveal still requires a step-up that Google users cannot complete.
- **Problem:** I-9, licence and work-authorisation files rest only on role and scope, and the code and docs misstate the control. This is an **unreviewed risk acceptance**.
- **Severity:** High (pending decision).
- **Recommended solution:** **Owner decision first.** Option A (recommended): restore step-up with a factor everyone can complete. `StepUpPassword` already exists (`step-up.controller.ts:20`); the other options are WebAuthn, or OIDC `prompt=login` validated on `iat`. Make it an audited policy setting and cut the restricted TTL to ≤60 s. Option B: formally accept the risk with compensating controls (a per-user daily cap on restricted opens enforced in SQL, an anomaly alert, a shorter TTL) and fix the docs and comments.
- **Alternatives and trade-offs:** A gives strong assurance at the cost of friction. B has no friction but weaker assurance, and needs monitoring (R-11) to be meaningful.
- **Expected benefit:** Code, docs and threat model agree; restricted PII is either protected by a second factor or watched.
- **Complexity:** M.
- **Regression risks:** Google-only users must have a working path before enforcement, or they lose access to documents they need.
- **Required tests:** DB: restricted download without a grant gives `step_up_required` (A), or the cap is enforced (B). API: TTL ≤ 60 s. E2E: a Google-only user completes the chosen step-up.

### R-07 · Database least privilege (G-02, G-01, G-03)

- **Module / files:** database. `db/functions/authz/transition_candidate.sql:50`; `db/migrations/0003_domain.sql:118`; `candidate_column_guard.sql`.
- **Existing implementation:** `eureka_worker` holds EXECUTE on `authz.transition_candidate` but never calls it, and `authz.current_user_id()` trusts a GUC any role can set. `eureka_app` has table-wide `INSERT, UPDATE` on `person` and `candidate`, and rule 4 is enforced by denylist guard triggers.
- **Problem:** A compromised worker can act as any user for candidate transitions, which is exactly what 0019:4-7 meant to remove. On the API role, `person.created_at`, encrypted DOB and contact columns are DB-writable, and **any future `candidate` column is client-writable by default**.
- **Severity:** Medium.
- **Recommended solution:** In one migration from the session block: `REVOKE EXECUTE … FROM eureka_worker`; replace the table-wide grants with column-level `GRANT UPDATE (col, …)` allow-lists matching what services actually write; `REVOKE INSERT ON person FROM eureka_app` if every insert goes through definer functions (verify by grep). Edit `transition_candidate.sql` in `db/functions` per CLAUDE.md.
- **Alternatives and trade-offs:** Move all candidate edits into definer functions (the long-term rule-6 shape). More secure but L effort. The column grants get most of the value at S–M.
- **Expected benefit:** The DB layer enforces rule 4 by privilege, not by convention.
- **Complexity:** S–M.
- **Regression risks:** A missed column in the allow-list breaks an edit path with 42501 → 403. Mitigated by the existing API test suite and the mass-assignment harness.
- **Required tests:** DB: the worker cannot call `transition_candidate`; `eureka_app` cannot update `person.created_at` or a dummy new column. A catalog lint (G-11) asserting that no table-wide UPDATE on sensitive tables is granted to `eureka_app`. Full `pnpm test:api`.

### R-08 · Fix payments summary (B-02)

- **Module / files:** payments. `apps/api/src/modules/payments/payments.service.ts:258-283`.
- **Existing implementation:** Paid amounts on invoices with no amount count toward `paid` but not `invoiced`. `outstanding` is clamped at 0, which hides the error. Totals are summed as JS floats and rounded with `Math.round(v*100)/100`.
- **Problem:** Finance users see an understated outstanding balance. Float arithmetic can drift by a cent.
- **Severity:** Medium (financial correctness).
- **Recommended solution:** One SQL aggregate over `numeric`: `sum(amount)`, `sum(greatest(amount - paid_amount, 0))` as outstanding, and a separate `receivedWithoutAmount` field. Return numeric strings or exact decimals.
- **Alternatives and trade-offs:** Make `amount` mandatory on invoices. That is a schema and contract change, so it would need approval.
- **Expected benefit:** Correct financial figures.
- **Complexity:** S.
- **Regression risks:** Displayed totals change; tell finance users. The response shape stays the same, apart from the optional new field.
- **Required tests:** API: an invoice without an amount plus a payment gives the correct outstanding; a cent-precision case (0.1 + 0.2).

### R-09 · Fail-closed route authorization (F-08, D-12, B-12)

- **Module / files:** platform-auth. `apps/api/src/platform/auth.guard.ts` (end of `canActivate`); new test `apps/api/test/route-authz.int.test.ts`.
- **Existing implementation:** When no `@RequirePermission` is present, any signed-in user passes. 36 of about 355 routes rely on this (identity/me, notifications, chat with RLS, document-access with a service-level check). None was found exploitable.
- **Problem:** A new route that forgets its decorator is silently open to every employee. Intent is not machine-checkable.
- **Severity:** Medium.
- **Recommended solution:** Add an explicit `@SelfService()` marker. The guard throws 403 on staff routes that carry none of `RequirePermission | Public | PortalRoute | SelfService`. Add an inventory test that reflects over all controllers in `AppModule` (reusing the mass-assignment harness's route reflection) and snapshots the allow-list.
- **Alternatives and trade-offs:** The test only, with no runtime change: lower risk, and still catches regressions in CI.
- **Expected benefit:** Function-level authz becomes default-deny (OWASP API5).
- **Complexity:** S (but touches `app.module.ts` imports and many controllers; merge main first).
- **Regression risks:** A missed `@SelfService` turns a working route into 403. The inventory test catches this before merge.
- **Required tests:** The inventory snapshot; a guard unit test for an undecorated route → 403.

### R-10 · Optimistic concurrency on shared records (C-02, A-02, B-03, E-04, D-13)

- **Module / files:** admin roles (`PUT /admin/roles/:key/grants`, `PATCH /admin/roles/:key`), candidates (PATCH, compliance, recruiter, rating, visibility, transition), submissions (no `row_version` column), interviews, paperwork/BGC (version optional), employees pay-rate/planned-end, facilities bill void.
- **Existing implementation:** `jobs.service.ts:319-353` and `applications` require `If-Match` (428 when missing, 412 when stale, `UPDATE … WHERE row_version = $n`). Elsewhere `row_version` is bumped but not checked, or the check is optional, or the column is absent. Conflict codes are inconsistent (409 vs 412).
- **Problem:** Lost updates on shared records. The most serious is role grants: full-replace semantics can silently drop or re-add permissions when two admins edit at once.
- **Severity:** Medium.
- **Recommended solution:** A small shared helper (`requireIfMatch(header, {required})` + `assertUpdated(rowCount)`) using the jobs semantics. Roll out **optional** `If-Match` everywhere (412 when stale) in phase 1, starting with role grants. Phase 2 makes it **required** (428) per resource after the web client sends it, **which is a breaking change and needs your approval**. Add `row_version` to `submission` and `interview` where missing.
- **Alternatives and trade-offs:** Field-level merge (PATCH only changed fields). Narrows conflicts but does not prevent them, and does not work for full-replace grants.
- **Expected benefit:** No silent lost updates; one conflict vocabulary.
- **Complexity:** M (spread over many modules; each module is S).
- **Regression risks:** Web client must send `If-Match`; bulk paths must bypass or pass versions.
- **Required tests:** Per route: stale gives 412, missing gives 428 (phase 2), match gives 200 with the new version. Concurrent role-grant edit test.

### R-11 · Request correlation, structured logs, basic metrics (F-04, F-05)

- **Module / files:** `apps/api/src/app.module.ts` (Fastify adapter), `platform/errors.ts`, `worker/log.ts` (reuse), `platform/oidc.service.ts`.
- **Existing implementation:** Nest text logger. 5xx logged without request, route or user context. 401/403 not logged. No access log or metrics. OIDC failures surface as a 500 JSON page, and the token exchange has no timeout.
- **Problem:** Incidents cannot be traced, and abuse (403 storms, portal caps, restricted opens under R-06 option B) is invisible.
- **Severity:** Medium.
- **Recommended solution:** Reuse the worker's `createLogger` as a Nest `LoggerService`. Use Fastify `genReqId` from `x-amzn-trace-id`, else a UUID; echo it as `x-request-id` and as `instance` in problem bodies. Log 5xx with `{reqId, route, userId, pgCode}` and 401/403 at `warn` with no PII. Add CloudWatch EMF metrics: latency by route, pool `waitingCount`, 5xx count. Give the OIDC token exchange a timeout and redirect failures to the login page with an error code.
- **Alternatives and trade-offs:** Enable Fastify's pino logger. Access logs come for free, but it adds a dependency. OpenTelemetry later, if tracing across worker and API is needed.
- **Expected benefit:** Mean time to diagnose drops; R-03, R-05 and R-06 become observable.
- **Complexity:** S–M.
- **Regression risks:** Logging PII by accident. Mitigate with a field allow-list in the logger.
- **Required tests:** Unit: problem body carries `instance`; the logger strips non-allow-listed fields. Int: OIDC failure gives a 302 to login with an error code.

### R-12 · Remove N+1 in bulk operations (A-03, D-04, C-03, A-07)

- **Module / files:** hotlist bulk (`hotlist.service.ts`), training bulk add (`training.service.ts`), admin org-chart apply and user import (`admin.service.ts` + closure trigger), candidates batch bulk import (`candidates.service.ts:879-946`).
- **Existing implementation:** Per-id loops: one transaction per id (Hot List, ~600 round trips per 100 ids), sequential definer calls (training), and a reporting-closure rebuild per row under a global advisory lock (org chart / import).
- **Problem:** Latency grows linearly with batch size, pool checkouts multiply, and the global lock serialises admin operations. The loops are PROVEN; the wall-clock impact is a HYPOTHESIS.
- **Severity:** Medium.
- **Recommended solution:** Keep each endpoint's documented semantics (per-record results / all-or-nothing). Do one batched visibility read (`WHERE id = ANY($1)` plus the scope predicate), then one transaction with a SAVEPOINT per row. For the closure, add a deferred flag so it rebuilds once per transaction (a constraint trigger `DEFERRABLE INITIALLY DEFERRED`, or an explicit `authz.rebuild_closure()` call at the end).
- **Alternatives and trade-offs:** Set-based single-statement updates: fastest, but they lose per-row error codes, which is a contract change.
- **Expected benefit:** Fewer round trips and checkouts per bulk call (to be measured).
- **Complexity:** M.
- **Regression risks:** Per-record error codes must stay identical, and savepoint rollback must not leave partial audit rows.
- **Required tests:** Existing partial-result tests (`hotlist-extras.api.int.test.ts:144-224`); a mixed-outcome 100-id test; audit count per success; closure correctness after a 100-move apply.

### R-13 · Index-backed name search (G-04, A-05, B-06, E-09)

- **Module / files:** candidates (`candidates.service.ts:431-434`), `db/functions/eureka/hotlist_page.sql:53`, submissions, placements, employees, interviews and ~5 other services; new migration in the session block.
- **Existing implementation:** `(first_name || ' ' || last_name) ILIKE '%term%'`, correctly escaped, open-coded in ~10 places. No `pg_trgm` index exists. Interview board search also calls a definer function per row in `WHERE`.
- **Problem:** Search pages scan every visible row. Cost grows with data, not with page size. The missing index is PROVEN; the latency is a HYPOTHESIS.
- **Severity:** Medium.
- **Recommended solution:** **Measure first** (performance-review.md §7). Then enable `pg_trgm` (confirm RDS allows it as non-superuser; it is a trusted extension on PG 13+) and add a GIN trigram index on one immutable expression, `lower(first_name || ' ' || last_name)`. Put the predicate in one shared `nameSearch()` helper used by every service, set a minimum term length of 2–3 characters, and move E-09's definer call into an InitPlan.
- **Alternatives and trade-offs:** Full-text `tsvector`: better relevance, but no substring matching. A generated column: simpler predicate, but write cost on every update.
- **Expected benefit:** Index-backed search; size the gain with before/after EXPLAIN.
- **Complexity:** M.
- **Regression risks:** Matching semantics change if the expression differs (case, nulls). Write overhead on person updates.
- **Required tests:** Existing search tests unchanged; an `EXPLAIN` assertion test (index used) in the style of `rls.int.test.ts`; migration applies as non-superuser.

### R-14 · One idempotency helper, extended to `POST /submissions` (F-07, A-06, B-11)

- **Module / files:** `platform/idempotency.ts`; jobs, payments and two other services that copy the logic; submissions.
- **Existing implementation:** Four copies with drifting error vocabularies. Five POSTs are covered. `POST /submissions` has no key, and its duplicate check is a non-locking warning.
- **Problem:** Retries or double-clicks create duplicate submissions, the most consequential pipeline record, and the copies drift.
- **Severity:** Medium.
- **Recommended solution:** `idempotent(c, user, endpoint, key, body, {required}, fn)` in the same transaction as the write, storing `{status, body}`. Migrate the four sites, then add it (optional header) to submission, candidate and application create. Take a `pg_advisory_xact_lock(hash(candidate, job))` around the duplicate check.
- **Alternatives and trade-offs:** A Nest interceptor. Cleaner wiring, but it cannot share the write transaction, so it is rejected.
- **Expected benefit:** Safe retries; a single implementation.
- **Complexity:** S–M.
- **Regression risks:** The existing sites must keep their exact replay semantics and status codes.
- **Required tests:** Same key and body gives the same id; same key with a different body gives 409; two parallel submits of the same pair give one record or one warning.

### R-15 · Close the bulk dry-run existence oracle (A-01)

- **Module / files:** candidates. `candidates.service.ts:879-946`; `db/migrations/0260_*.sql:39-52` (org-wide duplicate trigger).
- **Existing implementation:** The dry run of `POST /batches/:id/candidates/bulk` (500 rows, 10 calls/min) reports `duplicate_email` / `duplicate_phone` per row from an org-wide check. The dedicated duplicate-check endpoint allows only 20/min.
- **Problem:** About 5,000 existence checks a minute per user, 250× the intended limit, with only counts in the audit (OWASP API6).
- **Severity:** Medium.
- **Recommended solution:** Charge dry-run rows to a per-user **DB-stored** daily budget (for example 2,000 rows a day; the in-memory limiter is per task), and record `checked` counts. Optionally report out-of-scope duplicates only on commit.
- **Alternatives and trade-offs:** Remove `duplicate_*` from dry runs entirely. That closes the oracle but makes previews less useful.
- **Expected benefit:** Brings the bulk path in line with the dedicated endpoint's limit.
- **Complexity:** S–M.
- **Regression risks:** Legitimate large imports hit the budget; make it configurable.
- **Required tests:** Exceeding the budget gives 429; the audit row records the checked count.

## 4. Next tier (after the top 15)

| ID | Item | Findings | Effort |
|---|---|---|---|
| R-16 | Extend `state-machines.ts` to jobs and training batches, remove the paperwork literals, add a generic TS↔SQL parity test | A-11, D-06, B-08, F-12, D-07 | M |
| R-17 | Split `AdminService` (1.3K lines) and `CandidatesService` (1.1K) into sub-domain query modules; dedupe the team-scope check | C-04, D-14 | M |
| R-18 | Calendar: call Google after commit (or via the outbox); map provider errors to 502/503 | E-05 | S–M |
| R-19 | OpenAPI 3.1 generated from zod, with a contract-diff CI check | api-review.md §2, D-11 | M |
| R-20 | `migrate.ts`: apply function files in order with their migrations, reset `search_path` per file, lock-wait timeout | G-05 | S–M |
| R-21 | Retention jobs for sessions, step-up rows, applicant sessions; an `audit_event` archival policy | G-08 | S |
| R-22 | Remove free text from audit rows (rule 5) | C-05, E-08 | S |
| R-23 | Consistent pagination: `truncated` flag or cursor on every capped list; keyset for the pipeline report | A-12, B-07, C-09, D-10, E-03 | S each |
| R-24 | Shared-store rate limiter (a Postgres table or ElastiCache) for security-relevant limits; `/64` keying on feedback | F-06, D-01, B-09 | M |
| R-25 | Collapse auth per request into one definer call, one checkout | F-03 | M |
| R-26 | Catalog-wide DB lint (RLS forced, definer hardening, ACLs) as an int test | G-11 | S |
| R-27 | Worker: dead-letter state, separate outbox loop from long jobs; schedule the production worker before go-live | F-10, F-09 | M |
| R-28 | Validate the 6 `NOT VALID` constraints; add length and control-character CHECKs on core free-text columns | G-09, G-10 | S |
| R-29 | Interview: lock in clear-and-select; coach/panel overlap check (exclusion constraint) | E-04, E-10 | M |
| R-30 | Cookie hardening (`__Host-` prefix), move role passwords out of SQL literals | F-14, G-06 | S |

## 5. Explicitly not recommended

* **No microservices.** Nothing shows a need for them. The modular monolith with a shared DB security boundary is the right shape.
* **No ORM or Repository layer.** Business rules live in RLS and definer functions, and a TS repository would add a second, weaker rule layer (architecture.md §6).
* **No authz caching.** Immediate revocation is a design requirement. Reduce the per-request cost by collapsing queries instead (R-25).
* **No bulk FK-index additions.** 132 unindexed FK columns are mostly never-deleted actor references; add indexes only where a query uses them.
* **No new dependencies** except the optional `zod-to-openapi` (R-19, dev-only) and the `pg_trgm` extension (R-13). Both are justified above.

## 6. Approval checklist

Please confirm before any code changes:

1. **R-06 policy decision:** restore step-up (option A) or accept the risk with compensating controls (option B)?
2. **R-10 phase 2:** making `If-Match` mandatory is a breaking API change. Approve per resource, or keep it optional?
3. **R-01 existing roles:** if live custom roles violate the new admin/data separation, should the migration fail (forcing manual cleanup) or report and continue?
4. **Wave order:** go with Wave 1 as listed, or reprioritise?

## 7. Remediation status (2026-11-05)

**Owner decisions:**
* **R-06:** no step-up for restricted documents; compensating controls only.
* **R-01:** single admin stays and no second approver is required; existing violating custom roles are *reported*, not failed.
* **R-10:** If-Match stays **optional**. No mandatory-header (428) rollout without a separate approval.

Built on branch `ccr-6973b23a-g6dxmm` by parallel worktrees, with migrations 0470–0479. An independent security gate (eureka-security-gate) returned **ship**, and its 3 actionable minors are fixed.

| Item | Status | What shipped | Notes / left |
|---|---|---|---|
| R-01 | Done (adjusted) | `ADMIN_PERMISSIONS` may only sit on admin-trait roles, and admin roles may hold no business permissions (enforced on new changes); `admin_guard` requires the admin trait; `GET /admin/roles/violations` plus a migration WARNING per legacy violator | No second approver, by decision. `request_role` can still grant an already-violating legacy role (follow-up) |
| R-02 | Done | Pool and client `error` listeners; `statement_timeout` in the pool config; `DB_CONNECT_TIMEOUT_MS` → 503 + Retry-After; 57014/53300/57P01/57P03 → 503; 40001/40P01/55P03 → 409 | — |
| R-03 | Done | `ReportExecutor`: per-task semaphore (2), 25 s cap, 503 + Retry-After, 60 s cache for the market report and needsAttention; `/api/health/live` and `/ready` (origin guard exempts both on loopback) | Reports that take 25–60 s now fail with 503 and should move to async jobs |
| R-04 | Done | CSV export masks applicant email exactly as JSON does | — |
| R-05 | Done | Verified applicants are exempt from the global link cap; `portal_cap_reached` warn log; identical responses | — |
| R-06 | Done (option B) | Per-user cap of 200 restricted opens per 24 h (`policy_setting restricted_opens_per_day`), 429 above it; 60 s restricted links; high-water and cap logs; docs corrected | Confirm 200/day with HR |
| R-07 | Done | Worker EXECUTE on `transition_candidate` revoked; column-level grants on person, candidate and job; DB lint test | Candidate allow-list still includes columns some tests write directly (tracked in the 0472 comments) |
| R-08 | Done | Payments summary computed in one numeric aggregate; correct `outstanding`; `receivedWithoutAmount` | Finance totals change for invoices without an amount (intended) |
| R-09 | Done | Fail-closed guard with a `@SelfService()` marker; route inventory test with reviewed SelfService and Public lists | — |
| R-10 | Done (optional) | `optionalIfMatch()` on candidates, submissions, interviews, roles, employment and planned end date, and bill void; malformed tag → 412 | The web client does not send If-Match yet |
| R-11 | Done | Request id (`x-request-id`, problem `instance`), allow-listed JSON logger, EMF metrics, OIDC timeout and `/login?error=` redirects | The web login page should render `?error=` |
| R-12 | Done | Hot List bulk: one read, then savepoints; set-based training bulk add; closure rebuilt once per transaction (deferred constraint trigger); set-based candidate bulk import | — |
| R-13 | **Partial** | `pg_trgm` GIN index on the name expression; shared `nameSearch()`; measured in `perf-baseline.md` | Only the Hot List paths (`authz_definer`) use the index (0.30–0.81× the previous time). RLS lists cannot use it, because ILIKE is not leakproof. The next step is a scoped definer name-match function or the `person_read` EXISTS cost, which needs its own security review |
| R-14 | Done | Shared `idempotent()` helper (4 sites); optional key on `POST /submissions`; advisory lock on (candidate, client) | Placements still checks the key before visibility (behaviour kept on purpose) |
| R-15 | Done | Per-user bulk-add budget of 2000 rows per day, stored in the DB; 429; counts in the audit row | — |
| Also | Done | R-18 (calendar calls Google after commit; provider errors → 503/502), E-10 (coach/panel double-booking → 409), E-04, E-08, C-05, A-10, D-01, F-14 (`__Host-` cookie, legacy name read for one release), B-03, D-13, and the rule-5 fixes in auth and admin bulk audit rows | Remove the legacy cookie fallback next release |

### Waves 3–4 (2026-11-05)

Owner decisions:
* **Admin is only admin:** a user holding an admin-trait role holds no data roles, and the reverse. Roles that break the admin/data split cannot be assigned. Existing violators are reported (`GET /admin/roles/violations`, `GET /admin/users/violations`), not stripped.
* **Restricted-document cap:** stays at 200 per user per day (`policy_setting restricted_opens_per_day`).

Migrations 0480 and 0484–0491 (0481–0483 unused). Independent security gate on the wave-3 diff: **ship**. Its 2 minors are fixed (a concurrent grant race, `e563506`; audit prune skipping late commits, `f3790d0`).

| Item | Status | What shipped | Notes / left |
|---|---|---|---|
| R-01b | Done | Per-user admin/data exclusivity (`separation_of_duties`); `role_violates_admin_separation`; `role_held_by_admin` trigger; role `classification`; users violations report; concurrency-safe (share locks, rows valid now or later) | Legacy mixed users keep their access until revoked (by decision) |
| R-13b, E-09 | Done | `authz.person_name_matches` / `interview_name_candidate_ids`: scoped, index-backed InitPlan sets | Rare names 0.00–0.09× the previous time; timeouts gone; common 3-character terms slower (8 → 51 ms). `person_read` unchanged (rewrites measured slower) |
| R-16 | Done | Jobs and batches in `state-machines.ts`; `job_guard` transition list; D-07 (Sales leads may set batch status, per TR-1); paperwork locked set; TS↔SQL parity test | Job lifecycle kept permissive (no rules defined in docs) |
| R-17 | Done | `AdminService` → 8 services; `CandidatesService` → 5 services plus `candidate-common`; team-scope check deduplicated | `scopePredicate` / cursor helpers could move to `platform/` (D-14) |
| R-19 | Done | `docs/openapi.json` (OpenAPI 3.1) generated from zod; `openapi:check` in CI; `@ApiBody` / `@ApiQuery` on all modules | Response bodies not yet described |
| R-20, R-26, R-28, R-30 | Done | `migrate.ts`: fresh run = incremental run (`-- since:` markers, session reset, lock-wait timeout, checksum verify); 0484 CHECKs validated; catalog-wide DB lint; SCRAM role passwords; 0485 location function owner | Check the deploy log for `0484:` WARNINGs |
| R-21, R-27 | Done | Separate outbox lane; dead-letter queue; session / step-up / applicant-session retention; `audit_event` kept forever unless `AUDIT_RETENTION_DAYS ≥ 365`, pruning only exported days | Set the production worker count ≥ 1 before go-live |
| R-23 | Done | `truncated` / cursor on capped lists; pipeline report single-pass with keyset paging (org-scope 1.2–2.8 s → ~0.55 s) | `offset` deprecated where cursors were added |
| R-24, R-25 | Done | Postgres-backed shared limiter for security limits; one statement per request for auth (no cache) | — |
| Web | Done | `?error=` messages; 503 / Retry-After retry; 429 and 412 messages; If-Match on edits; separation reports | e2e not run here (no Docker) |
| D-06 | Done | `set_batch_status` returns the previous status; the audit `from` is correct (0490) | — |

**Still open:** D-14 (move shared SQL helpers to `platform/`); response schemas in OpenAPI; an e2e journey for the new flows; removing the legacy `eureka_sid` fallback next release; mandatory If-Match (needs approval).

## Appendix A — all findings

| ID | Severity | Doc | Title |
|---|---|---|---|
| B-01 | High | [security-review.md](security-review.md#b-01--restricted-documents-i-9-driving-license-work-authorization-open-without-step-up-code-docs-and-ttls-still-assume-it) | Restricted documents (I-9, driving license, work authorization) open without step-up; code, docs and TTLs still assume it |
| C-01 | High | [security-review.md](security-review.md#c-01--one-admin-can-mint-new-accessmanage-holders-and-give-admin-trait-roles-data-permissions-without-the-second-approver) | One admin can mint new `access:manage` holders (and give admin-trait roles data permissions) without the second approver |
| E-01 | High | [security-review.md](security-review.md#e-01--portal-global-hourly-caps-let-a-few-addresses-lock-every-applicant-out-of-sign-in-silently) | Portal global hourly caps let a few addresses lock every applicant out of sign-in, silently |
| E-02 | High | [performance-review.md](performance-review.md#e-02--report-endpoints-can-hold-every-pool-connection-for-60-s-the-pool-has-no-acquire-timeout-and-limiters-are-per-task) | Report endpoints can hold every pool connection for 60 s; the pool has no acquire timeout and limiters are per task |
| F-01 | High | [architecture.md](architecture.md#f-01--api-pg-pool-has-no-error-listener-idle-connection-errors-crash-the-process) | API pg pool has no `error` listener; idle-connection errors crash the process |
| A-01 | Medium | [security-review.md](security-review.md#a-01--bulk-import-dry-run-reveals-whether-a-contact-exists-250-past-the-duplicate-check-limit) | Bulk-import dry run reveals whether a contact exists, 250× past the duplicate-check limit |
| A-02 | Medium | [api-review.md](api-review.md#a-02--candidate-and-submission-edits-have-no-optimistic-concurrency-row_version-unused-or-absent) | Candidate and submission edits have no optimistic concurrency (row_version unused, or absent) |
| A-03 | Medium | [performance-review.md](performance-review.md#a-03--hot-list-bulk-actions-run-as-a-sequential-n1-of-full-single-record-transactions) | Hot List bulk actions run as a sequential N+1 of full single-record transactions |
| A-04 | Medium | [security-review.md](security-review.md#a-04--application-csv-export-writes-unmasked-applicant-emails-to-callers-without-applicantread) | Application CSV export writes unmasked applicant emails to callers without `applicant:read` |
| A-05 | Medium | [performance-review.md](performance-review.md#a-05--search-and-sort-on-lists-are-not-index-backed-leading-wildcard-ilike-no-pg_trgm-expression-sort-keys) | Search and sort on lists are not index-backed (leading-wildcard ILIKE, no pg_trgm; expression sort keys) |
| A-06 | Medium | [api-review.md](api-review.md#a-06--post-submissions-has-no-idempotency-and-the-duplicate-check-is-a-non-locking-warning) | `POST /submissions` has no idempotency, and the duplicate check is a non-locking warning |
| B-02 | Medium | [architecture.md](architecture.md#b-02--payments-summary-under-reports-outstanding-and-sums-money-in-js-floats) | Payments summary under-reports `outstanding` (and sums money in JS floats) |
| B-03 | Medium | [api-review.md](api-review.md#b-03--optimistic-concurrency-is-optional-or-absent-on-shared-hrpaperwork-records-inconsistent-status-codes) | Optimistic concurrency is optional or absent on shared HR/paperwork records; inconsistent status codes |
| B-04 | Medium | [security-review.md](security-review.md#b-04--contracts-api-does-no-permission-pre-check-and-its-canadd-hint-diverges-from-authzcreate_contract) | Contracts: API does no permission pre-check and its `canAdd` hint diverges from `authz.create_contract` |
| B-05 | Medium | [performance-review.md](performance-review.md#b-05--paperwork-work-queue-aggregates-every-visible-placement-on-every-page) | Paperwork work queue aggregates every visible placement on every page |
| C-02 | Medium | [api-review.md](api-review.md#c-02--role-grants-and-traits-are-replaced-with-no-optimistic-concurrency-lost-update-on-a-security-critical-record) | Role grants and traits are replaced with no optimistic concurrency (lost update on a security-critical record) |
| C-03 | Medium | [performance-review.md](performance-review.md#c-03--org-chart-apply-and-bulk-user-import-rebuild-the-whole-reporting-closure-once-per-rowmove) | Org-chart apply and bulk user import rebuild the whole reporting closure once per row/move |
| C-04 | Medium | [architecture.md](architecture.md#c-04--adminservice-is-a-13k-line-multi-domain-class-scope-rules-duplicated-across-methods) | AdminService is a 1.3K-line multi-domain class; scope rules duplicated across methods |
| D-01 | Medium | [security-review.md](security-review.md#d-01--public-feedback-ip-rate-limit-is-keyed-on-the-raw-address-ipv6-rotation-bypass) | Public feedback IP rate limit is keyed on the raw address (IPv6 rotation bypass) |
| D-02 | Medium | [performance-review.md](performance-review.md#d-02--chat-db-rate-limits-scan-the-senders-entire-message-history) | Chat DB rate limits scan the sender's entire message history |
| D-03 | Medium | [performance-review.md](performance-review.md#d-03--every-batch-read-and-write-evaluates-the-full-authztraining_batches-set) | Every batch read and write evaluates the full `authz.training_batches()` set |
| D-04 | Medium | [performance-review.md](performance-review.md#d-04--bulk-add-of-students-up-to-200-sequential-definer-calls-in-one-transaction) | Bulk add of students: up to 200 sequential definer calls in one transaction |
| D-05 | Medium | [performance-review.md](performance-review.md#d-05--org-scope-performance-reports-run-with-a-60-s-statement-timeout-on-the-shared-pool) | Org-scope performance reports run with a 60 s statement timeout on the shared pool |
| E-03 | Medium | [performance-review.md](performance-review.md#e-03--pipeline-report-evaluates-the-full-history-cte-twice-per-request-then-sorts-a-computed-name-with-deep-offset) | Pipeline report evaluates the full-history CTE twice per request, then sorts a computed name with deep OFFSET |
| E-04 | Medium | [api-review.md](api-review.md#e-04--interview-edits-have-no-optimistic-concurrency-lost-updates-and-clear-and-select-checks-before-it-writes) | Interview edits have no optimistic concurrency (lost updates), and clear-and-select checks before it writes |
| E-05 | Medium | [architecture.md](architecture.md#e-05--calendar-blockrelease-call-google-inside-an-open-db-transaction-failures-leave-orphan-events-or-surface-as-500) | Calendar block/release call Google inside an open DB transaction; failures leave orphan events or surface as 500 |
| E-06 | Medium | [performance-review.md](performance-review.md#e-06--dashboard-needs-attention-is-recomputed-on-every-view-counts-unbounded-history-and-ignores-the-period) | Dashboard "needs attention" is recomputed on every view, counts unbounded history and ignores the period |
| E-07 | Medium | [security-review.md](security-review.md#e-07--portal-deferred-work-unbounded-in-process-queue-on-the-shared-pool-never-drained-on-shutdown) | Portal deferred work: unbounded in-process queue on the shared pool, never drained on shutdown |
| E-09 | Medium | [performance-review.md](performance-review.md#e-09--interview-board-search-runs-a-security-definer-function-per-row-inside-where-with-an-unindexable-ilike) | Interview board search runs a SECURITY DEFINER function per row inside WHERE, with an unindexable ILIKE |
| F-02 | Medium | [performance-review.md](performance-review.md#f-02--pool-starvation-60-s-report-queries-vs-29-s-gateway-timeout-pool-of-5-no-connect-timeout-db-coupled-health-check) | Pool starvation: 60 s report queries vs 29 s gateway timeout, pool of 5, no connect timeout, DB-coupled health check |
| F-03 | Medium | [performance-review.md](performance-review.md#f-03--per-request-authentication-cost-2-pool-checkouts-and-56-round-trips-before-the-handler-runs) | Per-request authentication cost: 2 pool checkouts and ~5–6 round trips before the handler runs |
| F-04 | Medium | [architecture.md](architecture.md#f-04--no-request-correlation-structured-logging-metrics-or-access-logs-in-the-api-5xx-logs-lack-context-denials-unlogged) | No request correlation, structured logging, metrics or access logs in the API; 5xx logs lack context; denials unlogged |
| F-05 | Medium | [api-review.md](api-review.md#f-05--oidc-sign-in-failures-surface-as-500-json-token-exchange-has-no-timeout) | OIDC sign-in failures surface as 500 JSON; token exchange has no timeout |
| F-07 | Medium | [api-review.md](api-review.md#f-07--idempotency-is-implemented-four-times-with-drift-and-covers-only-five-posts) | Idempotency is implemented four times with drift and covers only five POSTs |
| F-08 | Medium | [security-review.md](security-review.md#f-08--authguard-is-default-allow-for-any-signed-in-user-no-route-authz-inventory-test) | AuthGuard is default-allow for any signed-in user; no route-authz inventory test |
| F-09 | Low (go-live gate) | [architecture.md](architecture.md#f-09--production-worker-is-not-deployed-no-outbox-delivery-document-promotion-idempotency-cleanup-or-user-purge) | Production worker is not deployed: no outbox delivery, document promotion, idempotency cleanup or user purge |
| G-01 | Medium | [security-review.md](security-review.md#g-01--eurekaperson-table-wide-insertupdate-for-eureka_app-with-no-column-guard) | eureka.person: table-wide INSERT/UPDATE for eureka_app with no column guard |
| G-02 | Medium | [security-review.md](security-review.md#g-02--eureka_worker-can-call-authztransition_candidate-and-can-choose-its-own-identity-so-the-worker-can-act-as-any-user) | eureka_worker can call authz.transition_candidate and can choose its own identity, so the worker can act as any user |
| G-03 | Medium | [security-review.md](security-review.md#g-03--candidate-writes-rely-on-table-wide-update-plus-denylist-column-guards) | Candidate writes rely on table-wide UPDATE plus denylist column guards |
| G-04 | Medium | [performance-review.md](performance-review.md#g-04--name-search-is-a-leading-wildcard-ilike-over-a-concatenated-expression-and-no-trigram-index-exists-anywhere) | Name search is a leading-wildcard ILIKE over a concatenated expression, and no trigram index exists anywhere |
| G-05 | Medium | [architecture.md](architecture.md#g-05--migratets-fresh-and-incremental-databases-run-migrations-under-different-conditions) | migrate.ts: fresh and incremental databases run migrations under different conditions |
| A-07 | Low | [performance-review.md](performance-review.md#a-07--bulk-add-to-batch-runs-up-to-500-rows-one-at-a-time-inside-a-single-long-transaction) | Bulk add to batch runs up to 500 rows one at a time inside a single long transaction |
| A-08 | Low | [performance-review.md](performance-review.md#a-08--hot-list-export-builds-up-to-50000-rows-as-one-in-memory-string-with-a-60-s-statement-timeout) | Hot List export builds up to 50,000 rows as one in-memory string with a 60 s statement timeout |
| A-09 | Low | [performance-review.md](performance-review.md#a-09--submissions-summary-aggregates-the-callers-entire-scoped-set-on-every-call) | Submissions `summary` aggregates the caller's entire scoped set on every call |
| A-10 | Low | [security-review.md](security-review.md#a-10--candidate-birth-year-is-returned-to-every-candidate-reader-outside-the-field-policy) | Candidate birth year is returned to every candidate reader, outside the field policy |
| A-11 | Low | [architecture.md](architecture.md#a-11--job-status-is-a-free-patch-field-with-no-lifecycle-model) | Job status is a free PATCH field with no lifecycle model |
| A-12 | Low | [api-review.md](api-review.md#a-12--get-batches-truncates-at-200-rows-without-telling-the-client) | `GET /batches` truncates at 200 rows without telling the client |
| A-13 | Low | [api-review.md](api-review.md#a-13--error-mapping-inaccuracies-dead-branch-mislabelled-bulk-error) | Error-mapping inaccuracies (dead branch, mislabelled bulk error) |
| B-06 | Low | [performance-review.md](performance-review.md#b-06--unindexed-substring-name-search-on-concatenated-person-names) | Unindexed substring name search on concatenated person names |
| B-07 | Low | [api-review.md](api-review.md#b-07--silent-truncation-without-pagination-on-several-lists-access-log-keyset-loses-ties) | Silent truncation without pagination on several lists; access-log keyset loses ties |
| B-08 | Low | [architecture.md](architecture.md#b-08--hand-rolled-placement-status-literals-in-paperwork-paths) | Hand-rolled placement-status literals in paperwork paths |
| B-09 | Low | [security-review.md](security-review.md#b-09--in-memory-per-process-rate-limits-on-document-downloadsuploads-and-exports) | In-memory per-process rate limits on document downloads/uploads and exports |
| B-10 | Low | [architecture.md](architecture.md#b-10--today-computed-in-the-db-session-time-zone-in-paperworkemployees-new-york-elsewhere) | "Today" computed in the DB session time zone in paperwork/employees, New York elsewhere |
| B-11 | Low | [api-review.md](api-review.md#b-11--idempotency-gaps-and-ordering-differences-on-create-style-posts) | Idempotency gaps and ordering differences on create-style POSTs |
| B-12 | Low | [security-review.md](security-review.md#b-12--get-document-access-has-no-requirepermission) | `GET /document-access` has no `@RequirePermission` |
| C-05 | Low | [security-review.md](security-review.md#c-05--audit-rows-for-created-users-teams-and-locations-carry-free-text-that-the-rename-paths-deliberately-omit-rule-5) | Audit rows for created users, teams and locations carry free text that the rename paths deliberately omit (rule 5) |
| C-06 | Low | [architecture.md](architecture.md#c-06--team-addable-picker-hard-codes-role_key--recruiter-custom-recruiter-roles-never-appear) | Team "addable" picker hard-codes `role_key = 'recruiter'`; custom recruiter roles never appear |
| C-07 | Low | [security-review.md](security-review.md#c-07--password-lockout-reveals-which-emails-have-accounts-and-lets-anyone-lock-a-user-out-staginglocal-only) | Password lockout reveals which emails have accounts and lets anyone lock a user out (staging/local only) |
| C-08 | Low | [security-review.md](security-review.md#c-08--xlsx-import-bounds-the-compressed-size-only-the-workbook-is-fully-expanded-before-rowcolumn-checks) | xlsx import bounds the compressed size only; the workbook is fully expanded before row/column checks |
| C-09 | Low | [api-review.md](api-review.md#c-09--several-adminstaff-lists-are-unpaginated-or-silently-truncated) | Several admin/staff lists are unpaginated or silently truncated |
| D-06 | Low | [architecture.md](architecture.md#d-06--batch-lifecycle-is-hand-rolled-sql-tuples-plus-ts-literals-not-in-state-machinests) | Batch lifecycle is hand-rolled (SQL tuples plus TS literals), not in `state-machines.ts` |
| D-07 | Low | [api-review.md](api-review.md#d-07--batch-status-route-permission-contradicts-the-docs-and-the-db-rule) | Batch status route permission contradicts the docs and the DB rule |
| D-08 | Low | [performance-review.md](performance-review.md#d-08--chat-conversation-list-does-per-conversation-work-for-all-of-the-callers-conversations-on-every-poll) | Chat conversation list does per-conversation work for all of the caller's conversations on every poll |
| D-09 | Low | [performance-review.md](performance-review.md#d-09--target-list-three-correlated-count-subqueries-per-row-outside-the-report-timeout-handling) | Target list: three correlated count subqueries per row, outside the report timeout handling |
| D-10 | Low | [api-review.md](api-review.md#d-10--lists-that-are-silently-capped-or-paginated-without-pagination) | Lists that are silently capped or "paginated" without pagination |
| D-11 | Low | [api-review.md](api-review.md#d-11--public-feedback-endpoint-no-api-doc-sql-in-the-controller-no-abuse-telemetry) | Public feedback endpoint: no API doc, SQL in the controller, no abuse telemetry |
| D-12 | Low | [security-review.md](security-review.md#d-12--route-authorisation-intent-is-not-machine-checkable-no-exemption-marker-no-route-meta-test) | Route authorisation intent is not machine-checkable (no exemption marker, no route meta-test) |
| D-13 | Low | [api-review.md](api-review.md#d-13--bill-void-has-no-optimistic-concurrency-token) | Bill void has no optimistic-concurrency token |
| D-14 | Low | [architecture.md](architecture.md#d-14--cross-module-coupling-through-other-services-internals) | Cross-module coupling through other services' internals |
| E-08 | Low | [security-review.md](security-review.md#e-08--interview-audit-rows-store-free-text-round-systemname-violating-rule-5) | Interview audit rows store free text (`round`, `systemName`), violating rule 5 |
| E-10 | Low | [architecture.md](architecture.md#e-10--double-booking-is-prevented-per-candidate-only-coach-and-panel-members-can-be-booked-into-overlapping-interviews) | Double-booking is prevented per candidate only; coach and panel members can be booked into overlapping interviews |
| E-11 | Low | [performance-review.md](performance-review.md#e-11--interview-report-totals-come-from-a-separate-transaction-and-scan-daily-totals-come-from-capped-rows) | Interview report totals come from a separate transaction and scan; daily totals come from capped rows |
| E-12 | Low | [architecture.md](architecture.md#e-12--portal-redeem-and-sign-up-audit-are-not-in-one-transaction-with-the-state-change) | Portal redeem and sign-up audit are not in one transaction with the state change |
| F-06 | Low | [security-review.md](security-review.md#f-06--application-rate-limits-are-in-memory-per-task-and-reset-on-deploy) | Application rate limits are in memory per task and reset on deploy |
| F-10 | Low | [performance-review.md](performance-review.md#f-10--worker-runs-every-job-serially-outbox-waits-behind-long-jobs-no-dead-letter-state) | Worker runs every job serially; outbox waits behind long jobs; no dead-letter state |
| F-11 | Low | [api-review.md](api-review.md#f-11--central-db-error-mapping-misses-timeout-serialization-deadlock-and-connection-limit-codes) | Central DB error mapping misses timeout, serialization, deadlock and connection-limit codes |
| F-12 | Low | [architecture.md](architecture.md#f-12--tssql-state-machine-parity-is-only-verified-for-checklist-and-bgc) | TS/SQL state-machine parity is only verified for checklist and BGC |
| F-13 | Low | [security-review.md](security-review.md#f-13--staff-session-table-sits-outside-rls-with-direct-table-grants-to-the-api-role) | Staff session table sits outside RLS with direct table grants to the API role |
| F-14 | Low | [security-review.md](security-review.md#f-14--staff-session-cookie-hardening-is-weaker-than-the-portal-cookie) | Staff session cookie hardening is weaker than the portal cookie |
| G-06 | Low | [security-review.md](security-review.md#g-06--role-passwords-are-sent-as-plaintext-literals-in-alter-role) | Role passwords are sent as plaintext literals in ALTER ROLE |
| G-07 | Low | [performance-review.md](performance-review.md#g-07--every-org-change-rewrites-every-app_user-row-to-bump-access_version-which-nothing-reads) | Every org change rewrites every app_user row to bump access_version, which nothing reads |
| G-08 | Low | [performance-review.md](performance-review.md#g-08--no-retention-for-staff-sessions-step-up-rows-verified-applicants-sessions-or-audit_event) | No retention for staff sessions, step-up rows, verified applicants' sessions or audit_event |
| G-09 | Low | [architecture.md](architecture.md#g-09--six-not-valid-check-constraints-were-never-validated) | Six NOT VALID CHECK constraints were never validated |
| G-10 | Low | [architecture.md](architecture.md#g-10--core-free-text-and-contact-columns-have-no-db-length-or-control-character-checks) | Core free-text and contact columns have no DB length or control-character checks |
| G-11 | Low | [architecture.md](architecture.md#g-11--no-catalog-wide-lint-for-rls-definer-hardening-and-role-acls) | No catalog-wide lint for RLS, definer hardening and role ACLs |
