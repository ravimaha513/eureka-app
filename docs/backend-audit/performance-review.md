# Eureka backend — database and performance review

> Part of the 2026-11-05 backend audit. **No measurements were taken.** Every finding is labelled:
> **PROVEN** means the problem is visible in code, query shape or configuration (for example a loop that
> issues queries, or a predicate that no index can serve); **HYPOTHESIS** means the latency or load impact
> needs `EXPLAIN (ANALYZE, BUFFERS)` or load testing on realistic data. No improvement is claimed without a
> before/after measurement.

## 1. Verdict

The query layer is careful: parameterised SQL, keyset pagination, RLS in InitPlan form (one authz evaluation per statement, asserted in tests through `ownedCandidateCalls`), and caps on most lists. The real risk is not a slow query in isolation but **how slow queries interact with a small connection pool**:

* API pool: **5 connections per task** (`infra/modules/stack/app.tf:565`), no `connectionTimeoutMillis`, so a request waits for a connection indefinitely. Default `statement_timeout` is 5 s.
* **9 places raise `statement_timeout` to 60 s** (reports, exports), but API Gateway abandons the request at **29 s**. The query keeps its connection for up to 31 s after the client has gone.
* `/api/health` needs a connection from the same pool.

→ A handful of concurrent heavy reports can make an API task unresponsive and fail its health check (**R-03**: E-02, D-05, F-02). This configuration mismatch is **PROVEN**; how often it happens in production is a **HYPOTHESIS**.

## 2. Proven vs hypothesis

| ID | Area | What is proven | What needs measurement |
|---|---|---|---|
| E-02 / D-05 / F-02 | Pool starvation | 60 s timeouts against a 29 s gateway and a pool of 5 with no acquire timeout | Real report durations at production volumes |
| A-03 | Hot List bulk | ~600 sequential round trips and 101 pool checkouts per 100 ids | Wall-clock time per request |
| D-04 | Training bulk add | Up to 200 sequential definer calls in one transaction | — |
| C-03 | Org-chart apply / user import | Full reporting-closure rebuild per move or row under a global advisory lock | Lock hold time |
| E-03 | Pipeline report | Full-history CTE evaluated twice per request; OFFSET up to 10,000 on a computed sort key | Latency at production history size |
| E-09 | Interview board search | A SECURITY DEFINER function called per row inside `WHERE` | Row counts |
| E-11 | Interview report | Totals come from a second transaction and scan | — |
| G-04 / A-05 / B-06 | Name search | Leading-wildcard ILIKE on a concatenation, so no B-tree can serve it; **no `pg_trgm` index exists anywhere** | Latency, which depends on visible-row counts |
| D-02 | Chat rate limit | Counts by `sender_id` + time window, but the only index is `(sender_id, client_id)` | Cost per send for heavy users |
| G-07 | access_version | Every org change rewrites every `app_user` row for a value nothing reads | Lock and WAL impact |
| B-05 | Paperwork queue | Aggregates and sorts every visible placement on every page | Latency |
| E-06 | Dashboard attention lists | `count(*) OVER()` over unbounded history, recomputed per view | Latency |
| F-03 | Auth per request | 2 checkouts and ~5–6 round trips before the handler | Share of p50 latency |
| A-07, A-08, A-09, D-03, D-08, D-09, F-10, G-08 | Various | See findings | All HYPOTHESIS on magnitude |

## 3. Indexes

* **Missing (proven by query shape):**
  * trigram GIN on the person/applicant name expression (G-04)
  * `chat_message (sender_id, created_at)` (D-02)
  * expression indexes for the candidate and Hot List sort keys (A-05)
* **FK columns:** a scripted check found **132 of 278 FK columns without a leading index**. They are mostly actor columns (`created_by`, `decided_by`, …) that point at `app_user` rows, and users are anonymised rather than deleted, so FK checks on delete do not fire. **Do not bulk-add these indexes**: each one costs write amplification. Add them only where a query filters or joins on the column.
* **Redundant indexes:** none found (a scripted prefix-duplicate check). Index migrations document their purpose (e.g. 0310).
* **Recommendation:** add indexes only together with an `EXPLAIN` showing they are used. For name search, prefer **one immutable expression** (for example `lower(first_name || ' ' || last_name)`) shared by query and index, wrapped in a `nameSearch()` SQL/TS helper so ten services stop open-coding it.

## 4. N+1 and unbounded operations

* **N+1 loops (proven):** Hot List bulk (A-03), training bulk add (D-04), the closure rebuild per row (C-03), bulk candidate import row by row (A-07), and the chat conversation list doing per-conversation work on every poll (D-08, magnitude HYPOTHESIS).
* **Unbounded or silently capped:** lists capped at 200/500/2000 without `truncated` or a cursor (A-12, B-07, C-09, D-10); dashboard attention counts (E-06); submissions `summary` over the whole scoped set (A-09); Hot List export building 50k rows in memory (A-08).
* **Retention:** no purge for staff sessions, step-up rows, verified applicants' sessions or `audit_event` (G-08). Outbox, idempotency and notifications do have prune jobs.

## 5. Transactions, contention and races

* **Long transactions:** bulk import (A-07) and training bulk add (D-04) hold one transaction for up to 500 or 200 rows. The closure rebuild takes a **global advisory lock** per row (C-03).
* **Third-party I/O inside a DB transaction:** calendar block/release calls Google while the transaction is open, holding a connection and risking orphan events (E-05).
* **Races:** submission duplicate check without a lock (A-06); interview clear-and-select check-then-write (E-04); coach/panel double-booking (E-10); lost updates on every resource without `If-Match` (R-10).
* **Worker:** a single serial loop, so outbox delivery waits behind long jobs (F-10).

## 6. Caching opportunities

Authz facts must **not** be cached: revocation must take effect immediately, and team and reporting changes do not bump `access_version` (F-03, G-07). Where caching is safe and useful:

1. **Report and dashboard aggregates** (E-06, E-03, D-05): short-TTL cache keyed by `(user scope hash, params)`, or materialised daily snapshots for org-wide history. Measure first.
2. **Lookups / reference data**: process-local cache with explicit invalidation on admin writes. Low value until lookups grow (C-09).
3. **Auth per request**: collapse session resolve and access load into **one query in one checkout** (F-03). This removes round trips without caching anything.

## 7. Measurement plan (do this before any perf refactor)

1. Seed realistic volume with `pnpm --filter @eureka/api db:seed-load` (it already exists) to production-like candidate, placement, interview and message counts.
2. Turn on `pg_stat_statements` and `auto_explain` (`log_min_duration = 500ms`) in staging.
3. Capture `EXPLAIN (ANALYZE, BUFFERS)` as an org-scope user and as a team-scope user for: candidate list with search and each sort, Hot List page, pipeline report, paperwork queue, dashboard, interview board search, chat send.
4. Load test (k6 or autocannon) with 5 concurrent org-scope report requests plus a steady stream of list traffic; record pool wait time and health-check latency.
5. Record the baselines in `docs/backend-audit/perf-baseline.md`. Every perf PR then quotes before/after numbers.

## 8. Performance findings

