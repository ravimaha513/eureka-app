# Eureka backend — security review (OWASP API Security Top 10, 2023)

> Part of the 2026-11-05 backend audit. Checklists applied: **eureka-security-gate** (access control,
> data integrity, data exposure, ops), **eureka-sql-review** rules 1–8, **eureka-rls-policy** review
> checklist. Every High finding was re-verified against the code by the lead reviewer.

## 1. Verdict

**No Critical findings. Three High findings need action before the next production launch:**

| # | Finding | Why it matters |
|---|---|---|
| C-01 | One admin can create new `access:manage` holders without the second approver | It reopens the single-admin takeover that AD-3 and the 2026-09-29 review closed. Those holders can then act as the "second approver". |
| B-01 | Restricted documents (I-9, driving licence, work authorisation) open without step-up, while docs, comments and link TTLs still assume step-up | The trade-off was accepted (Google gives no `auth_time`) but never re-reviewed or written down. Restricted links also live 300 s. |
| E-01 | About 8 IP addresses can use up the portal's global hourly caps, and all applicants then silently get no sign-in link | A cheap denial of service on the only external-facing flow, and nobody is alerted. |

The baseline is strong. Group G found all 353 read policies in InitPlan form, every definer function with a pinned `search_path` and NULL-safe `IF`s, no SQL injection surface and no PII in audit or outbox payloads. Identity is also well built: PKCE, nonce, state, issuer, audience, hosted-domain and `auth_time` checks; 256-bit hashed sessions; timing-safe HMAC CSRF; bcrypt cost 12 with a dummy hash for unknown emails; 256-bit single-use hashed reset tokens. So most findings below are **gaps in the second layer of defence**: they would only matter if another check failed or a future change regressed it.

## 2. OWASP API Top 10 mapping

| OWASP 2023 | Status | Findings |
|---|---|---|
| **API1 Broken Object Level Authorization** | **Strong.** RLS on every table (ENABLE + FORCE), read-before-write 404→403, definer re-check. No BOLA found on any `:id` route. | F-13 (session table outside RLS, defence in depth) |
| **API2 Broken Authentication** | Strong core; one policy regression | **B-01** (step-up dropped for restricted docs), C-07 (staging-only lockout enumeration), F-14 (no `__Host-` cookie prefix) |
| **API3 Broken Object Property Level Authorization** (exposure + mass assignment) | API layer strong (strict zod, mass-assignment harness); **DB layer has legacy table-wide grants** | **A-04** (CSV leaks applicant email), A-10 (birth year outside field policy), **G-01** (`person` table-wide INSERT/UPDATE), **G-03** (candidate UPDATE relies on denylist guards) |
| **API4 Unrestricted Resource Consumption** | Partial. Body cap of 1 MiB, list caps of 200, export caps; but limiters are in-memory per task and reports can starve the pool | D-01, F-06, B-09, C-08, E-07, A-08; pool starvation **R-03** (E-02/D-05/F-02, in performance-review.md) |
| **API5 Broken Function Level Authorization** | Strong in practice, convention-based in code | **C-01**, **G-02** (worker can act as any user via `transition_candidate`), B-04 (contracts POST gated only by `placement:read` at the API), F-08/D-12/B-12 (default-allow guard, no route inventory test) |
| **API6 Unrestricted Access to Sensitive Business Flows** | Mostly protected | **E-01** (portal cap lockout), **A-01** (bulk dry-run as a contact-existence oracle at 250× the dedicated endpoint's limit), C-01 |
| **API7 SSRF** | Not found. Outbound calls go only to fixed hosts (Google, AWS SDK); no user-supplied URL is fetched | — |
| **API8 Security Misconfiguration** | Good. Config validated with zod at startup and refuses unsafe production combinations; `trustProxy: false`; origin-verify secret with rotation | G-06 (DB role passwords as plaintext literals in `ALTER ROLE`, which can end up in logs and history), F-14, F-01 (crash on pool error, in architecture.md) |
| **API9 Improper Inventory Management** | Hand-written docs per module; no OpenAPI; one undocumented public route | D-11, R-19 OpenAPI (api-review.md) |
| **API10 Unsafe Consumption of APIs** | Google token exchange has no timeout; calendar calls run inside DB transactions | F-05 (api-review.md), E-05 (architecture.md) |

## 3. Focus areas

**Tenant (scope) isolation.** Eureka is single-organisation; isolation is per **data scope** (own, team, coached, hierarchy, location, org) for each permission, enforced in three layers. Reviewers found no cross-scope read path. The structural risks are (a) **custom roles**, where an admin can compose permissions the built-in catalog never pairs (C-01: `access:manage` combined with data permissions), and (b) **legacy table-wide grants** that leave the DB layer depending on guard triggers rather than on privileges (G-01, G-03).

**Mass assignment.** The API layer is solid: 210 `.strict()` schemas plus the mass-assignment harness over every POST/PUT/PATCH. The DB layer is the gap. `eureka_app` holds table-wide `INSERT, UPDATE` on `person` and `candidate` (0003_domain.sql:118), so rule 4 is enforced by **denylist** triggers. A future column added to `candidate` is client-writable at the DB level by default. Recommendation: column-level grants, an allowlist (R-07).

**Sensitive candidate information.** Phones are masked by `*.phone:read`, DOB and visa data are restricted and KMS-encrypted, rates are org-sensitive, and audit and outbox events carry ids only (group G confirmed). The leaks found are narrow: the applicant email in the CSV export (A-04), the birth year (A-10), and free text in some audit rows that rule 5 forbids (C-05 names and display names, E-08 interview `round`/`systemName`).

**Injection.** None found. All SQL is parameterised, sort keys come from allow-lists, and LIKE wildcards are escaped by `likeContains`. CSV exports go through `csvCell` (`modules/hotlist/csv.ts:6-11`), which neutralises formula injection by prefixing an apostrophe to cells that start with `= + - @ \t \r`.

**Secrets management.** Secrets come from SSM through the ECS execution role; config is validated at boot; utility secrets and work-authorisation reveals require step-up. The one gap is G-06 (role passwords written as literals in migrations or scripts).

**Abuse and resource exhaustion.** All in-memory limiters reset on deploy and multiply by task count (F-06). The public feedback route keys on the raw IP, so rotating IPv6 addresses gets around it (D-01). The portal relies on global caps that an attacker can exhaust (E-01). Bounded but heavy flows: Hot List export (50k rows in memory, A-08), xlsx expansion (C-08), and the unbounded portal deferred queue (E-07).

## 4. Security findings

| ID | Severity | Title |
|---|---|---|
| [B-01](#b-01--restricted-documents-i-9-driving-license-work-authorization-open-without-step-up-code-docs-and-ttls-still-assume-it) | High | Restricted documents (I-9, driving license, work authorization) open without step-up; code, docs and TTLs still assume it |
| [C-01](#c-01--one-admin-can-mint-new-accessmanage-holders-and-give-admin-trait-roles-data-permissions-without-the-second-approver) | High | One admin can mint new `access:manage` holders (and give admin-trait roles data permissions) without the second approver |
| [E-01](#e-01--portal-global-hourly-caps-let-a-few-addresses-lock-every-applicant-out-of-sign-in-silently) | High | Portal global hourly caps let a few addresses lock every applicant out of sign-in, silently |
| [A-01](#a-01--bulk-import-dry-run-reveals-whether-a-contact-exists-250-past-the-duplicate-check-limit) | Medium | Bulk-import dry run reveals whether a contact exists, 250× past the duplicate-check limit |
| [A-04](#a-04--application-csv-export-writes-unmasked-applicant-emails-to-callers-without-applicantread) | Medium | Application CSV export writes unmasked applicant emails to callers without `applicant:read` |
| [B-04](#b-04--contracts-api-does-no-permission-pre-check-and-its-canadd-hint-diverges-from-authzcreate_contract) | Medium | Contracts: API does no permission pre-check and its `canAdd` hint diverges from `authz.create_contract` |
| [D-01](#d-01--public-feedback-ip-rate-limit-is-keyed-on-the-raw-address-ipv6-rotation-bypass) | Medium | Public feedback IP rate limit is keyed on the raw address (IPv6 rotation bypass) |
| [E-07](#e-07--portal-deferred-work-unbounded-in-process-queue-on-the-shared-pool-never-drained-on-shutdown) | Medium | Portal deferred work: unbounded in-process queue on the shared pool, never drained on shutdown |
| [F-08](#f-08--authguard-is-default-allow-for-any-signed-in-user-no-route-authz-inventory-test) | Medium | AuthGuard is default-allow for any signed-in user; no route-authz inventory test |
| [G-01](#g-01--eurekaperson-table-wide-insertupdate-for-eureka_app-with-no-column-guard) | Medium | eureka.person: table-wide INSERT/UPDATE for eureka_app with no column guard |
| [G-02](#g-02--eureka_worker-can-call-authztransition_candidate-and-can-choose-its-own-identity-so-the-worker-can-act-as-any-user) | Medium | eureka_worker can call authz.transition_candidate and can choose its own identity, so the worker can act as any user |
| [G-03](#g-03--candidate-writes-rely-on-table-wide-update-plus-denylist-column-guards) | Medium | Candidate writes rely on table-wide UPDATE plus denylist column guards |
| [A-10](#a-10--candidate-birth-year-is-returned-to-every-candidate-reader-outside-the-field-policy) | Low | Candidate birth year is returned to every candidate reader, outside the field policy |
| [B-09](#b-09--in-memory-per-process-rate-limits-on-document-downloadsuploads-and-exports) | Low | In-memory per-process rate limits on document downloads/uploads and exports |
| [B-12](#b-12--get-document-access-has-no-requirepermission) | Low | `GET /document-access` has no `@RequirePermission` |
| [C-05](#c-05--audit-rows-for-created-users-teams-and-locations-carry-free-text-that-the-rename-paths-deliberately-omit-rule-5) | Low | Audit rows for created users, teams and locations carry free text that the rename paths deliberately omit (rule 5) |
| [C-07](#c-07--password-lockout-reveals-which-emails-have-accounts-and-lets-anyone-lock-a-user-out-staginglocal-only) | Low | Password lockout reveals which emails have accounts and lets anyone lock a user out (staging/local only) |
| [C-08](#c-08--xlsx-import-bounds-the-compressed-size-only-the-workbook-is-fully-expanded-before-rowcolumn-checks) | Low | xlsx import bounds the compressed size only; the workbook is fully expanded before row/column checks |
| [D-12](#d-12--route-authorisation-intent-is-not-machine-checkable-no-exemption-marker-no-route-meta-test) | Low | Route authorisation intent is not machine-checkable (no exemption marker, no route meta-test) |
| [E-08](#e-08--interview-audit-rows-store-free-text-round-systemname-violating-rule-5) | Low | Interview audit rows store free text (`round`, `systemName`), violating rule 5 |
| [F-06](#f-06--application-rate-limits-are-in-memory-per-task-and-reset-on-deploy) | Low | Application rate limits are in memory per task and reset on deploy |
| [F-13](#f-13--staff-session-table-sits-outside-rls-with-direct-table-grants-to-the-api-role) | Low | Staff session table sits outside RLS with direct table grants to the API role |
| [F-14](#f-14--staff-session-cookie-hardening-is-weaker-than-the-portal-cookie) | Low | Staff session cookie hardening is weaker than the portal cookie |
| [G-06](#g-06--role-passwords-are-sent-as-plaintext-literals-in-alter-role) | Low | Role passwords are sent as plaintext literals in ALTER ROLE |

### Talent core (candidates, applications, submissions, hotlist, resumes, jobs)

#### A-01 · Bulk-import dry run reveals whether a contact exists, 250× past the duplicate-check limit

- Module / files: `apps/api/src/modules/candidates/candidates.service.ts:160-162, 879-946`; `candidates.schemas.ts:214-232`; `db/migrations/0260_candidate_unique_contact.sql:39-52`
- Category: Security (OWASP API6 sensitive business flow / API4)
- Severity: Medium
- Existing implementation: `POST /batches/:id/candidates/bulk` accepts `{ dryRun: true, rows: [≤500] }` and inserts each row inside a savepoint. The `authz.candidate_contact_unique` trigger searches every candidate org-wide, regardless of what the caller can see. When it raises `duplicate_email` or `duplicate_phone`, that code goes back per row (`:924-927`). Everything is then rolled back, and the audit records only `{ rows, failed }` (`:941-943`). The limit is `BULK_CANDIDATE_CALLS_PER_MINUTE = 10` per user per task. The dedicated `POST /candidates/duplicate-check` is limited to `DUPLICATE_CHECKS_PER_MINUTE = 20`, and each of its calls is audited.
- Problem: Any `candidate:create` holder (recruiters with a team) can check 500 × 10 = 5,000 emails or phones per minute per API task against the whole org's candidate pool. They learn which people are already candidates, including candidates outside their scope. That is 250 times the dedicated check's budget. The audit does not record which values were probed, so this use cannot be told apart from a real import afterwards.
- Recommended solution: Count dry-run rows against the same per-user duplicate budget, or add a separate daily row budget such as 2,000 rows per user per day, stored in the DB (the rate limiter is in memory, per task). Record `taken: n` in `batch.candidates_checked` and alert on users with high taken ratios. Optionally answer `duplicate_contact` for out-of-scope matches only on a non-dry run.
- Alternatives & trade-offs: (a) Remove `duplicate_*` from dry-run responses and only fail on commit. Previews get less useful, but the oracle shrinks to one commit attempt. (b) Keep the current behavior but require `candidate:create` at team scope or higher. This does not stop leads.
- Expected benefit: Closes a bulk enumeration path for candidate PII membership.
- Complexity: S–M
- Regression risks: Legitimate large imports (500 rows) might hit a daily budget. Size it from real batch sizes, where `sizePlanned` is ≤500.
- Required tests: A dry run past the budget returns 429. The audit row carries the taken count. A non-dry-run import still fails per row.
- Breaking API change?: no (adds 429 cases)

#### A-04 · Application CSV export writes unmasked applicant emails to callers without `applicant:read`

- Module / files: `apps/api/src/modules/applications/applications.service.ts:98-102, 162-176`; `applications.controller.ts:33-41`; `db/migrations/0062_applications.sql:644-645`; `docs/jobs-portal-api.md` ("email and phone are masked for everyone without `applicant:read`")
- Category: Security (OWASP API3 excessive data exposure)
- Severity: Medium
- Existing implementation: JSON responses mask the email unless the caller holds `applicant:read` at org scope (`email()` at `:98-102`, used in `present`). The export requires only `application:read` (`:163`) and writes `r.email ?? ""` directly (`:172`). The applicant row is readable to any caller who can see one of that applicant's applications (`applicant_via_application` policy), so the email is not blocked by RLS either.
- Problem: Today only HR holds `application:read`, and HR also holds `applicant:read`. But the catalog supports custom roles cloned from system roles (`catalog.ts:3,78`). A role given `application:read` without `applicant:read`, for example a hiring coordinator, can export up to 5,000 applicant emails per call, which goes against the documented field rule and the JSON behavior. The field rule depends on how roles are configured instead of being enforced in code.
- Recommended solution: In `exportCsv`, write `this.email(user.access, r.email)`, or drop the Email column when `applicant:read` is not org-wide. Add `emails: true|false` to the audit like the applicant export's `phones` flag. Optionally enforce in the catalog that `application:read` implies `applicant:read`.
- Alternatives & trade-offs: Requiring `applicant:read` on the export route is simpler, but it blocks a legitimate export of masked rows.
- Expected benefit: The field policy is enforced in code rather than by role configuration.
- Complexity: S
- Regression risks: The HR export is unchanged.
- Required tests: A custom role with `application:read` only gets masked emails in the CSV. HR gets full emails.
- Breaking API change?: no
- **Lead review:** Verified: JSON path masks via `this.email()` (applications.service.ts:98-99,123); CSV path writes raw `r.email` (applications.service.ts:172).

#### A-10 · Candidate birth year is returned to every candidate reader, outside the field policy

- Module / files: `candidates.service.ts:352` (`p.dob_year` in `baseSelect`), `:374-377` (field policy gets `dob: null`), `:404` (`dobMasked: \`•• / •• / ${r.dob_year}\``); `docs/design.md:77` ("DOB is always masked"); `catalog` restricted permission `candidate.dob:read` (`docs/design.md:573`)
- Category: Security (OWASP API3)
- Severity: Low
- Existing implementation: `applyCandidateFieldPolicy` controls the phone, but `dobMasked` is built directly from `dob_year` for every caller who can read the candidate, including those who see it only through Open to all teams or Selected teams. The open Hot List correctly returns `dobMasked: null` (`:527`).
- Problem: Part of the DOB, which is classified Confidential (`design.md:194`), reaches non-owners and callers without the restricted `candidate.dob:read`. The same profile code withholds LinkedIn and the resume link from those viewers (`profileExtras`, `:265-276`). Impact is limited today because only seeds write `dob_year` (`apps/api/src/db/seed-load.ts:171`).
- Recommended solution: Pass `dob_year` through `applyCandidateFieldPolicy`: show the year only to owners (or only to `candidate.dob:read`), otherwise `null`. Or remove `dob_year` from `baseSelect` until OD-04 is decided.
- Alternatives & trade-offs: None needed; this is a small change.
- Expected benefit: A consistent field policy before DOB writes go live.
- Complexity: S
- Regression risks: The UI shows "—" for non-owners.
- Required tests: A non-owner (all-teams) GET gets `dobMasked: null`. An owner sees the year.
- Breaking API change?: no (value may become null)

### Placements & HR (placements, payments, contracts, work-authorization, paperwork, documents, employees)

#### B-01 · Restricted documents (I-9, driving license, work authorization) open without step-up; code, docs and TTLs still assume it

- Module / files: `db/functions/authz/document_download.sql:34-37`; `apps/api/src/modules/documents/documents.service.ts:29-30,245-273`; `documents.controller.ts:6-11,48`; `docs/documents-api.md:40`; `work-authorization.service.ts:206`; commit `cd4d82e` / migration 0350.
- Category: Security (OWASP API2 broken authentication / API6 sensitive business flow)
- Severity: High
- Existing implementation: `document_download` now only records a grant: `-- A live step-up grant is recorded when the session holds one; it is no longer required.` (`:34`) then returns `ok`. The service still maps `outcome === "step_up_required"` (`documents.service.ts:270`, unreachable), the controller doc says restricted documents open "after step-up", and the restricted presigned GET lives 300 s vs 60 s for internal files (`:30`). Work-authorization reveal still hard-requires step-up (`work-authorization.service.ts:206`), which the same commit message says Google users cannot obtain.
- Problem: The most sensitive PII in the system (I-9 contains SSN/DOB; DL; visa documents) is released on a single, possibly long-lived session cookie. A hijacked session or unattended browser can bulk-download restricted files (30/min per process, B-09). The longest link lifetime is given to the most sensitive class. Code and docs advertise a control that no longer exists, so reviewers will assume it. Work-auth reveal is in the opposite state: required but unobtainable for Google users.
- Recommended solution: Restore a step-up requirement for `classification <> 'internal'` using a factor every user can complete: password re-entry (`StepUpPassword` already exists in `step-up.controller.ts:20`), WebAuthn, or OIDC with `prompt=login` and checking `iat` instead of `auth_time`. Make the policy a setting (`authz.policy_setting restricted_step_up`) so the business decision is explicit and audited. Set restricted TTL ≤ 60 s. Remove dead `step_up_required` branches or keep them live; fix comments/docs.
- Alternatives & trade-offs: Keep no-step-up but add compensating controls (per-user daily cap enforced in SQL as `work_auth_reveal` does, anomaly alert on >N restricted opens, session max-age 15 min for restricted roles). Less friction, weaker assurance.
- Expected benefit: Restricted PII again needs proof of presence; consistent behaviour between documents and work-auth reveal.
- Complexity: M
- Regression risks: Users without a usable factor lose access; e2e `documents.spec.ts` and the 0350 tests flip.
- Required tests: matrix with/without/expired grant for each role; TTL assertion; Google-user path with the new factor.
- Breaking API change?: no (403 `step_up_required` is already a documented response).
- **Lead review:** Verified: commit cd4d82e deliberately removed the step-up requirement because Google does not return `auth_time` for unverified apps. This is an **accepted-risk decision that was never re-reviewed**, not an accidental regression; the defect is that docs, comments, link TTLs and the work-authorization path still assume step-up. Kept **High** pending an explicit owner decision.

#### B-04 · Contracts: API does no permission pre-check and its `canAdd` hint diverges from `authz.create_contract`

- Module / files: `apps/api/src/modules/contracts/contracts.controller.ts:17-21`; `contracts.service.ts:79-82,101,106-120`; `db/migrations/0160_sales_placements.sql:281-294`.
- Category: Security (OWASP API5 BFLA, rule 6) / Design
- Severity: Medium
- Existing implementation: `POST /placements/:id/contracts` is decorated `@RequirePermission("placement:read")` and goes straight to the definer. `canAdd` = `resolveScope(access, "invoice:update") !== null` (any scope) OR `ownsActivity(placement:update)` (recruiter, team **or location** ids). The function allows `has_org('invoice:update') OR has_org('placement:update') OR recruiter_ids(...) OR owned_team_ids(...)` (no location, owned teams only, invoice:update only at org).
- Problem: Rule 6 asks for an API-level 403 as well; today every `placement:read` holder reaches the definer for writes. The UI shows "Add contract" to location-scoped or non-org `invoice:update` holders (custom roles via role_create) who then get 403, and the two rules will keep drifting since nothing tests them together.
- Recommended solution: Put the rule in `packages/shared` (`contractAccess(access, placementRef)`) mirroring the SQL exactly (org invoice:update; placement:update recruiter/owned-team), use it in the service as a read-before-write 403 (after a 404 visibility check) and for `canAdd`; add a DB/TS parity test like `paperwork.db.int.test.ts:157`. Consider `@RequirePermission("placement:update")` is not possible (Accounts use invoice:update), so keep the service check.
- Alternatives & trade-offs: Have the SQL expose `authz.contract_can_add(placement)` and call it for the hint (one extra round trip, zero drift).
- Expected benefit: Consistent 403s, correct UI, rule 6 compliance.
- Complexity: S
- Regression risks: Users relying on location scope would lose a button that never worked.
- Required tests: role matrix (recruiter own/other, lead, location-scoped manager, Accounts, custom scoped invoice:update) asserting `canAdd` equals POST outcome.
- Breaking API change?: no

#### B-09 · In-memory per-process rate limits on document downloads/uploads and exports

- Module / files: `documents.service.ts:121-122,177,228,257`; `placements.service.ts:212,224`; `employees.service.ts:204`.
- Category: Security (OWASP API4)
- Severity: Low
- Existing implementation: `new RateLimiter(DOCUMENT_DOWNLOADS_PER_MINUTE, 60_000)` per service instance; work-auth reveal instead counts in SQL across tasks (`work-authorization.service.ts:19-21`).
- Problem: With N API tasks (and the worker restart resetting counters) the effective limit is N× and resets on deploy; combined with B-01 this is the only brake on bulk restricted-document download.
- Recommended solution: Enforce the download limit in `authz.document_download` from `eureka.document_access` (same pattern as `work_auth_reveal`), at least for restricted files; keep in-memory as a first line.
- Alternatives & trade-offs: Redis/ElastiCache limiter (new infra).
- Expected benefit: Limits that hold across instances.
- Complexity: S
- Regression risks: Extra index on `document_access (user_id, at)`.
- Required tests: limit across two connections/sessions; 429 mapping.
- Breaking API change?: no

#### B-12 · `GET /document-access` has no `@RequirePermission`

- Module / files: `apps/api/src/modules/documents/documents.controller.ts:70-74`; `documents.service.ts:280-291`; `platform/auth.guard.ts:116-117`.
- Category: Security (convention; OWASP API5) / Maintainability
- Severity: Low
- Existing implementation: The route has no decorator, so the guard only requires a session; the service checks `audit:read` or `document.restricted:read` and RLS `document_access_read` re-applies it.
- Problem: Not exploitable today, but violates the "decorator on every route" rule and any route-inventory/permission tooling will list it as unauthenticated-only. A future refactor of the service check would expose the access log.
- Recommended solution: Add a decorator for the weaker permission (`document.restricted:read`) and a dedicated `@RequireAnyPermission("audit:read","document.restricted:read")` if needed; add a route-coverage test asserting every controller method has a permission or `@Public`.
- Alternatives & trade-offs: None needed.
- Expected benefit: Defense in depth, audit-friendly inventory.
- Complexity: S
- Regression risks: Auditors without `document.restricted:read` would need the any-of decorator.
- Required tests: route-metadata coverage test; 403 for a plain user.
- Breaking API change?: no

### Administration & identity (admin, identity, staff, lookups, preferred-vendors, imports, datahub)

#### C-01 · One admin can mint new `access:manage` holders (and give admin-trait roles data permissions) without the second approver

- Module / files: packages/shared/src/authz/catalog.ts:407-414 (RESTRICTED_PERMISSIONS), :911-921 (ORG_SENSITIVE_PERMISSIONS); db/migrations/0311_custom_roles.sql:67-95 (is_restricted derivation); db/functions/authz/role_set_grants.sql:47-55; db/functions/authz/role_create.sql:123-129; db/functions/authz/request_role.sql:39-55; db/functions/authz/role_separation.sql:128-131; db/migrations/0013_admin.sql:133-144 (admin_guard); apps/api/src/modules/admin/admin.service.ts:624-636, 738-753; apps/api/test/admin-roles.api.int.test.ts:165-238
- Category: Security (OWASP API5 BFLA / API6 sensitive business flow)
- Severity: High
- Existing implementation: `role.is_restricted` is derived as `is_admin OR` holds a permission in `eureka.permission.is_restricted` (RESTRICTED_PERMISSIONS) `OR` an org-sensitive one at org scope (0311:72-74). `access:manage` and `audit:read` are in neither list (catalog.ts:407-414, 911-921). `authz.role_set_grants` only raises `role_in_use` on a held role for newly added *restricted* or *org-sensitive@org* permissions (role_set_grants.sql:48-55); it accepts any catalog permission at any scope on any custom role. `authz.admin_guard` (0013:136-141), which gates every admin, import and approval function, checks only `authz.has_org('access:manage')`, not the admin trait. Separation of duties (`role_separation.sql:128-131`) compares the `is_admin` trait only.
- Problem: An `org_admin`, acting alone, can:
  (a) `POST /admin/roles {cloneFrom:"<any non-admin role>"}`, then `PUT /admin/roles/c_x/grants {"access:manage":"org", ...}`. The role stays `restricted=false`, so `POST /admin/role-requests` applies it immediately (request_role.sql:48-54) to any other user, including holders of data roles, because the trait check sees no admin trait.
  (b) Do the same to a custom role that is *already held*: adding `access:manage` raises no `role_in_use`, so every current holder becomes an admin instantly.
  The new holder passes `admin_guard`, so they can approve the first admin's restricted-role requests (`approve_role_request.sql:97` only requires actor ≠ requester/grantee) and imports (`import_approve_batch` only requires actor ≠ operator). That defeats AD-3 and the import two-person rule. On staging, `admin_set_password` refuses only `is_restricted` targets (0083:170-173), so the admin can also set that user's password and act as them. Separately, a custom role cloned from `org_admin` (unheld) can be given business permissions (candidate:read@org etc.), which breaks AD-1 ("org_admin still has no data permissions", docs/admin-api.md:11). That case needs a second approver, but it creates a role that combines admin and data access, which AD-3a forbids.
- Recommended solution: (1) Add `access:manage` (and `audit:read`) to a new `ADMIN_PERMISSIONS` set mirrored into `eureka.permission` (e.g. `is_admin_only`), and enforce in `role_set_grants`/`role_create`: admin-only permissions only on `is_admin` roles, and no non-admin-only permission on an `is_admin` role (a DB invariant, ideally a constraint trigger on `role_permission`). (2) Derive `is_restricted` from that set too. (3) Have `admin_guard` require `authz.user_has_trait(actor,'admin')` in addition to the permission, so a mis-built role can't pass it. (4) Add deny-path tests for (a), (b) and the admin-clone-with-data case.
- Alternatives & trade-offs: Only mark `access:manage` restricted. That is cheaper and keeps the second approver, but still lets admin and data permissions mix in one role. Or forbid `access:manage` on custom roles entirely, which is simplest but stops admins from creating a "deputy admin" (an existing test case, admin-roles test :227).
- Expected benefit: Restores the two-person guarantee for every route that trusts `access:manage`: role grants, imports and password resets.
- Complexity: M
- Regression risks: Existing custom roles that already carry these permissions would fail the new invariant; a migration must detect and report them first. The seedCatalog flag update re-derives `is_restricted` (migrate.ts:126-130).
- Required tests: role_set_grants refuses `access:manage` on a non-admin role (held and unheld); refuses data permissions on an admin-trait role; role_update refuses trait flips that would break the invariant; admin_guard refuses a non-admin-trait holder; approve_role_request by such a holder is refused.
- Breaking API change?: no (new 422 codes on existing routes)
- **Lead review:** Verified: `access:manage`/`audit:read` absent from `RESTRICTED_PERMISSIONS` (catalog.ts:407) and `ORG_SENSITIVE_PERMISSIONS` (catalog.ts:911); `authz.admin_guard` (0013_admin.sql:136) gates only on `has_org('access:manage')`; `request_role.sql` applies non-restricted roles without approval. Severity kept **High**.

#### C-05 · Audit rows for created users, teams and locations carry free text that the rename paths deliberately omit (rule 5)

- Module / files: apps/api/src/modules/admin/admin.service.ts:342-345 and :434-437 (`changes: { email, displayName, designation, ... }`), :864 (`createTeam ... changes: body`, includes `name`), :1053 (`createLocation ... changes: body`, includes `name`, `state`); compare :869-874 ("The name is free text, so the audit row records only that it changed (rule 5)") and :1058; platform/audit.service.ts:8-26 (REDACT has `email` but not `displayName`, `name`, `designation`, `state`)
- Category: Security (data minimisation) / Observability
- Severity: Low
- Existing implementation: `email` is redacted by key, but `displayName`, `designation`, team `name` and location `name/state` are written into `audit_event.changes` verbatim on create, while rename/department paths record ids only "per rule 5".
- Problem: Inconsistent with project rule 5 (no free text in audit_event) and with the module's own comments. Person names in an append-only table can't be erased when the user is purged (the user is anonymised after 7 days, USER_PURGE_DAYS, but the audit copy of displayName stays).
- Recommended solution: Record ids and `fields: Object.keys(body)` only (as preferred-vendors does at preferred-vendors.service.ts:126-128), or add these keys to REDACT for the admin actions.
- Alternatives & trade-offs: Keeping the names helps forensics. If that's wanted, document an explicit exception in rule 5 and handle it in the purge job.
- Expected benefit: Consistent compliance; purge really removes the personal data.
- Complexity: S
- Regression risks: Tests asserting audit payloads.
- Required tests: audit row for admin.user.created / admin.team.created / admin.location.created contains no name/designation.
- Breaking API change?: no

#### C-07 · Password lockout reveals which emails have accounts and lets anyone lock a user out (staging/local only)

- Module / files: db/migrations/0083_password_login.sql:83-104 (password_verify), :107-129 (password_login); apps/api/src/modules/identity/password.controller.ts:55-61
- Category: Security (OWASP API2)
- Severity: Low
- Existing implementation: Unknown emails always return `invalid` (with a dummy bcrypt, so timing matches). A known account returns `locked` → HTTP 429 `account_locked` once the failure count reaches `maxf` (default 5), and stays locked for 15 minutes. The per-IP limiter allows 30 tries per 10 minutes per IPv4 address or IPv6 /64.
- Problem: Five wrong guesses against an address tell the attacker the account exists (unknown emails never produce 429 `account_locked`). The same five guesses also lock the real user out for 15 minutes, and anyone can repeat this. The exposure is limited because password sign-in is refused outside staging/local (config.ts:96-97, seedCatalog policy switch).
- Recommended solution: Return the same 401 for `locked` as for `invalid` (show "try again later" generically), and/or track pseudo-lockout for unknown emails in a small table keyed by the email's HMAC so both paths behave identically. Consider progressive delay instead of a hard lock.
- Alternatives & trade-offs: A visible lock is friendlier for real users; the trade-off is acceptable on staging if documented.
- Expected benefit: Removes the existence oracle.
- Complexity: S
- Regression risks: The password-login lockout test expects 429.
- Required tests: unknown vs known-locked email produce identical status/body.
- Breaking API change?: no (status code change on an error path)

#### C-08 · xlsx import bounds the compressed size only; the workbook is fully expanded before row/column checks

- Module / files: apps/api/src/import/xlsx.ts:11, 41-53
- Category: Security (OWASP API4) / Performance (HYPOTHESIS)
- Severity: Low
- Existing implementation: `readWorkbook` rejects input over 10 MB and non-zip magic, then `await readExcelFile(input)` parses every sheet into memory; the 50,000-row / 100-column limits are checked afterwards per sheet.
- Problem: A ≤10 MB .xlsx can expand to hundreds of MB of XML (zip bomb) or contain a very wide or long sheet. The parse runs to completion before any limit is enforced, so a crafted file can exhaust memory on the operator's machine. Only org admins run the CLI (`propose-mapping`/`stage`) on files they were given, so exposure is small, but the code comment ("bound what we are willing to expand") claims a guarantee it does not provide.
- Recommended solution: Check the uncompressed sizes in the zip central directory (e.g. with `yauzl`/`fflate`) before parsing, and reject when the total exceeds about 50 MB or any entry is over N MB. Alternatively, run the parse in a worker thread with `resourceLimits.maxOldGenerationSizeMb`.
- Alternatives & trade-offs: Streaming readers (exceljs streaming) avoid holding everything in memory but are a larger change.
- Expected benefit: Bounded memory, and the code matches its stated guarantee.
- Complexity: S
- Regression risks: Legitimate large workbooks near the limit.
- Required tests: a synthetic zip with a high compression ratio is rejected before parsing.
- Breaking API change?: no

### Operations (facilities, training, performance, feedback, notifications, chat)

#### D-01 · Public feedback IP rate limit is keyed on the raw address (IPv6 rotation bypass)

- Module / files: `apps/api/src/modules/feedback/feedback.controller.ts:21-31`; compare `apps/api/src/modules/identity/password.controller.ts:55`, `apps/api/src/modules/portal/portal-auth.service.ts:61`, `apps/api/src/platform/client-ip.ts:20-33`
- Category: Security (OWASP API4)
- Severity: Medium
- Existing implementation: `const ip = clientIp(req, this.config); for (const key of [\`ip:${ip}\`, \`token:${hash}\`]) if (!this.limiter.take(key)) throw 429`. The limiter is `new RateLimiter(30, 60_000)`: in memory, per task, `maxKeys` 10,000 with oldest-first eviction.
- Problem: The other public or anonymous limiters key on `ipKey(...)`, which collapses IPv6 to its /64 ("rotating addresses inside it must not earn new allowances"). Feedback skips it, so a client holding one /64 gets 30 requests per minute per address, which is effectively unlimited. Every request costs two definer calls through `db.system`. Each request also inserts a `token:` key, so a flood of distinct tokens fills the 10k-key map and evicts the live `ip:` windows. The flood therefore removes its own limit and everyone else's. Brute-forcing a token stays infeasible (256-bit), so the risk is resource consumption on an unauthenticated route, not account takeover.
- Recommended solution: Use `ipKey(clientIp(req, this.config))`. Check the IP key and only then hash the token and take the token key, so malformed or unknown tokens cannot evict IP windows. Consider a separate small limiter for token keys.
- Alternatives & trade-offs: A DB-backed counter (as the portal has "database-wide caps") works across tasks but writes on every request. Edge/WAF rate limiting is already assumed by the comments, but nothing in the repo enforces it.
- Expected benefit: The per-/64 limit actually holds, and the limiter cannot be flushed.
- Complexity: S
- Regression risks: Legitimate users sharing a /64 (carrier NAT) share 30 requests per minute, which is ample for a single-use form.
- Required tests: Requests from `2001:db8::1` and `2001:db8::2` share one window; 10k distinct tokens from one IP do not reset that IP's window.
- Breaking API change?: no

#### D-12 · Route authorisation intent is not machine-checkable (no exemption marker, no route meta-test)

- Module / files: `apps/api/src/modules/notifications/notifications.controller.ts:10-43` (no `@RequirePermission`; session only by design); `apps/api/src/modules/training/training.controller.ts:40-44,69-74,112-131,228-232` (writes gated by `training:read`, real check in the service); `apps/api/src/platform/auth.guard.ts:116-117` (no decorator means any signed-in user)
- Category: Security (OWASP API5 hygiene) / Testing
- Severity: Low
- Existing implementation: When a route has no `REQUIRED_PERMISSION`, the guard lets any authenticated session through. No test enumerates routes for a permission or a deliberate exemption (only `placements.cases.ts` references it).
- Problem: All of these are correct today: the notification inbox is per-user under RLS, and the training writes re-check through `canPlanBatch`/`staffable`/`deletable` and the definers. But a future controller that forgets the decorator fails open silently, and decorators like `training:read` on DELETE make the endpoint inventory misleading.
- Recommended solution: Add `@SessionOnly()` (or `@RequirePermission("self")`) as an explicit exemption, plus a test that walks Nest's route metadata and fails on any route with neither `@Public`, `@SessionOnly` nor `@RequirePermission`. Optionally add `@ServiceChecked("canPlanBatch")` documentation metadata for broad-decorator writes.
- Alternatives & trade-offs: Default-deny in the guard is stronger but needs a sweep across all modules.
- Expected benefit: Missing-authorisation regressions are caught in CI.
- Complexity: S
- Regression risks: None at runtime.
- Required tests: The route-metadata test itself.
- Breaking API change?: no

### Interviews, reporting & portal (interviews, interview-reports, calendar, dashboard, pipeline-report, reports, portal)

#### E-01 · Portal global hourly caps let a few addresses lock every applicant out of sign-in, silently

- Module / files: `apps/api/src/modules/portal/portal-auth.service.ts:32-33,99-122,124-134`; `db/migrations/0061_applicant_portal.sql:158-173` (`portal_take`), `:195` (link cap), `:220` (sign-up cap)
- Category: Security (OWASP API6 sensitive business flow / API4 resource consumption)
- Severity: High
- Existing implementation: `GLOBAL_LINKS_PER_HOUR = 600` and `GLOBAL_SIGNUPS_PER_HOUR = 200` are database-wide hourly buckets (`eureka.portal_throttle`). `portal_link_insert` refuses any link once `NOT authz.portal_take('link', p_global)`, and that bucket is shared by sign-up confirmation links for new, unverified addresses and sign-in links for verified applicants. The per-IP limiter allows 20 requests per 15 minutes, which is 80 per hour per IPv4 address or IPv6 /64 (`REQUESTS_PER_IP`). When a cap trips, `portal_sign_up`/`portal_issue_link` just `RETURN`. The API answers the generic 202 and logs nothing (`defer` logs only exceptions).
- Problem: An attacker who sends sign-ups for random new addresses fills the sign-up bucket with about 3 IPv4 addresses. Each created account can then take 10 links per hour, so about 8 addresses (or one IPv6 /56) exhaust the 600-link bucket. For the rest of the hour no legitimate applicant, verified or not, can get a sign-in link. They still see "we sent a link", and operators get no signal. The WAF rule (`infra/modules/stack/edge.tf:118-130`, 100 per 5 minutes per IP) does not change this arithmetic, and AWS compute and edge are currently deleted per CLAUDE.md.
- Recommended solution: Split the link budget into separate buckets for links to verified applicants and links to unverified addresses (or exempt verified applicants and keep only their per-applicant 10/h + 60 s limits). Emit a structured warning and metric (`portal_cap_reached{kind}`) when `portal_take` returns false, and alert on it.
- Alternatives & trade-offs: CAPTCHA/Turnstile on sign-up only. That adds friction but removes the cheap automation. Per-/48 IPv6 keying makes rotation harder but punishes shared carriers. A larger cap reduces the risk but raises the email-reputation and cost exposure the cap exists to protect.
- Expected benefit: Existing applicants can always sign in, and an attack becomes visible.
- Complexity: S–M
- Regression risks: The cap tests (`portal-auth.api.int.test.ts:182`) need updating. The migration must keep the throttle table's CHECK on `kind` in sync.
- Required tests: Exhaust the unverified bucket, then a verified applicant still gets a link. The metric/log is emitted when a cap trips.
- Breaking API change?: no
- **Lead review:** Verified: per-IP 20 requests/15 min (portal-auth.service.ts:35) ≈ 80/h per address vs `GLOBAL_LINKS_PER_HOUR = 600` / `GLOBAL_SIGNUPS_PER_HOUR = 200` (portal-auth.service.ts:32-33). Kept **High** (availability of the only external-facing flow).

#### E-07 · Portal deferred work: unbounded in-process queue on the shared pool, never drained on shutdown

- Module / files: `apps/api/src/modules/portal/portal-auth.service.ts:50,65-76,99-134`; `apps/api/src/platform/db.service.ts:91-93` (`onModuleDestroy` ends the pool); `drain()` is referenced only from tests (no non-test caller found by grep)
- Category: Security (OWASP API4) / Reliability
- Severity: Medium
- Existing implementation: `signUp`/`requestLink` reply 202 and push a promise into `this.pending` (a `Set`, unbounded). Each promise does `db.system` (pool connection), the definer call, an audit insert, then an SMTP send. Throttling is per client address only. `drain()` exists "for tests, graceful shutdown", but nothing calls it on shutdown, and `onModuleDestroy` ends the pool.
- Problem: (a) A distributed flood (many IPs or /64s) queues thousands of deferred jobs that compete for the same 10 connections as staff traffic. The 202 returns immediately, so there is no back-pressure. (b) On deploy or SIGTERM, in-flight sign-ups and links are lost or fail against a closed pool. The user was told an email was sent.
- Recommended solution: Bound the queue (for example 200 pending per task). When it is full, return 429/503: still uniform, since it says nothing about accounts. Run deferred DB work through a small dedicated semaphore. Call `drain()` in `beforeApplicationShutdown` (with `app.enableShutdownHooks()`) before the pool ends. Longer term, put the link request into the outbox and let the worker send the mail (durable).
- Alternatives & trade-offs: The outbox gives durability but adds a dependency on worker latency for sign-in emails.
- Expected benefit: Portal floods cannot starve staff traffic. No lost links on deploy.
- Complexity: S (bound + drain) / M (outbox)
- Regression risks: The constant-time and uniform-answer property must hold, so the full-queue answer must not depend on the email.
- Required tests: Queue full returns uniform 429. Shutdown waits for pending work.
- Breaking API change?: no

#### E-08 · Interview audit rows store free text (`round`, `systemName`), violating rule 5

- Module / files: `apps/api/src/modules/interviews/interviews.service.ts:338-345` (`round: body.round`), `:395-401` (`changes = { ...columns }` includes `round`, `systemName`); `apps/api/src/platform/audit.service.ts:8-25` (REDACT has neither key)
- Category: Security (rule 5 / data minimisation)
- Severity: Low
- Existing implementation: Links are deliberately reduced to "set"/"cleared" (:396-398), but every other changed column is copied verbatim. `round` is free text (≤40, `interviews.schemas.ts:131,163`) and `systemName` is free text (≤80, :174).
- Problem: Rule 5 forbids free text in `audit_event`. Users type anything into these fields, candidate names included.
- Recommended solution: Audit `round`/`systemName` as `"set"`/`"changed"`, or add them to `REDACT`. Add a unit test enumerating free-text schema fields against REDACT.
- Alternatives & trade-offs: Restricting `round` to an enum (Round 1..N, Final) would make it non-free-text and improve reporting.
- Expected benefit: Rule compliance and a smaller PII surface in the audit.
- Complexity: S
- Regression risks: Audit consumers that display the round.
- Required tests: The audit row after a PATCH with `systemName` holds no raw value.
- Breaking API change?: no

### Platform & cross-cutting (auth, data access, worker/outbox, shared authz, test infra)

#### F-08 · AuthGuard is default-allow for any signed-in user; no route-authz inventory test

- Module / files: apps/api/src/platform/auth.guard.ts:116-118 (`if (needed && !can(access, needed)) throw …; return true;`); 36 of ~355 staff routes have no `@RequirePermission`/`@Public`/`@PortalRoute` at method or class level (static scan), e.g. modules/lookups/lookups.controller.ts (POST technologies/clients/vendors), modules/applications/applications.controller.ts (GET list, GET :id, POST :id/status, POST :id/interviews, PUT :id/people, PUT :id/scorecard), modules/jobs/jobs.controller.ts (GET :id), modules/preferred-vendors (GET list/:id), modules/calendar (GET busy), modules/documents (GET document-access), plus self-service identity/settings/notifications routes
- Category: Security (OWASP API5 BFLA), Design / Testing
- Severity: Medium
- Existing implementation: a route without metadata passes as long as a session exists. Those 36 routes rely on service-level `can()` checks or RLS. The platform review found no exploitable hole; whether each one is correct belongs to the owning module's review. The mass-assignment suite already enumerates routes by reflection (`mass-assignment.cases.ts:2455-2475`), but nothing asserts that each route declares its authz posture.
- Problem: a forgotten decorator silently makes a route reachable by every staff role, including future custom roles (`role_create.sql`). Defence then rests entirely on service code and RLS, with no meta-test to catch omissions.
- Recommended solution: fail closed. Add a `@SelfService()` (any signed-in user, by design) decorator. Make the guard throw 403 when a staff route has none of `RequirePermission | Public | PortalRoute | SelfService`. Add an inventory test reusing the `writeRoutes()` reflection over all verbs, with a reviewed allow-list snapshot.
- Alternatives & trade-offs: only the inventory test (no runtime change). Lower risk, still catches regressions in CI.
- Expected benefit: an omission is caught at CI time instead of in production.
- Complexity: S
- Regression risks: annotating the 36 routes; a missed one turns into 403 (fails safe).
- Required tests: the inventory test, plus one guard unit test for an undecorated route returning 403.
- Breaking API change?: no

#### F-06 · Application rate limits are in memory per task and reset on deploy

- Module / files: apps/api/src/platform/rate-limit.ts:1-36; ~37 instances, e.g. modules/identity/password.controller.ts:27, modules/portal/portal-auth.service.ts:48-49, export limiters in hotlist.service.ts:75, employees.service.ts:208, placements.service.ts:212, dashboard.service.ts:154, applications.service.ts:82; infra/live/production/env.hcl:28 (`api_max_count = 3`)
- Category: Security (OWASP API4 unrestricted resource consumption / API6 sensitive business flows)
- Severity: Low
- Existing implementation: a fixed-window `Map` per service instance. The header comment (`rate-limit.ts:2-5`) says it is "not a global quota", with WAF (3000/5 min per IP; 100/5 min on `/api/auth/` and portal auth) and API Gateway (100 rps shared) covering volume.
- Problem: under autoscaling the effective limit is N × the limit, and each rolling deploy or task restart resets every window. The limits that matter for data protection are the bulk PII exports (e.g. `EXPORTS_PER_WINDOW`) and per-user upload/download throttles. WAF limits are per IP and cannot express "per user per export". Impact is bounded today (1–3 tasks, internal users), so Low.
- Recommended solution: for the sensitive limiters only (exports, password/portal auth, uploads), add a Postgres-backed counter: `INSERT INTO eureka.rate_window(key, window_start, n) … ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n`, inside the request's tx. Keep in-memory limiters for cheap read throttles. Inject the limiter (factory provider) so tests can control time.
- Alternatives & trade-offs: Redis/ElastiCache is more infrastructure and cost for an app with tens of users. A DB row adds one write per export, which is negligible.
- Expected benefit: deterministic per-user quotas regardless of task count or deploys.
- Complexity: M
- Regression risks: a hot-row lock on very frequent keys. Use it only for low-rate actions.
- Required tests: two app instances sharing a DB; the export limit is enforced across both.
- Breaking API change?: no

#### F-13 · Staff session table sits outside RLS with direct table grants to the API role

- Module / files: db/migrations/0002_org_identity.sql:185 (`GRANT SELECT, INSERT, UPDATE ON session TO eureka_app`); apps/api/test/rls.int.test.ts:19-22 (`session` in `RLS_ALLOW_LIST`); apps/api/src/modules/identity/settings.service.ts:121-125, 146-149, 164-166; apps/api/src/platform/session.service.ts:33-41, 53-70; contrast platform/portal-session.service.ts:19-31 (applicant sessions only through definer functions `authz.portal_session_*`, table RLS-forced, `0061_applicant_portal.sql:141`)
- Category: Security (OWASP API1 BOLA, defence in depth)
- Severity: Low
- Existing implementation: owner isolation for "Login activity" and revoke depends on hand-written `WHERE user_id = $1` predicates. Any `withUser` code path can read every user's `device_class`, `browser`, `ip_masked`, `last_seen_at` and `id_hash`, and set `revoked_at` on any session.
- Problem: today's queries are correct. But one missing predicate in a future query would expose or revoke other users' sessions, with no DB backstop. `id_hash` is not replayable as a cookie (it is SHA-256 of a 256-bit secret). It is, however, the key `authz.step_up_current($1)` takes.
- Recommended solution: apply the portal pattern. Move create, resolve, touch, revoke, list-own and revoke-others into `authz.*` definer functions; revoke table privileges from `eureka_app`; enable and force RLS on `eureka.session`.
- Alternatives & trade-offs: an RLS policy `user_id = authz.current_user_id()` plus a definer for the no-user resolve path. Similar effort.
- Expected benefit: session isolation enforced by the DB.
- Complexity: M
- Regression risks: hot path (every request); keep it to a single statement per F-03.
- Required tests: a DB test that `eureka_app` as user A cannot select or update user B's session rows.
- Breaking API change?: no

#### F-14 · Staff session cookie hardening is weaker than the portal cookie

- Module / files: apps/api/src/modules/identity/auth.controller.ts:30-38; modules/identity/password.controller.ts:63-66, 89-92 (duplicated cookie options); contrast platform/portal-session.service.ts:15 (`__Secure-` prefix in production)
- Category: Security (OWASP API8 misconfiguration)
- Severity: Low
- Existing implementation: `eureka_sid` has `httpOnly`, `sameSite: "lax"`, `path: "/"`, and `secure` only when `NODE_ENV === "production"`. The option object is copied in three places.
- Problem: there is no `__Host-` prefix, which would bind the cookie to the exact host and forbid `Domain`, preventing cookie tossing from a sibling subdomain. Staging, which runs `NODE_ENV=production`, gets Secure, but any HTTPS environment with a different NODE_ENV would not. The duplicated options can drift.
- Recommended solution: `__Host-eureka_sid` (path `/` already satisfies `__Host-`) with `secure: true` whenever `PUBLIC_BASE_URL` is https. Put it in a single `sessionCookieOptions()` on SessionService.
- Alternatives & trade-offs: keep the name for compatibility. The rename only forces one re-login.
- Expected benefit: defence against subdomain cookie injection; a single source of truth.
- Complexity: S
- Regression risks: existing sessions are dropped at deploy (users sign in again); e2e tests reference the cookie name.
- Required tests: the cookie attribute assertion in api.int.
- Breaking API change?: no (cookie name only; clients don't read it)

### Database (schema & RLS, definer functions, indexes, migrations tooling)

#### G-01 · eureka.person: table-wide INSERT/UPDATE for eureka_app with no column guard

- Module / files: db/migrations/0003_domain.sql:22-32, 118; db/migrations/0005_rls.sql:45-51; db/migrations/0042_field_encryption_work_auth.sql:203-208; apps/api/src/modules/candidates/candidates.service.ts:850, 915
- Category: Security (OWASP API3 / rule 4, rule 6, least privilege)
- Severity: Medium
- Existing implementation:
  - 0003:118 `GRANT SELECT, INSERT, UPDATE ON person, candidate, submission, interview TO eureka_app;`. This was later narrowed for submission and interview (0017:68, 237) but never for person.
  - `person_update … USING (EXISTS (… authz.owns('candidate:update', …))) WITH CHECK (true)` (0005:49-51).
  - `person_insert … WITH CHECK ((SELECT authz.has_perm('candidate:create')))` (0005:47-48).
  - The only trigger on person is `person_contact_unique BEFORE UPDATE OF personal_email, phone_e164` (0260:65). 0042:203 says DOB has "no read or write path (OD-04)".
- Problem:
  - The API never UPDATEs person (grep shows only the two INSERTs in candidates.service.ts), yet eureka_app may update every column: names, phone, email, `created_at`, `dob_enc`, `dob_bidx`, `dob_year`. The same holds for INSERT.
  - Server-managed `created_at` and the encrypted DOB columns are client-settable at the DB layer, which contradicts rule 4 and OD-04.
  - Any user with `candidate:create` at any scope can insert person rows that no candidate references. Those rows are invisible to everyone (person_read needs a candidate) and cannot be cleaned up through the API. PII can be stored this way with no audit row.
- Recommended solution:
  - In a new migration: `REVOKE INSERT, UPDATE ON eureka.person FROM eureka_app; GRANT INSERT (id, first_name, last_name, phone_e164, personal_email) ON eureka.person TO eureka_app;`.
  - Add a BEFORE INSERT guard that forces `created_at := now()` and rejects dob_* for service roles.
  - Contact edits, if they are ever needed, should go through a definer function that also writes the audit row.
- Alternatives & trade-offs: Move candidate creation (person + candidate + transition) into one `authz.create_candidate` definer. This is cleaner but a larger refactor of candidates.service.ts:840-925.
- Expected benefit: Closes a DB-level write path to PII and server-managed columns, so a future API bug or injection cannot rewrite contacts or DOB.
- Complexity: S
- Regression risks: The import definer path (`authz.import_load_person`) runs as authz_definer with its own grants (0033:351), so it is unaffected. Seeds (seed-load.ts:171 writes `dob_year`) run as admin.
- Required tests: A db.int test that, as eureka_app, `UPDATE eureka.person SET personal_email=…` is denied, an INSERT with `created_at` or `dob_enc` is denied, and the candidate create flow still passes.
- Breaking API change?: no
- **Lead review:** Verified: `GRANT SELECT, INSERT, UPDATE ON person, candidate, submission, interview TO eureka_app` (0003_domain.sql:118); no later narrowing of `person`.

#### G-02 · eureka_worker can call authz.transition_candidate and can choose its own identity, so the worker can act as any user

- Module / files: db/functions/authz/transition_candidate.sql:49-50; db/functions/authz/current_user_id.sql:10-14; db/migrations/0019_review_hardening.sql:4-7; db/migrations/0006_guards.sql:164-173
- Category: Security (OWASP API5 BFLA / rule 2 "EXECUTE to exactly the needed role")
- Severity: Medium
- Existing implementation:
  - `GRANT EXECUTE ON FUNCTION authz.transition_candidate(uuid, text) TO eureka_worker;` (transition_candidate.sql:50). It is inherited from the 0006 DO-loop, which granted every authz and eureka function to app, worker, owner and definer.
  - `authz.current_user_id()` returns `current_setting('eureka.user_id')` for every session user except eureka_import (current_user_id.sql:11-14). Any role can set this custom GUC.
  - Nothing under apps/api/src/worker calls `transition_candidate` (grep finds no match).
- Problem: 0019:4-7 removed `eureka_app` from eureka_worker precisely so the worker could not "pick any user id" and act with that user's scope. Holding EXECUTE on a user-facing write definer reopens that path. A compromised worker, which parses uploaded documents and resumes and calls external services, can run `set_config('eureka.user_id', <admin>)` and then change candidate status anywhere. The over-grant was not pruned when the function moved to db/functions, because `CREATE OR REPLACE` keeps existing ACLs.
- Recommended solution:
  - `REVOKE EXECUTE ON FUNCTION authz.transition_candidate(uuid, text) FROM eureka_worker;` and delete line 50 of the function file.
  - Audit the remaining 0006 DO-loop inheritances. I checked 49 worker-executable functions; the others are read helpers that worker policies need.
- Alternatives & trade-offs: Bind identity to the role: `current_user_id()` returns NULL unless `session_user = 'eureka_app'` (or `eureka_worker` for an allowlisted set of functions). This is stronger but touches every worker policy that relies on a NULL user.
- Expected benefit: Restores the documented worker boundary. A worker compromise can no longer perform user-level writes.
- Complexity: S
- Regression risks: Low. Confirm no worker job calls it, including indirectly from jobs/*.ts.
- Required tests: A db.int test that, as eureka_worker with `eureka.user_id` set to an admin, `SELECT authz.transition_candidate(..)` raises insufficient_privilege. Add a role-ACL snapshot test (G-11).
- Breaking API change?: no
- **Lead review:** Verified: `GRANT EXECUTE ON FUNCTION authz.transition_candidate(uuid, text) TO eureka_worker` (transition_candidate.sql:50); no worker caller; contradicts 0019:4-7.

#### G-03 · Candidate writes rely on table-wide UPDATE plus denylist column guards

- Module / files: db/migrations/0003_domain.sql:118; db/migrations/0005_rls.sql:30-43; db/functions/eureka/candidate_column_guard.sql:16-80; db/migrations/0140_candidate_profile_fields.sql:84-132; apps/api/src/modules/candidates/candidates.service.ts:606-621, 764, 774
- Category: Security (OWASP API3 mass assignment at the DB layer / rule 6) / Design
- Severity: Medium
- Existing implementation:
  - eureka_app has UPDATE on every candidate column. `candidate_update` admits a row when the caller holds any of `candidate:update`, `candidate:assign`, `candidate.visibility:update` or `candidate.rating:update` (0005:30-43).
  - Which columns each permission may change is decided by two triggers that compare enumerated column lists: `candidate_column_guard` and `candidate_profile_guard`. The 0005 comment says: "the column guard (0006) decides which columns each permission may change".
- Problem:
  - Today the lists cover every column (I checked against 0003:34-55, 0026:42 and 0140:33-60). But the design fails open: a column added in a future migration and not added to a guard can be written by anyone holding only `candidate.visibility:update` or `candidate.rating:update` over the row, with no DB check.
  - The API writes a fixed set of columns (candidates.service.ts:606-611 map, `recruiter_id` 764, `technical_rating` 774), so most of the table-wide grant is unused.
  - eureka.job follows the same pattern for INSERT: table-wide `GRANT SELECT, INSERT ON eureka.job` (0060:242). Its UPDATE is column-limited (0060:243-245).
- Recommended solution:
  - `REVOKE UPDATE ON eureka.candidate FROM eureka_app; GRANT UPDATE (<the 15 API-written columns>) ON eureka.candidate TO eureka_app;`. A new column is then deny-by-default and must be granted on purpose.
  - Do the same for job INSERT, using the columns that jobs.service.ts inserts.
  - Keep the triggers for per-permission checks.
- Alternatives & trade-offs: Move all candidate edits into definer functions (the long-term rule-6 shape). This is more work, and the column guards already provide the permission split.
- Expected benefit: Fail-closed schema evolution. It removes a class of mass-assignment regressions that eureka-mass-assignment tests only catch at the API layer.
- Complexity: S
- Regression risks: Missing a column the API writes breaks that endpoint with 42501. The candidates and mass-assignment integration suites cover these paths.
- Required tests: A db.int test that an `UPDATE` of an ungranted column (e.g. `team_assigned_at`, `documents_status`) as eureka_app fails with a privilege error even for an org-scope admin. A migrate.test lint asserting no table-wide `GRANT … UPDATE ON eureka.<t> TO eureka_app`.
- Breaking API change?: no

#### G-06 · Role passwords are sent as plaintext literals in ALTER ROLE

- Module / files: apps/api/src/db/migrate.ts:204-216
- Category: Security (OWASP API8 misconfiguration)
- Severity: Low
- Existing implementation: `const lit = (await client.query("SELECT quote_literal($1) AS q", [pw])).rows[0]!.q; await client.query(\`ALTER ROLE ${role} PASSWORD ${lit}\`);` runs on every deploy.
- Problem:
  - The cleartext password appears in the statement text. If the server runs with `log_statement = 'ddl'` or `'all'`, or logs a failing statement (any error during this call), the eureka_app and eureka_worker passwords go to CloudWatch or RDS logs.
  - The first `quote_literal` round trip also sends the password as a bind parameter, which `log_statement='all'` / `log_parameter_max_length` can log too.
- Recommended solution: Compute a SCRAM-SHA-256 verifier client-side (pg's `scram` helpers or a small function using crypto.pbkdf2) and send `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$4096:…'`. Drop the `quote_literal` round trip; the verifier string is safe to format with a strict regex check.
- Alternatives & trade-offs: Use RDS IAM authentication for the app and worker roles, which removes the passwords entirely but needs infrastructure work (AWS compute is currently deleted).
- Expected benefit: DB credentials never appear in logs.
- Complexity: S
- Regression risks: The verifier format must match the server's `password_encryption = scram-sha-256` setting.
- Required tests: A unit test for verifier generation, and an integration test that the role can log in after `setRolePasswords`.
- Breaking API change?: no