| ID | Severity | Title |
|---|---|---|
| [E-02](#e-02--report-endpoints-can-hold-every-pool-connection-for-60-s-the-pool-has-no-acquire-timeout-and-limiters-are-per-task) | High | Report endpoints can hold every pool connection for 60 s; the pool has no acquire timeout and limiters are per task |
| [A-03](#a-03--hot-list-bulk-actions-run-as-a-sequential-n1-of-full-single-record-transactions) | Medium | Hot List bulk actions run as a sequential N+1 of full single-record transactions |
| [A-05](#a-05--search-and-sort-on-lists-are-not-index-backed-leading-wildcard-ilike-no-pg_trgm-expression-sort-keys) | Medium | Search and sort on lists are not index-backed (leading-wildcard ILIKE, no pg_trgm; expression sort keys) |
| [B-05](#b-05--paperwork-work-queue-aggregates-every-visible-placement-on-every-page) | Medium | Paperwork work queue aggregates every visible placement on every page |
| [C-03](#c-03--org-chart-apply-and-bulk-user-import-rebuild-the-whole-reporting-closure-once-per-rowmove) | Medium | Org-chart apply and bulk user import rebuild the whole reporting closure once per row/move |
| [D-02](#d-02--chat-db-rate-limits-scan-the-senders-entire-message-history) | Medium | Chat DB rate limits scan the sender's entire message history |
| [D-03](#d-03--every-batch-read-and-write-evaluates-the-full-authztraining_batches-set) | Medium | Every batch read and write evaluates the full `authz.training_batches()` set |
| [D-04](#d-04--bulk-add-of-students-up-to-200-sequential-definer-calls-in-one-transaction) | Medium | Bulk add of students: up to 200 sequential definer calls in one transaction |
| [D-05](#d-05--org-scope-performance-reports-run-with-a-60-s-statement-timeout-on-the-shared-pool) | Medium | Org-scope performance reports run with a 60 s statement timeout on the shared pool |
| [E-03](#e-03--pipeline-report-evaluates-the-full-history-cte-twice-per-request-then-sorts-a-computed-name-with-deep-offset) | Medium | Pipeline report evaluates the full-history CTE twice per request, then sorts a computed name with deep OFFSET |
| [E-06](#e-06--dashboard-needs-attention-is-recomputed-on-every-view-counts-unbounded-history-and-ignores-the-period) | Medium | Dashboard "needs attention" is recomputed on every view, counts unbounded history and ignores the period |
| [E-09](#e-09--interview-board-search-runs-a-security-definer-function-per-row-inside-where-with-an-unindexable-ilike) | Medium | Interview board search runs a SECURITY DEFINER function per row inside WHERE, with an unindexable ILIKE |
| [F-02](#f-02--pool-starvation-60-s-report-queries-vs-29-s-gateway-timeout-pool-of-5-no-connect-timeout-db-coupled-health-check) | Medium | Pool starvation: 60 s report queries vs 29 s gateway timeout, pool of 5, no connect timeout, DB-coupled health check |
| [F-03](#f-03--per-request-authentication-cost-2-pool-checkouts-and-56-round-trips-before-the-handler-runs) | Medium | Per-request authentication cost: 2 pool checkouts and ~5–6 round trips before the handler runs |
| [G-04](#g-04--name-search-is-a-leading-wildcard-ilike-over-a-concatenated-expression-and-no-trigram-index-exists-anywhere) | Medium | Name search is a leading-wildcard ILIKE over a concatenated expression, and no trigram index exists anywhere |
| [A-07](#a-07--bulk-add-to-batch-runs-up-to-500-rows-one-at-a-time-inside-a-single-long-transaction) | Low | Bulk add to batch runs up to 500 rows one at a time inside a single long transaction |
| [A-08](#a-08--hot-list-export-builds-up-to-50000-rows-as-one-in-memory-string-with-a-60-s-statement-timeout) | Low | Hot List export builds up to 50,000 rows as one in-memory string with a 60 s statement timeout |
| [A-09](#a-09--submissions-summary-aggregates-the-callers-entire-scoped-set-on-every-call) | Low | Submissions `summary` aggregates the caller's entire scoped set on every call |
| [B-06](#b-06--unindexed-substring-name-search-on-concatenated-person-names) | Low | Unindexed substring name search on concatenated person names |
| [D-08](#d-08--chat-conversation-list-does-per-conversation-work-for-all-of-the-callers-conversations-on-every-poll) | Low | Chat conversation list does per-conversation work for all of the caller's conversations on every poll |
| [D-09](#d-09--target-list-three-correlated-count-subqueries-per-row-outside-the-report-timeout-handling) | Low | Target list: three correlated count subqueries per row, outside the report timeout handling |
| [E-11](#e-11--interview-report-totals-come-from-a-separate-transaction-and-scan-daily-totals-come-from-capped-rows) | Low | Interview report totals come from a separate transaction and scan; daily totals come from capped rows |
| [F-10](#f-10--worker-runs-every-job-serially-outbox-waits-behind-long-jobs-no-dead-letter-state) | Low | Worker runs every job serially; outbox waits behind long jobs; no dead-letter state |
| [G-07](#g-07--every-org-change-rewrites-every-app_user-row-to-bump-access_version-which-nothing-reads) | Low | Every org change rewrites every app_user row to bump access_version, which nothing reads |
| [G-08](#g-08--no-retention-for-staff-sessions-step-up-rows-verified-applicants-sessions-or-audit_event) | Low | No retention for staff sessions, step-up rows, verified applicants' sessions or audit_event |

### Talent core (candidates, applications, submissions, hotlist, resumes, jobs)

#### A-03 · Hot List bulk actions run as a sequential N+1 of full single-record transactions

- Module / files: `apps/api/src/modules/hotlist/hotlist.service.ts:126-136, 164-186`; `hotlist.schemas.ts:107-109`; `candidates.service.ts:536-547` (`loadForWrite`)
- Category: Performance (PROVEN)
- Severity: Medium
- Existing implementation: `for (const id of ids) { await one(id) }` with up to `BULK_MAX = 100` ids. Each `one(id)` is `CandidatesService.setVisibility`, `transition` or `updateProfile`. Each of those opens its own `withUser` transaction: BEGIN, set user, an 11-join `baseSelect` read through `loadForWrite`, a definer call or UPDATE with per-row guard triggers, an audit INSERT, then COMMIT. At the end there is one more transaction for the summary audit.
- Problem: A 100-id request makes about 600 sequential DB round trips and takes and releases a pool connection 101 times. Latency grows linearly with the number of ids, so one request can take seconds and risk proxy timeouts, and 10 such requests per minute per user (`BULK_REQUESTS_PER_MINUTE`) add up to many short transactions. Partial failure is intended and documented, but there is no atomic option.
- Recommended solution: Keep per-record outcomes but batch the read and the authorization. Run one `baseSelect … WHERE c.id = ANY($1) AND scopePredicate` to sort ids into not_found or forbidden in memory. Then, in one transaction, run a SAVEPOINT per eligible id for the write: definer or UPDATE plus a per-record audit. That keeps per-record DB re-checks and per-id results with one round-trip chain. For priority, a single `UPDATE … WHERE id = ANY($1) RETURNING id` is enough, because the column guard still checks each row.
- Alternatives & trade-offs: (a) Bounded parallelism (for example 5 at a time) with the current code. This is simpler but multiplies pool use. (b) Set-based definer functions (`authz.bulk_transition_candidates(uuid[], text)` returning `(id, error)`). This is the fastest option but adds new SQL surface that needs security review.
- Expected benefit: Fewer round trips and fewer pool checkouts per bulk call. The size of the latency gain needs measuring.
- Complexity: M
- Regression risks: Per-record error codes must stay identical (tests at `hotlist-extras.api.int.test.ts:144-224`). Savepoint rollback must not leak a partial audit.
- Required tests: Existing partial-result tests. A 100-id request with mixed outcomes. An audit count per success.
- Breaking API change?: no

#### A-05 · Search and sort on lists are not index-backed (leading-wildcard ILIKE, no pg_trgm; expression sort keys)

- Module / files: `candidates.service.ts:431-434` (`(p.first_name || ' ' || p.last_name) ILIKE`), `:136-143, 435-445` (sort keys `lower(first||' '||last)`, `coalesce(marketing_start_date,'infinity')`, `priority`); `db/functions/authz/hotlist_page.sql:53, 70`; `submissions.service.ts:305, 310-313`; `applications.service.ts:152, 377`; `jobs.service.ts:186`. No `pg_trgm` / `gin_trgm_ops` / `to_tsvector` anywhere in `db/migrations` or `db/functions` (grep).
- Category: Performance (HYPOTHESIS)
- Severity: Medium
- Existing implementation: Every list search is `col ILIKE '%term%'`, safely escaped by `likeContains` (`platform/sql.ts`). The candidate list and Hot List also support `sort=name|days|priority` with keyset paging on `(expr, id)`. The only candidate indexes are on scope columns (`0003:56-59`), `batch_id`, `created_at` and `technology_id, marketing_status` (`0310:32`).
- Problem: A leading-wildcard ILIKE on a concatenation cannot use a B-tree index, so every search page scans the visible candidate, person and applicant rows and sorts them. With expression sort keys, each keyset page also sorts the whole filtered set, not just the next `limit+1` rows. The cost grows with the size of the candidate and applicant tables and the 5 s `statement_timeout` puts a ceiling on it. The Hot List lets each user load 60 pages a minute, and org-scope users have no scope predicate to narrow the scan.
- Recommended solution: Run EXPLAIN ANALYZE first on production-sized data. If confirmed, `CREATE EXTENSION pg_trgm` (check it can be done as non-superuser on RDS, rule 7, since `pg_trgm` is a trusted extension) and add a GIN trigram index on `lower(first_name || ' ' || last_name)` for `eureka.person`, and the same for `eureka.applicant`, `job.title` and `client.name`. Write the predicates against the same expression. Add B-tree indexes on `(lower(first||' '||last), id)` via person, or store a generated `name_sort` column on candidate if name sort is used often, plus `(priority, id)`.
- Alternatives & trade-offs: Full-text `tsvector` gives better relevance but loses substring matching on partial names. A minimum search length (≥3 characters) helps trigram selectivity. A generated column adds write cost.
- Expected benefit: Search and sort cost scales with the matches rather than the table size, if the hypothesis is confirmed.
- Complexity: M
- Regression risks: The migration needs extension privileges. Index build time on large tables; use `CREATE INDEX CONCURRENTLY` outside a transaction if the migration runner allows it.
- Required tests: The existing search tests. An EXPLAIN-based test or a check script asserting index use on seeded volume.
- Breaking API change?: no

#### A-07 · Bulk add to batch runs up to 500 rows one at a time inside a single long transaction

- Module / files: `candidates.service.ts:879-946` (loop `:897-929`); `candidates.schemas.ts:219-231`; `0260_candidate_unique_contact.sql:40-51` (advisory locks)
- Category: Performance (HYPOTHESIS)
- Severity: Low
- Existing implementation: Per row: SAVEPOINT, INSERT person, INSERT candidate (BEFORE triggers: profile guard, insert guard, batch check, team invariant, contact-unique with 2 advisory xact locks; AFTER: candidate_event), audit INSERT, RELEASE. That is about 6 round trips per row, roughly 3,000 per call, all in one transaction that holds up to 1,000 advisory locks until commit or rollback. `statement_timeout` is 5 s per statement, but nothing bounds the transaction as a whole (`db.service.ts:20`, no `idle_in_transaction_session_timeout` / `transaction_timeout`).
- Problem: A 500-row preview holds one pool connection and the contact locks for the whole loop, and runs again on every preview. Concurrent single creates of any of those contacts wait on the advisory locks. The duration is unmeasured.
- Recommended solution: Validate in memory first (already done). Check contacts set-based with one `authz` function taking `text[]` emails and phones that returns which are taken, then insert with one multi-row `INSERT … SELECT unnest(...)`, keeping per-row audit via `INSERT … SELECT`. For `dryRun`, skip the inserts entirely and run only the set-based check. Set `SET LOCAL statement_timeout` / `transaction_timeout` (PG17) or a soft deadline.
- Alternatives & trade-offs: The current approach keeps the "preview = exactly what commit does" guarantee. A set-based check must reproduce trigger semantics such as case-insensitive email and existing-duplicate rules; the trigger remains the backstop.
- Expected benefit: A shorter transaction and less lock hold time on previews. Not measured.
- Complexity: M
- Regression risks: Divergence between the preview and the trigger. Keep the trigger as the final authority on commit.
- Required tests: Existing `batch-bulk-candidates.api.int.test.ts`, plus a 500-row preview timing check in CI as a smoke test.
- Breaking API change?: no

#### A-08 · Hot List export builds up to 50,000 rows as one in-memory string with a 60 s statement timeout

- Module / files: `apps/api/src/modules/hotlist/hotlist.service.ts:22-26, 195-233`; `hotlist.controller.ts:65-77`
- Category: Security (OWASP API4) / Performance (HYPOTHESIS)
- Severity: Low
- Existing implementation: `EXPORT_ROW_CAP = 50_000`, `SET LOCAL statement_timeout = '60s'`, all rows are fetched into an array and then `toCsv(...)` builds one string. The limit is 5 exports per 10 minutes per user, in memory per task.
- Problem: Each export can hold a pool connection for up to 60 s and keep two full copies (rows plus CSV string) of up to 50,000 × 17 columns on the heap at once. Several users exporting together, multiplied by the number of tasks because the limiter is per task, could exhaust the pool or memory. Unmeasured.
- Recommended solution: Stream with a cursor (`pg-cursor` / `pg-query-stream`) into the Fastify reply in chunks of about 1,000 rows. Add a global concurrent-export semaphore per task (for example 2). Consider a DB-backed per-user export quota.
- Alternatives & trade-offs: Lowering the cap to around 10,000 is simpler but changes the documented A6.5/B7 cap. Async export jobs through the worker plus storage are the most robust option and the most work.
- Expected benefit: Bounded memory per export and fewer connections held at once.
- Complexity: M
- Regression risks: The headers `x-export-rows` and `x-export-truncated` must be known before streaming. They could move to trailers, or the cap check could be done with `LIMIT cap+1` while streaming.
- Required tests: Existing export tests. A large-seed export memory smoke test.
- Breaking API change?: no (header semantics must be preserved)

#### A-09 · Submissions `summary` aggregates the caller's entire scoped set on every call

- Module / files: `apps/api/src/modules/submissions/submissions.service.ts:325-357`; `pipeline.ts:85-96` (`interviewStageSql` regex)
- Category: Performance (HYPOTHESIS)
- Severity: Low
- Existing implementation: The CTE `s` selects every submission matching the filters, without paging. It evaluates `INTERVIEWED` (an EXISTS subquery) and `PLACED` (an EXISTS subquery) per row, then joins all interviews and classifies each round with several regexes. Org-scope users have `activityPredicate = true`, so with no filters this covers the whole table.
- Problem: The cost grows with the total number of submissions and interviews, and the summary is likely loaded alongside every list view. Unmeasured.
- Recommended solution: Run EXPLAIN on seeded volume. If heavy, store the stage at write time (a generated column `interview.stage` from `interviewStageSql`), add an index on `interview(submission_id) WHERE call_status NOT IN (...)`, and default the summary to a date window (`from` = 90 days) when none is given.
- Alternatives & trade-offs: A materialized summary per team per day makes it cheap but stale.
- Expected benefit: Bounded summary cost.
- Complexity: S–M
- Regression risks: Funnel numbers must stay identical. The generated column needs a migration plus backfill.
- Required tests: Existing summary tests in `pipeline.api.int.test.ts`.
- Breaking API change?: no (yes if a default date window is introduced)

### Placements & HR (placements, payments, contracts, work-authorization, paperwork, documents, employees)

#### B-05 · Paperwork work queue aggregates every visible placement on every page

- Module / files: `apps/api/src/modules/paperwork/paperwork.service.ts:84-128,198-229`.
- Category: Performance (PROVEN by query shape; latency magnitude HYPOTHESIS)
- Severity: Medium
- Existing implementation: `queue()` builds `HEADER(BASE(() => ""), ...)`: `BASE` is `SELECT ... FROM eureka.placement UNION SELECT ... FROM eureka.checklist_item UNION SELECT ... FROM eureka.bgc` with no WHERE (`:122-126`), `agg` groups all `checklist_item` rows for those placements, then filters with `activityPredicate`, the view filter, and orders by `coalesce(a.next_due, '9999-12-31'), x.placement_id` (`:222`) with the cursor on that computed key (`:217-219`).
- Problem: The sort key is an aggregate, so no index can serve it: each page (including page 2..n) materialises the UNION (dedupe sort), aggregates all visible checklist items and sorts the whole set before `LIMIT`. Cost grows linearly with total placements/items for org-scope HR users, and runs under the 5 s `statement_timeout`.
- Recommended solution: Maintain a per-placement summary (`paperwork_progress(placement_id, next_due, open, overdue, ...)`) updated by the existing checklist/bgc write functions or triggers, indexed on `(next_due, placement_id)`; the queue then keyset-scans that table joined to placements under RLS. Alternatively restrict BASE to placements (items and bgc rows always belong to one) to drop the UNION.
- Alternatives & trade-offs: Materialized view refreshed by the worker (stale up to refresh interval). Partial index on `checklist_item (placement_id, due_on) WHERE status IN ('pending','received')` helps `agg` but not the sort.
- Expected benefit: Page cost bounded by page size instead of total data (to be confirmed with EXPLAIN ANALYZE on a seeded 50k-placement DB).
- Complexity: M
- Regression risks: Summary drift if a write path bypasses the update; ordering ties.
- Required tests: queue ordering/cursor equality old vs new on seeded data; EXPLAIN plan assertion (index scan) in a db test.
- Breaking API change?: no

#### B-06 · Unindexed substring name search on concatenated person names

- Module / files: `placements.service.ts:158`; `payments.service.ts:222,293`; `employees.service.ts:263`; no `pg_trgm`/`gin_trgm_ops` in any migration.
- Category: Performance (HYPOTHESIS)
- Severity: Low
- Existing implementation: `(p.first_name || ' ' || p.last_name) ILIKE $n ESCAPE '\'` with `likeContains` (wildcards escaped correctly).
- Problem: Leading-wildcard ILIKE on an expression cannot use a btree; with ORDER BY + LIMIT the planner walks the sort index and filters, scanning everything for rare names (and up to 5000-row exports).
- Recommended solution: `CREATE EXTENSION pg_trgm` (allowed on RDS) and `CREATE INDEX ... ON eureka.person USING gin ((first_name || ' ' || last_name) gin_trgm_ops)`; or a generated `full_name` column. Check with EXPLAIN before/after.
- Alternatives & trade-offs: Prefix search only (`ILIKE 'x%'` + `text_pattern_ops`), changes UX.
- Expected benefit: Search latency independent of table size.
- Complexity: S
- Regression risks: Extension creation must run as non-superuser (rule 7): RDS allows `pg_trgm` for rds_superuser; verify.
- Required tests: existing search tests; migration applies as non-superuser.
- Breaking API change?: no

### Administration & identity (admin, identity, staff, lookups, preferred-vendors, imports, datahub)

#### C-03 · Org-chart apply and bulk user import rebuild the whole reporting closure once per row/move

- Module / files: apps/api/src/modules/admin/admin.service.ts:711-731 (orgChartApply loop), :499-515 (bulk team adds loop), :1066-1080; db/migrations/0013_admin.sql:215-223 (admin_set_manager: UPDATE + INSERT on reporting_line); db/functions/eureka/rebuild_reporting_closure.sql:15-38 (statement trigger: global advisory lock, whole-org cycle check, `DELETE FROM eureka.reporting_closure` + full recursive INSERT); db/migrations/0370_team_reporting_sync.sql:26-37,63 (team_member insert → reporting_line UPDATE/INSERT)
- Category: Performance (PROVEN code path; latency HYPOTHESIS)
- Severity: Medium
- Existing implementation: The bulk import deliberately sets managers with one `authz.admin_bulk_set_managers` call "so the reporting closure is rebuilt once, not per row" (admin.service.ts:464-466; docs/admin-api.md:56 says the closure is rebuilt once). But the same import then calls `admin_add_team_member` per row (up to 500), and each one fires `team_member_reporting` → reporting_line UPDATE + INSERT. Each of those statements fires the statement-level rebuild. `orgChartApply` calls `authz.org_chart_move` → `admin_set_manager` per move (up to 100), so two full rebuilds per move, plus the same for each `teamAdds` entry.
- Problem: A 100-change org-chart batch does about 200 to 400 full closure rebuilds plus whole-org cycle checks in one transaction, and a 500-row import with teams about 1000. Each one holds the global `eureka.reporting_closure` advisory lock, which blocks every other reporting change org-wide for the whole transaction. The cost grows roughly O(changes × org size × depth). Each statement also runs under the 5 s statement_timeout, so large orgs risk timeouts partway through a batch (the batch rolls back cleanly, but cannot complete). The doc's "rebuilt once" claim is untrue whenever rows name teams.
- Recommended solution: Defer the rebuild: have the trigger set a tx-local flag (`set_config('eureka.closure_dirty', ...)`) and rebuild once via a `DEFERRABLE INITIALLY DEFERRED` constraint trigger, or expose `authz.admin_bulk_apply(moves, team_adds)` that writes all reporting_line rows set-based and then rebuilds once. Keep the cycle check per batch (it already runs on the whole graph).
- Alternatives & trade-offs: Incremental closure maintenance (insert/delete subtree paths) is faster per change but much more complex and harder to keep correct.
- Expected benefit: Batch cost drops from O(n × org) to O(org); much shorter lock hold time.
- Complexity: M
- Regression risks: Cycle errors would surface at commit instead of per row, which loses the per-row `cycle` report. Keep a cheap per-row ancestor check (`reporting_closure` lookup) for attribution.
- Required tests: EXPLAIN/timing on a seeded org (1–2k users) for 100-move apply and 500-row import before/after; existing cycle/attribution tests still pass.
- Breaking API change?: no

### Operations (facilities, training, performance, feedback, notifications, chat)

#### D-02 · Chat DB rate limits scan the sender's entire message history

- Module / files: `db/migrations/0070_chat.sql:105-126` (indexes), `:512-516` (send), `:587-590` (edit), `:620-623` (delete); called from `apps/api/src/modules/chat/chat.service.ts:421-455`
- Category: Performance (PROVEN missing index; cost HYPOTHESIS)
- Severity: Medium
- Existing implementation: `SELECT count(*) FROM eureka.chat_message x WHERE x.sender_id = me AND x.created_at > now() - interval '1 minute'` (and the same on `edited_at` and `deleted_at`). The only index that starts with `sender_id` is `UNIQUE (sender_id, client_id)`. The others are `(conversation_id, seq)` and `(conversation_id, rev)`.
- Problem: On every send, edit and delete, the definer reads every message the user has ever sent, through the unique index on `sender_id`, and filters on time. Messages are never hard-deleted ("nobody deletes"), so for active staff the cost of each send grows without bound. This runs inside the conversation-row lock (CH-6), so it also lengthens lock hold time for everyone in that conversation.
- Recommended solution: Add `CREATE INDEX chat_message_sender_recent ON eureka.chat_message (sender_id, created_at DESC)`, plus partial indexes `(sender_id, edited_at) WHERE edited_at IS NOT NULL` and `(sender_id, deleted_at) WHERE deleted_at IS NOT NULL`. Alternatively, count in a small per-user ledger like `chat_add_event`.
- Alternatives & trade-offs: More indexes add write cost on a write-heavy table; the ledger is cheaper to count but is one more table to prune.
- Expected benefit: The rate-limit check is a bounded index range scan (≤120 rows).
- Complexity: S
- Regression risks: Index build on a large table; use `CREATE INDEX CONCURRENTLY` outside a transaction, or accept a short lock.
- Required tests: The existing CH-12 rate-limit tests still pass. EXPLAIN in a db test shows an index scan on the new index.
- Breaking API change?: no

#### D-03 · Every batch read and write evaluates the full `authz.training_batches()` set

- Module / files: `apps/api/src/modules/training/training.service.ts:79-88` (`BATCH_SELECT ... FROM authz.training_batches() v`), `:131-135` (`loadBatch`), used by getBatch, updateBatch, setStatus, deleteBatch, requireManage, students, eligibleStudents, addStudent(s), removeStudent, setModuleCompletion; `db/migrations/0390_batch_staffing.sql:31-52`
- Category: Performance (HYPOTHESIS)
- Severity: Medium
- Existing implementation: `training_batches()` is a SECURITY DEFINER SQL set-returning function. It materialises `training_batch_ids`, `owned_candidate_ids('training:read')` (unnested and joined to candidate) and `batch_staff_location_ids`, then for every visible batch runs `count(*) FROM eureka.candidate WHERE batch_id = v.id`. `loadBatch` then filters with `WHERE b.id = $1`.
- Problem: Postgres does not inline SECURITY DEFINER functions, so the `b.id = $1` predicate cannot be pushed in. A single-batch read, and the pre-check of every write, computes all visible batches with their student counts. For an org-scope trainer that is every batch, plus an unnest of every owned candidate id. The list endpoint pays this on every page as well.
- Recommended solution: Add `authz.training_batch(p_id uuid)` (a single-row variant with the same rules) for `loadBatch`. For the list, page over `eureka.batch` using an InitPlan visible-id array (`b.id = ANY ((SELECT authz.training_batch_ids(...))::uuid[])` plus the staff-location set) and compute student counts only for the page rows.
- Alternatives & trade-offs: A cached per-request visible set adds complexity. A materialised student count column would need trigger upkeep.
- Expected benefit: Single-batch reads are O(1) in the number of batches, and list cost is proportional to page size.
- Complexity: M
- Regression risks: The new function must reproduce the `covered`, owned-count and staff rules of 0390 exactly; this is security-sensitive.
- Required tests: A parity test comparing `training_batch(id)` with the matching row of `training_batches()` for each role fixture; EXPLAIN in a db test.
- Breaking API change?: no

#### D-04 · Bulk add of students: up to 200 sequential definer calls in one transaction

- Module / files: `apps/api/src/modules/training/training.service.ts:385-410`; `apps/api/src/modules/training/training.schemas.ts:60` (`max(200)`); `db/migrations/0390_batch_staffing.sql:54-91`
- Category: Performance (PROVEN N+1 loop)
- Severity: Medium
- Existing implementation: `for (const candidateId of new Set(candidateIds)) { SAVEPOINT; SELECT authz.set_batch_student($1,$2,true); RELEASE / ROLLBACK TO }`. That is three round trips per candidate. Each call re-evaluates `training_batch_ids('training:manage')`, `training_batch_ids('training:read')`, `batch_staff_location_ids()`, `candidate_visible` and `owns`, and takes FOR SHARE on the batch and FOR UPDATE on the candidate.
- Problem: About 600 round trips and about 1,000 scope-function evaluations in one transaction. Candidate row locks are held until the end, which blocks concurrent candidate edits, and the transaction holds a pool connection for its whole duration.
- Recommended solution: Add a set-based definer `authz.set_batch_students(p_batch uuid, p_candidates uuid[]) RETURNS TABLE(candidate_id uuid, outcome text)`. It computes the scope sets once, locks the candidates in id order and updates eligible rows in one statement.
- Alternatives & trade-offs: Keep the loop but lower the cap (for example 50). Simpler, but it limits UX.
- Expected benefit: One round trip, one scope evaluation, and a deterministic lock order (no deadlock between overlapping bulk adds).
- Complexity: M
- Regression risks: The eligibility rules must match `set_batch_student`; the skip/report semantics must be kept.
- Required tests: The bulk add with mixed eligible and ineligible ids returns the same `added` and `skipped` as today; two concurrent overlapping bulk adds do not deadlock.
- Breaking API change?: no

#### D-05 · Org-scope performance reports run with a 60 s statement timeout on the shared pool

- Module / files: `apps/api/src/modules/performance/performance.service.ts:20-21,150-163`; `apps/api/src/platform/config.ts:19` (`DB_POOL_MAX ... default(10)`)
- Category: Performance (HYPOTHESIS) / Security (OWASP API4)
- Severity: Medium
- Existing implementation: `if (all) await c.query("SET LOCAL statement_timeout = '60s'")` for `summary`, `activity` and `activeCandidates`. The only throttle is `RateLimiter(30, 60_000)` per user per task.
- Problem: The default pool has 10 connections. A few org-scope users, or one user with several tabs, asking for 366-day summaries (a UNION ALL of 5 activity scans) can hold most of the pool for up to 60 s each, so ordinary requests queue or time out. The limiter caps how often a user can ask, not how many of these reports run at once.
- Recommended solution: Allow at most N (for example 2) long-timeout reports per API task at once, using an async semaphore, and return 503 with Retry-After beyond that. Consider a separate small pool for reports, or a read replica. Cache `summary` for 1-5 minutes per (user scope, period).
- Alternatives & trade-offs: Precomputed daily rollups give fast reports but are stale within the day and need a new job.
- Expected benefit: Bounded blast radius; a few expensive reports cannot starve interactive traffic.
- Complexity: S (semaphore) / M (rollups)
- Regression risks: Under load, users get 503 instead of slow answers.
- Required tests: A unit test that a third concurrent org-scope report gets 503 while two are running.
- Breaking API change?: no

#### D-08 · Chat conversation list does per-conversation work for all of the caller's conversations on every poll

- Module / files: `apps/api/src/modules/chat/chat.service.ts:178-203`; polling cadence in `docs/chat-api.md:18` (list every 15 s, every 60 s when the tab is hidden)
- Category: Performance (HYPOTHESIS)
- Severity: Low
- Existing implementation: CTE `x` computes, for each of the caller's conversations, an unread count subquery (up to 999 rows each) and a `member_count` subquery joining `user_role`/`role_permission`. It then joins a LATERAL "last message" with an attachment count. Filter, sort (`ORDER BY x.activity`, an expression with no index) and `LIMIT` happen afterwards.
- Problem: Cost grows with the number of conversations a user belongs to, not with page size. The `filter=unread` path has to compute every unread count, and the LATERAL last message runs for every row before the limit. Repeated every 15 s per open tab.
- Recommended solution: Do it in two steps: (1) pick the page ids from `chat_member_state` joined to `chat_conversation`, ordered by a stored `activity_at` column with an index; (2) enrich only those ids with unread, members and last message. For `filter=unread`, keep a denormalised `unread_count`, or bound the scan.
- Alternatives & trade-offs: A per-user unread counter is cheap to read but every send has to update every member.
- Expected benefit: Cost proportional to the page (≤100).
- Complexity: M
- Regression risks: Cursor semantics (`activity`, `id`) must be preserved.
- Required tests: The existing list, filter and cursor tests; EXPLAIN for a user with 500 conversations.
- Breaking API change?: no

#### D-09 · Target list: three correlated count subqueries per row, outside the report timeout handling

- Module / files: `apps/api/src/modules/performance/performance.service.ts:375-408` (`actual()`), `:427-437` (`listTargets` uses `db.withUser` directly, not `report()`)
- Category: Performance (HYPOTHESIS) / Errors
- Severity: Low
- Existing implementation: For up to 501 targets, `CASE WHEN t.submissions IS NOT NULL THEN (SELECT count(*) FROM submission ... WHERE recruiter_id = t.user_id AND <list predicate> AND ts in period)` runs for each of the 3 metrics.
- Problem: Up to about 1,500 correlated scans, each carrying the full list predicate, under the default 5 s timeout. A timeout comes back as a generic 500 (`toProblem` default), not the 503 "narrow the period" that the reports return.
- Recommended solution: Aggregate the actuals in one grouped pass (join targets to a UNION ALL of activity rows on recruiter and period range, `GROUP BY t.id`), and run it through `report()` so the error mapping is the same.
- Alternatives & trade-offs: Precomputed actuals per (user, period) would need upkeep.
- Expected benefit: Predictable cost and a consistent 503.
- Complexity: M
- Regression risks: Status computation (met/below/unknown) must not change.
- Required tests: The existing PF-4 target tests; a test of the 503 mapping on `SET LOCAL statement_timeout='1ms'`.
- Breaking API change?: no

### Interviews, reporting & portal (interviews, interview-reports, calendar, dashboard, pipeline-report, reports, portal)

#### E-02 · Report endpoints can hold every pool connection for 60 s; the pool has no acquire timeout and limiters are per task

- Module / files: `apps/api/src/modules/dashboard/dashboard.service.ts:215`; `pipeline-report/pipeline-report.service.ts:94`; `interview-reports/interview-reports.service.ts:135` (unconditional); `reports/market-report.service.ts:134` (unconditional); `apps/api/src/platform/db.service.ts:18` (`max: DB_POOL_MAX`, default 10 per `config.ts:19`, no `connectionTimeoutMillis`)
- Category: Performance (HYPOTHESIS on real durations; the configuration is PROVEN)
- Severity: High
- Existing implementation: Each report raises `statement_timeout` to 60 s inside `withUser`. The dashboard and pipeline report do this for org scope only. Interview reports and the market report do it for every caller, and interview `report()` opens two such transactions. The limits are in-memory per task and per user: dashboard 20/min, pipeline 20/min, interview reports 30/min, market 30/min. Nothing is cached. The same 10-connection pool serves the auth guard (session resolve and access load), the portal and all writes.
- Problem: About 10 concurrent slow report queries (one HR/CEO user with a few tabs, or an auto-refreshing dashboard) occupy the whole pool for up to 60 s. `pool.connect()` then waits without limit, so every API request, sign-in included, stalls. The 5 s default that protects the pool is defeated by design.
- Recommended solution: (1) Give reports a dedicated small pool or semaphore, for example at most 2 concurrent report queries per task, and return 503 with Retry-After when it is busy. (2) Set `connectionTimeoutMillis` on the main pool so callers fail fast. (3) Apply the 60 s timeout only to org-scope callers, consistently (the dashboard and pipeline already do this). (4) Add a short TTL cache (30–120 s), keyed by user id plus normalized query, for the point-in-time market report and dashboard `needsAttention`.
- Alternatives & trade-offs: A read replica for reports adds infrastructure cost and lag. Materialized daily rollups give the biggest win but bring refresh complexity and stale-by-design counts.
- Expected benefit: Report load cannot take the whole API down. Steady-state DB CPU is lower.
- Complexity: M
- Regression risks: The cache must be per user, because scope differs. A 503 under contention needs UI handling.
- Required tests: A unit test that the semaphore rejects beyond N. An integration test that the 60 s timeout is set only for org scope in interview and market reports.
- Breaking API change?: no (adds 503 responses)
- **Lead review:** Merged with D-05 and F-02 into theme **R-03 Connection-pool starvation** (refactoring-roadmap.md).

#### E-03 · Pipeline report evaluates the full-history CTE twice per request, then sorts a computed name with deep OFFSET

- Module / files: `apps/api/src/modules/pipeline-report/pipeline-report.service.ts:96-109` (page query with `count(*) OVER ()` and `OFFSET`), `:110-123` (a second `baseSql` for the summary), `:197-253` (CTE); `pipeline-report.schemas.ts:57-58` (offset ≤10 000)
- Category: Performance (PROVEN: two evaluations per request; magnitude HYPOTHESIS)
- Severity: Medium
- Existing implementation: `baseSql` materializes every candidate in scope. It then aggregates all of their submissions, interviews, assessments, placements, checklist items and flags, whatever the period: `n_all` is needed for `stage`, and the period only filters the counts. The page query adds `count(*) OVER ()` and `ORDER BY lower(pe.first_name || ' ' || pe.last_name)` with OFFSET. The summary query rebuilds and re-runs the same CTE.
- Problem: For org-scope callers every request scans the full candidate table and its entire activity history twice. The window count forces full materialization, and the sort cannot use an index. Paging is O(offset). It is limited to 20/min per user per task, with a 60 s timeout.
- Recommended solution: Compute the page and the summary in one statement: `WITH … rows`, then `SELECT … FROM rows` for the page and a `summary` CTE joined once, or run both under one `REPEATABLE READ` snapshot reading a `MATERIALIZED` `rows`. Switch to keyset on `(lower(name), id)`. Consider a persisted "furthest stage" column on candidate, maintained by triggers or the outbox, so `stage` filters do not need full-history aggregation.
- Alternatives & trade-offs: Cache the summary per user and filter set for 60 s (cheap, slightly stale). A persisted stage removes the aggregation but needs backfill and trigger upkeep.
- Expected benefit: About half the DB work per request, and bounded paging cost.
- Complexity: M
- Regression risks: Totals must stay identical between page and summary. Keyset changes the cursor contract.
- Required tests: Existing pipeline tests for funnel and totals, plus a test that page and summary agree under concurrent inserts.
- Breaking API change?: no for the single-statement change; yes if offset is replaced with a cursor

#### E-06 · Dashboard "needs attention" is recomputed on every view, counts unbounded history and ignores the period

- Module / files: `apps/api/src/modules/dashboard/dashboard.service.ts:260-263,368-444` (esp. `count(*) OVER ()` at :398, submission stale with no lower bound :404-413, placement stalled with no lower bound :429-441)
- Category: Performance (PROVEN query shape; magnitude HYPOTHESIS)
- Severity: Medium
- Existing implementation: Every `GET /dashboard` (rate limit 20/min per user per task) runs three attention queries after the counts. Each uses `count(*) OVER ()` to return an exact total with `LIMIT 25`. Submission-stale has only an upper bound (`< now() - 7 days`), so every open submission that has ever stalled is counted. Placement-stalled is the same. Only interview-feedback has a 30-day lookback.
- Problem: `count(*) OVER()` disables the LIMIT short-circuit: Postgres must produce and sort every matching row before it returns 25. The matching set grows with abandoned open submissions, which typically accumulate. The result does not depend on the selected period, but every period change and every refresh recomputes it.
- Recommended solution: Separate the total from the page: run `SELECT count(*)` and the `LIMIT 25` query, or cap the count (`count(*) FROM (… LIMIT 1001)`, shown as "1000+"). Add a lookback (for example 180 days) or archive stale open submissions. Cache `needsAttention` per user for about 60 s, or serve it from a separate endpoint so period changes do not recompute it.
- Alternatives & trade-offs: A capped count loses exactness above the cap. The doc states "the total is always exact" (`dashboard.config.ts:19`), so this needs a product decision.
- Expected benefit: Bounded per-view cost as history grows.
- Complexity: S
- Regression risks: Dashboard tests that assert totals.
- Required tests: Total and items still consistent. The lookback excludes very old rows.
- Breaking API change?: no (yes if `total` becomes capped)

#### E-09 · Interview board search runs a SECURITY DEFINER function per row inside WHERE, with an unindexable ILIKE

- Module / files: `apps/api/src/modules/interviews/interviews.service.ts:82-83` (`CANDIDATE_NAME` = `CASE … ELSE authz.interview_candidate_name(i.id) END`), `:224` (`candidate` filter), `:230-233` (`search`); `db/migrations/0141_interview_coordinator_candidates.sql:16-24`; the same expression in `calendar.service.ts:150` (single row, fine)
- Category: Performance (HYPOTHESIS on magnitude; per-row evaluation is PROVEN by placement in WHERE)
- Severity: Medium
- Existing implementation: For callers whose candidate join is hidden by RLS (org interview readers, e.g. coordinators), the filter `(<CASE … authz.interview_candidate_name(i.id)>) ILIKE $n` calls the definer function for every interview row that survives the other predicates. Each call is a 3-table join plus `authz.has_org(...)`. The concatenated name cannot use an index, so keyset LIMIT does not stop the scan until enough matches are found.
- Problem: For a coordinator searching a rare name, this means a full scan of the interview table with N definer calls. Rule 3 states the same anti-pattern for policies, and it applies equally here. The 5 s timeout leads to 500s or 503s.
- Recommended solution: Resolve "can read names org-wide" once per query (`(SELECT authz.has_org('interview:read'))` InitPlan), then join `person` through a definer set-returning function or view filtered once, or denormalize `candidate_name` onto the interview (snapshot, like recruiter/team). Add a `pg_trgm` GIN index on the searchable name.
- Alternatives & trade-offs: The snapshot column needs updating on candidate rename. A trigram index adds write cost.
- Expected benefit: Board search scales with matches, not table size.
- Complexity: M
- Regression risks: Name visibility rules for non-org readers must not widen.
- Required tests: A coordinator search returns names. A Sales team reader cannot match names of hidden candidates. EXPLAIN shows no per-row function scan.
- Breaking API change?: no
- **Measured (R-13b, wave 3; [perf-baseline.md](perf-baseline.md) "R-13b / E-09"):** the filter now uses
  `authz.interview_name_candidate_ids` once per statement (InitPlan) instead of a definer call per row.
  Coordinator searches that hit the 5 s timeout (rare or missing names) now take 1.7–115 ms; common
  names 137–785 → 58–119 ms; rows identical. `search` for org/team readers is unchanged (OR with the
  coach name).

#### E-11 · Interview report totals come from a separate transaction and scan; daily totals come from capped rows

- Module / files: `apps/api/src/modules/interview-reports/interview-reports.service.ts:178-199` (two `this.run` calls, each its own `withUser`), `:272-289` (daily totals from `items` after `slice(0, 1000)`)
- Category: DB / Performance (PROVEN double scan)
- Severity: Low
- Existing implementation: `report()` runs `groupSql` and then `totalsSql` in two transactions, each with the 60 s timeout. `daily()` computes `totals.interviews/cleared/withCandidateFeedback` from the first 1 000 items only.
- Problem: Two scans of the same range per view. Totals and groups can disagree under concurrent writes. A truncated daily report (more than 1 000 interviews in 26 h, which is unlikely) reports wrong totals while claiming `truncated: true`.
- Recommended solution: Use one statement: `GROUP BY GROUPING SETS ((key), ())`, as the dashboard does (`dashboard.service.ts:321-323`). Compute daily totals in SQL (`count(*) FILTER …`) alongside the capped rows.
- Alternatives & trade-offs: None significant.
- Expected benefit: Half the report cost and consistent numbers.
- Complexity: S
- Regression risks: Ordering and limit of groups with a grouping-set total row.
- Required tests: The totals row equals the sum of the groups when not truncated.
- Breaking API change?: no

### Platform & cross-cutting (auth, data access, worker/outbox, shared authz, test infra)

#### F-02 · Pool starvation: 60 s report queries vs 29 s gateway timeout, pool of 5, no connect timeout, DB-coupled health check

- Module / files: apps/api/src/platform/db.service.ts:18; infra/modules/stack/app.tf:565 (`DB_POOL_MAX=5`), app.tf:507 (`timeout_milliseconds = 29000`), app.tf:635-641 (health check); apps/api/src/app.module.ts:84-93 (HealthController); `SET LOCAL statement_timeout = '60s'` in hotlist.service.ts:201, reports.service.ts:167/197/298, interview-reports.service.ts:135, performance.service.ts:153, pipeline-report.service.ts:94 (9 occurrences)
- Category: Performance (PROVEN configuration mismatch; production impact HYPOTHESIS)
- Severity: Medium
- Existing implementation: the API Gateway integration gives up after 29 s, but export and report transactions may run up to 60 s. Nothing cancels the query when the client disconnects. The pool has `max: 5` and no `connectionTimeoutMillis` (pg default 0 = wait forever). The container health check calls `/api/health`, which needs a pool connection (`db.system(c => c.query("SELECT 1"))`), with a 5 s timeout and 3 retries.
- Problem: once ~5 slow report/export requests are running, each holds a connection for up to 60 s after the client has already received a 504. Every other request, including the guard's session lookup, waits in `pool.connect()` with no bound until API Gateway returns 503/504. The health check also queues, times out 3× and ECS replaces the task, dropping all in-flight work. A user retrying a slow report makes this worse. On a 0.25 vCPU task with a t4g.micro DB this is a plausible self-inflicted outage.
- Recommended solution: (1) set `connectionTimeoutMillis` (e.g. 3000) and map the pg "timeout exceeded when trying to connect" error to 503 + `Retry-After`. (2) Cap any `SET LOCAL statement_timeout` at about 25 s, below the gateway limit. Move longer exports to the worker (async job and download link), which already has an S3 sink. (3) Split health into `/api/health/live` (no DB, used by the ECS check) and `/api/health/ready` (DB ping with a short timeout). (4) Optionally a separate small pool for reports so they cannot starve interactive traffic.
- Alternatives & trade-offs: raise `DB_POOL_MAX`. That is limited by the t4g.micro connection ceiling (`config.ts:16-19`) and only delays starvation.
- Expected benefit: slow reports degrade only themselves; no restart loops.
- Complexity: M
- Regression risks: long org-wide reports that currently succeed in 30–60 s at the DB would start failing until they move to async.
- Required tests: int test with `TEST` pool max 2 holding two `pg_sleep` txs, asserting a third request gets 503 within the connect timeout and health/live stays 200.
- Breaking API change?: no (yes only if exports become async)

#### F-03 · Per-request authentication cost: 2 pool checkouts and ~5–6 round trips before the handler runs

- Module / files: apps/api/src/platform/auth.guard.ts:95-111; session.service.ts:50-70; access.service.ts:8-47; db.service.ts:24-39; modules/identity/me.controller.ts:18-22; modules/identity/step-up.controller.ts:66-71
- Category: Performance (HYPOTHESIS: the round-trip count is proven from code, the latency impact needs measurement)
- Severity: Medium
- Existing implementation: each authenticated request makes:
  1. a `db.system()` checkout to run the session CTE (SELECT plus a conditional UPDATE);
  2. a `db.withUser()` checkout to run BEGIN, `set_config`, the access load (one statement with 7 sub-selects plus the definer `authz.shared_candidate_ids('candidate:read')`), `authz.password_must_change()` when PASSWORD_LOGIN=on, and COMMIT;
  3. the handler's own `withUser` (BEGIN, set_config, …, COMMIT).
  `GET /api/v1/me` adds 1–2 more transactions (`me.controller.ts:18-22`), and so does `GET /api/auth/step-up` (`step-up.controller.ts:66-71`). Inside the handler tx, RLS recomputes the same scope facts through `authz.*` helpers. The comment at `auth.guard.ts:105-106` says the lack of caching is deliberate (revocation takes effect at once).
- Problem: about 8–10 sequential DB round trips and 3 pool acquisitions per simple GET. That matters on 0.25 vCPU tasks with a 5-connection pool (amplifies F-02). `shared_candidate_ids` is materialized as a text[] and shipped on every request, even for routes that never look at candidates. Its cost grows with share volume (HYPOTHESIS).
- Recommended solution: keep "no cache" (it is a sound security choice), but collapse the work. Write one STABLE definer function `authz.request_context(id_hash, idle_minutes, check_password)` that validates and touches the session and returns user id, auth_time, access JSON and must_change in a single round trip on one connection. Make `sharedCandidateIds` lazy (load only for permissions that use it), or let RLS own it since the policy already computes it. Fold the extra txs in `/me` and step-up status into one `withUser`.
- Alternatives & trade-offs: (a) a request-scoped transaction (interceptor plus AsyncLocalStorage) reused by the handler saves one checkout, but holds a connection for the whole request including non-DB work. (b) An LRU cache keyed by `(user_id, app_user.access_version)` with a 5–10 s TTL. Unsafe on its own: team, reporting and coach changes do not bump `access_version`, so it would need triggers to bump it everywhere. Not recommended without that.
- Expected benefit: fewer round trips and checkouts per request (no measured claim).
- Complexity: M
- Regression risks: idle timeout and status semantics must stay identical; password-change gating must still run on the same snapshot.
- Required tests: existing session/idle/revoke tests in `api.int.test.ts` and `password-login.int.test.ts`; add a test asserting a revoked role takes effect on the very next request.
- Breaking API change?: no

#### F-10 · Worker runs every job serially; outbox waits behind long jobs; no dead-letter state

- Module / files: apps/api/src/worker/runner.ts:218-238 (nested `for … await this.runOnce`), 48-54 (backoff cap 6 h, `maxAttempts` only alerts); apps/api/src/worker.ts:66-96 (outbox job pushed last); apps/api/src/worker/jobs/outbox.ts:316-331 (`dueOutboxEvents` LIMIT batch), 115-127 (no-recipient retry); worker/config.ts:14,40 (tick 60 s, batch 50)
- Category: Performance (HYPOTHESIS)
- Severity: Low
- Existing implementation: one tick runs audit export (up to 7 days per tick), key rotation, scans, daily jobs and then outbox delivery, one key at a time. Each event costs a claim (1–3 statements), a prepare tx, the sends, and a finish. A malformed or recipient-less event is retried with backoff for ever (capped at 6 h) and alerts after 8 attempts. It stays unpublished, so it is never pruned.
- Problem: notification latency is bounded by the slowest other job in the tick (key rotation or a large audit export can take minutes). Throughput is at most 50 events per tick. A poison event never reaches a terminal state, so ops relies on log alerts. Correctness is fine: leases plus fencing give at-least-once claims, and email is at most once per recipient.
- Recommended solution: run outbox delivery in its own loop (its own `JobRunner` instance or a concurrency lane) with a shorter tick. Add a terminal `dead` status on `job_run` after N attempts, listed in an admin or ops view. Emit a backlog-age metric.
- Alternatives & trade-offs: LISTEN/NOTIFY wake-ups for lower latency. More moving parts.
- Expected benefit: predictable notification latency; finite retries.
- Complexity: S–M
- Regression risks: two loops share the 3-connection pool; size it accordingly.
- Required tests: worker int test where a long-running job does not delay outbox delivery; a dead-letter transition after N failures.
- Breaking API change?: no

### Database (schema & RLS, definer functions, indexes, migrations tooling)

#### G-04 · Name search is a leading-wildcard ILIKE over a concatenated expression, and no trigram index exists anywhere

- Module / files:
  - apps/api/src/modules/candidates/candidates.service.ts:431-434
  - db/functions/authz/hotlist_page.sql:53 and hotlist_export.sql:51
  - submissions.service.ts:305, placements.service.ts:158, interviews.service.ts:224 and 232, employees.service.ts:263, payments.service.ts:222 and 293, applications.service.ts:152 and 377, admin.service.ts:171
  - sort key candidates.service.ts:140
  - `grep pg_trgm|gin_trgm|to_tsvector db/migrations` returns nothing
- Category: Performance. Missing index: PROVEN. Latency impact: HYPOTHESIS.
- Severity: Medium
- Existing implementation: `where.push(\`(p.first_name || ' ' || p.last_name) ILIKE $n\`)` with `likeContains()` producing `%term%`. The candidate sort `lower(p.first_name || ' ' || p.last_name)` has no matching expression index. The only text-search indexes are `person_email_lower`/`person_phone` (0026:46-48), used for duplicate checks, and `datahub_folder_name_search` (text_pattern_ops, prefix only).
- Problem:
  - A `%term%` pattern on an expression cannot use any B-tree index. Every search therefore scans all RLS-visible rows of person joined to candidate (or submission, placement, interview, application), and the RLS filter runs for each row.
  - For the Hot List and candidate search, the most used screens, latency grows linearly with candidate count.
  - Sorting by name forces a full sort of the visible set before LIMIT, because there is no index on the expression.
- Recommended solution:
  - `CREATE EXTENSION pg_trgm` (allowed for rds_superuser).
  - `CREATE INDEX person_name_trgm ON eureka.person USING gin ((lower(first_name || ' ' || last_name)) gin_trgm_ops);` and the same on `eureka.applicant`.
  - Change the predicates to `lower(p.first_name || ' ' || p.last_name) LIKE lower($n)`, so the planner sees the same expression (ILIKE on the raw expression also works with gin_trgm_ops if the index is built on the un-lowered expression).
  - Add a B-tree expression index for the name sort key if EXPLAIN shows a sort spill.
- Alternatives & trade-offs: A generated `search_name` column plus a trigram index, which is simpler for every module to reuse. Full-text search (`to_tsvector`) helps word matches but not substrings of names.
- Expected benefit: Search cost becomes proportional to matches instead of table size. The actual gain must be measured with EXPLAIN ANALYZE on production-sized data.
- Complexity: M (one migration, about 10 predicate edits in 8 files, plus two definer function files)
- Regression risks: GIN maintenance cost on person and candidate writes (low write rate). The trigram index is unused for search terms under 3 characters, which then scan as today.
- Required tests: Existing search integration tests must pass unchanged. Add an EXPLAIN-based test asserting `Bitmap Index Scan on person_name_trgm` for a 3+ character term.
- Breaking API change?: no
- **Measured (R-13, migration 0479; [perf-baseline.md](perf-baseline.md), 50k candidates):** with the
  index, `authz.hotlist_page` and `hotlist_export` (run as authz_definer) use `person_name_trgm` for
  terms of 3+ characters: 0.30–0.81× of the time before (for example 21.7 → 8.0 ms). The eureka_app
  lists (candidates, the default Hot List, submissions, placements, employees, applicants) **cannot**
  use it, because ILIKE is not leakproof and so cannot run ahead of the RLS security quals. They are
  unchanged at 40–540 ms, and most of that time is the per-row `person_read` EXISTS. Index-backing
  them needs a scoped definer search (security review). See the follow-up in perf-baseline.md.
- **Measured (R-13b, wave 3; [perf-baseline.md](perf-baseline.md) "R-13b / E-09"):** the lists now add
  `= ANY ((SELECT authz.person_name_matches($n))::uuid[])` (a scoped definer set, index-backed, rows
  identical) for 3+ character terms: rare or missing names 0.00–0.09× at org scope (candidates
  `zzqx` 198.5 → 0.9 ms, submissions 336.2 → 1.1 ms), 0.06–0.61× at team scope; common 3-character
  terms got slower (`ana`, 2,500 matches: 8.0 → 51.1 ms). The person_read policy is unchanged (both
  InitPlan rewrites measured slower).

#### G-07 · Every org change rewrites every app_user row to bump access_version, which nothing reads

- Module / files: db/functions/eureka/bump_access_version.sql:18-24; db/functions/eureka/rebuild_reporting_closure.sql:41-43; db/migrations/0002_org_identity.sql:145-155 (statement triggers on user_role, team_member, coach_assignment, team); apps/api/src/platform/session.service.ts:36-37, 50-66
- Category: Performance. Dead work: PROVEN. Lock impact: HYPOTHESIS.
- Severity: Low
- Existing implementation:
  - `UPDATE eureka.app_user SET access_version = access_version + 1;` runs with no WHERE clause, once per transaction that touches the org tables.
  - The session row copies `u.access_version` at sign-in (session.service.ts:37), but `resolve()` (50-66) never compares it. I found no other reader in apps/api/src, db/functions or the migrations.
- Problem:
  - Each admin team, role or coach change rewrites N app_user rows (WAL, dead tuples) and holds row locks on every user until commit.
  - Any concurrent transaction updating an app_user row has to wait. Examples: `UPDATE … SET google_sub` at first login (0007:4), `admin_set_user_status`, designation changes.
  - The invalidation it was designed for (B4.3) does not actually happen, so it gives no security benefit.
- Recommended solution: Either implement the check (`resolve()` joins `s.access_version = u.access_version` and re-issues or refreshes the cached access), or drop the global bump. If invalidation is wanted, bump only the affected users (`WHERE id = ANY(affected)`), or keep a single `authz.access_epoch` row.
- Alternatives & trade-offs: A single epoch counter row: one row update per change, compared once per request.
- Expected benefit: Removes table-wide writes and locks on app_user, or makes the intended session invalidation real.
- Complexity: S
- Regression risks: If cached grants exist in the API, verify how stale they can be today before deciding.
- Required tests: Either (a) after an org change, an existing session sees the new scope on its next request, or (b) a test that the app_user row count updated by a team change is ≤ the number of affected users.
- Breaking API change?: no

#### G-08 · No retention for staff sessions, step-up rows, verified applicants' sessions or audit_event

- Module / files: db/migrations/0002_org_identity.sql:91-100 (session), 0043 (step_up_challenge / step_up_grant), 0061:285 (applicant_session pruned only per applicant at login); apps/api/src/worker/jobs/* (outbox.ts:397, notifications.ts:55 and portal-prune.ts cover outbox, notification, idempotency_key and unverified applicants only)
- Category: DB / Performance (HYPOTHESIS)
- Severity: Low
- Existing implementation: There is no `DELETE FROM eureka.session`, step_up_* or audit_event anywhere outside seeds (grep). audit_event is exported daily to S3 (audit-export.ts:12) but kept forever in Postgres, and is not partitioned.
- Problem:
  - Expired and revoked session rows (one per sign-in, with `ip_masked`, browser and device) and step-up rows grow without bound. This is personal metadata kept past need.
  - audit_event, the largest append-only table, has no partitioning or archival boundary. Export and backup cost grow over time.
- Recommended solution:
  - Add worker jobs that batch-delete sessions where `expires_at < now() - interval '30 days'` and step-up rows past expiry. Run them as a definer function, because the worker has no session grants.
  - For audit_event, partition by month (`at`) and detach or drop partitions older than N months once the S3 export for those days is confirmed (audit_export records exist, 0016).
- Alternatives & trade-offs: Keep audit_event unpartitioned but delete rows already exported after a legal-hold period. This is simpler but leaves bloat behind.
- Expected benefit: Bounded table sizes, lower PII retention, cheaper vacuum and backups.
- Complexity: M (partitioning) / S (session purge)
- Regression risks: The settings "login activity" view reads 30 days of sessions (settings.service.ts:125), so keep at least LOGIN_ACTIVITY_DAYS.
- Required tests: A worker job test deleting only expired or revoked rows older than the cut-off.
- Breaking API change?: no
