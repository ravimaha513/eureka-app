# Eureka App: System Design (HLD and LLD)

Version 0.3 (revised after two independent reviews) · September 2026 · Related: Eureka App SRS v0.1, Mock screens (SRS 9.2), Implementation Plan v0.1

## How to read this document

Part A is the high-level design: goals, assumptions, architecture, technology choices, security and deployment. Part B is the low-level design: repository layout, data model, the authorization engine, APIs, flows, jobs and testing. Part C traces every SRS requirement to the design. Items marked **AS-nn** are assumptions standing in for answers to open questions in SRS section 13; each says what changes if it is wrong.

### Review history

The design was reviewed twice by an independent reviewer acting as judge. Pass 1 on v0.1 scored 6/10 (revise). Pass 2 on v0.2 scored 7/10 (approve with changes, no blockers). Version 0.3 applies the pass-2 changes (second table below).

Pass 1 findings and their resolution in v0.2:

| Finding | Resolution in v0.2 |
|---|---|
| Team scope resolved to the recruiter only; unassigned candidates invisible to leads | Teams are first-class (`team`, `team_member`); candidates carry `team_id`; scope rules rewritten (B4.3) |
| RLS trusted scope lists computed by the app; app could set an "all" flag | Only the user id is passed to the database; RLS policies compute scope from database tables through `authz` functions (B4.5) |
| Reports and many tables bypassed RLS | RLS on every table holding personal data, money or documents, default deny, CI check; no materialized views in MVP (B4.5, B7) |
| Per-table BYPASSRLS for workers is impossible | Worker role has no BYPASSRLS; explicit worker policies and grants per table (B4.5) |
| Write-side authorization undefined, mass assignment | WITH CHECK policies, protected-column triggers, per-role write schemas, dedicated endpoints for narrow grants (B4.7) |
| Grants table incomplete and inconsistent with SRS | Grants live in code and the table in B4.2 is generated from it; all 16 roles covered; deviations recorded (B4.2, B10) |
| Recruiters could not see phone numbers | `candidate.phone:read` granted at read scope to Sales and Location roles, masked for other teams' all-teams candidates (B4.6) |
| MFA and step-up not enforceable through Cognito federation | Direct Google OIDC from the BFF; step-up with `prompt=login&max_age=0` and `auth_time` check; MFA via Workspace 2-Step Verification (A6.1) |
| Cache invalidation across tasks, closure table undated | `access_version` counter checked per request; closure rebuilt in-transaction with cycle check; single active manager enforced by exclusion constraint; team snapshots on activity rows (B4.3, B2) |
| Admin self-escalation | Grants are code-reviewed, not editable at runtime; `access:manage` cannot change the holder's own roles; restricted roles need a second approver (A6.2) |
| Existence oracles from duplicate checks and errors | Security-definer duplicate check returning minimal info; generic 409/422 errors; read-before-write 404/403 rule (B3) |
| Functional gaps (vendors, checklists, bench, notifications) | Added tables, states and jobs; traceability in Part C |
| Encryption vs search | Phone stored in plain text under field policy; DOB and visa number encrypted with blind index for DOB; key scheme defined (A6.3) |
| Feedback link burned by mail scanners; CSRF not session-bound | GET renders, POST consumes; random token stored hashed; CSRF token is HMAC of session id (A6.1) |
| Over-engineering for MVP | Deferred: SQS, EventBridge per-interview schedules, materialized views, audit hash chain, blue/green, Cognito (A5, A10) |

Pass 2 findings and their resolution in v0.3:

| Finding | Resolution in v0.3 |
|---|---|
| N1: SECURITY DEFINER functions unhardened; conflict with FORCE RLS | `authz_definer` owner role (no BYPASSRLS; reads through explicit `TO authz_definer` policies, because Amazon RDS cannot grant BYPASSRLS); `search_path` pinned; EXECUTE revoked from PUBLIC; identity and org tables on the no-RLS allow-list with column-level SELECT; views use `security_invoker` (B4.8) |
| N2: RLS blocks cross-entity side-effect writes | Candidate status and bench changes only through `app.transition_candidate`, a definer function that checks the triggering permission; first-placement computed in a definer function (B4.8) |
| N3: Protected-column trigger was a partial blocklist; rating grant blocked | Allowlist trigger: every changed column must be covered by a permission on that row; location branch for rating in the UPDATE policy; activity snapshots set by trigger, never by the client (B4.8) |
| N4: Catalog gaps vs SRS | Lead `candidate:create` at team scope; `candidate:assign` at org for the Offshore Manager; new `assignment:read` for Sales at read scope; `visa:read` marked restricted; interview creation authorized against the parent submission; unused scope ranking removed |
| N5: Team membership and reporting line can disagree | Invariants enforced by trigger: recruiter must be an active member of the candidate's team; team lead's reporting line must match the team's place in the hierarchy; OD-07 records the recruiter-move rule (B4.8) |
| N6: Google step-up parameters not documented | Phase 0 spike; fallback is in-app WebAuthn step-up for restricted roles (A6.1) |
| N7: Authorization matrix generated from the catalog is tautological | Hand-written golden expectations from SRS 5 tested against the catalog (`srs-golden.test.ts`, B8) |
| N8 to N13 | Residual-risk note for injected user id; `SET LOCAL ROLE` for worker-on-behalf; separate export timeout; advisory lock on closure rebuild and wider version bumps; composite, rate-limited duplicate check; approver constraints; designation is a label only; placement location snapshot (B4.8) |

---

# Part A: High-Level Design

## A1. Goals and non-goals

**Goals**

1. Replace the four Google Sheets and the placement Google Form with one system of record for candidates, submissions, interviews, placements, paperwork, employees and payments.
2. Enforce role-based access so each user sees only the candidates, activity, fields and reports that their role and position in the hierarchy allow (SRS section 5), enforced twice: in the application and in the database.
3. Protect sensitive personal and immigration data with encryption, field masking and audit.
4. Automate the notifications in SRS 4.14.
5. Start as one deployable service a small team can run, with a clear path to split and scale.

**Non-goals for MVP**

- Candidate self-service portal (candidates only receive single-use links for feedback).
- Payroll, invoicing or accounting (Eureka records invoice and payment facts entered by Accounts).
- E-signature, job-board integrations, native mobile apps.
- Otter.ai or Google Drive API integration (links only).

## A2. Assumptions

| ID | Assumption | If wrong |
|---|---|---|
| AS-01 | ~250 internal users (≈180 Sales, ≈40 location/ops, ≈30 HR/Accounts/Immigration/leadership); peak 120 concurrent. | Above ~2,000 users, add read replicas and a connection pooler (A10). |
| AS-02 | Per year: ~3,000 new candidates, ~60,000 submissions, ~15,000 interviews, ~400 placements, ~25,000 documents (≈40 GB). | 10× still fits one Postgres primary; beyond that, partition activity tables by month. |
| AS-03 | One organization. `org_id` exists on every table for a future second brand, but is not used in policies until then. | Multi-tenant SaaS adds tenant predicates to RLS and per-tenant keys. |
| AS-04 | Google Workspace is the identity provider for all staff; 2-Step Verification is enforced by Workspace policy, with security keys for HR, Accounts, Immigration and admin organizational units. | A second IdP (Entra ID, Okta) is added behind an OIDC broker such as Cognito or Auth0 (A10). |
| AS-05 | Users are in the US (Eastern, Central) and India. Timestamps stored in UTC and shown in the user's zone; interview times also shown in EST. | None. |
| AS-06 | "Highest privilege" for location_incharge means highest **within a location**. System administration is the separate `org_admin` role, which holds no data permissions. | Grants for that role change only. |
| AS-07 | **Decided (OD-01, 2026-09-29): the Hot List is visible to every signed-in user, for now.** Every candidate in a Hot List status (active, on hold, full of interviews, confirmation, bench, stopped) is listed for everyone; phone numbers are masked unless the viewer owns the candidate, DOB is always masked. Candidate profiles, updates, submissions, interviews and placements stay scoped as before. The previous rule (team hierarchy and coaches, plus **Open to all teams** candidates for Sales roles while Active or Full of Interviews) is kept behind one switch, `HOTLIST_VISIBILITY = "team"` in the catalog, enforced in both the engine (`hotlistVisible`) and RLS (`candidate_hotlist_read`, migration 0010). | Flip the switch and deploy. |
| AS-08 | Candidate and employee are one `person` with role-specific child records. A placement creates an assignment, not a new person. | Data model split. |
| AS-09 | Paperwork, payroll, E-Verify, offer-letter and 1099 companies are one `legal_entity` list with type flags. | Split lists. |
| AS-10 | **Partly decided (OD-02):** incentives grow with the number of placements, and the manager sets a custom amount; the exact formula is TBD. MVP records placements, the manager-entered amount and payment status; no formula is computed. | Incentive engine once the formula is fixed (Phase 4). |
| AS-11 | Availability 99.5% in business hours of both regions; RPO 15 min; RTO 4 h. | Multi-region design. |
| AS-12 | Interview recording consent is captured outside the app; the app stores a "consent captured" flag per interview. | Block recording links without consent. |
| AS-13 | **Decided (OD-03):** candidate data is kept 3 years after last activity, then purged. A candidate with no activity for 6 months becomes inactive (off the Hot List, kept read-only). I-9 copies keep the federal minimum, which can be longer: the later of 3 years after hire or 1 year after employment ends. Audit exports are locked for 3 years. | Retention job parameters. |
| AS-14 | **Confirmed (D-01):** "any candidate" in SRS 5 (Lead, Manager, AD may log submissions) means only candidates the user can see through their own scope, including Open-to-all-teams candidates. Seeing a candidate on the open Hot List does not by itself allow logging a submission. | Grant scope widens to org for those permissions. |

## A3. System context

- **Actors:** internal staff by role; candidates (feedback links only); vendors (emails from users, no access).
- **Identity:** Google Workspace (OIDC).
- **Email:** Amazon SES.
- **Object storage:** private S3 bucket for resumes and compliance documents.
- **Otter.ai and Google Drive:** URLs on interview records.
- **Future:** accounting import, calendar invites, data warehouse.

## A4. Architecture overview

Eureka is a **modular monolith**: one API service and one worker service from the same codebase, one PostgreSQL database, and a static single-page web app.

```
 Browser (React SPA)
   │  HTTPS; session cookie (httpOnly, Secure, SameSite=Lax)
   ▼
 CloudFront + WAF ──► SPA assets (S3)
   │ /api/*
   ▼
 ALB ──► API service (NestJS on Node 22)          ──► PostgreSQL 16 (RDS Multi-AZ)
            BFF auth · RBAC · field policy               RLS on all sensitive tables
            │                                              job queue (outbox + SKIP LOCKED)
            ├──► S3 (SSE-KMS) via presigned URLs            ▲
            ▼                                               │
        Google OIDC                      Worker service ───┘ (same codebase)
                                          jobs: emails, reminders, retention, audit export
                                          └──► SES
```

Modules own their tables and expose service interfaces; no module reads another module's tables directly.

| Module | Owns | SRS |
|---|---|---|
| identity | users, sessions, role assignments | 4.1, 5 |
| org | locations, teams, team members, reporting lines, coach assignments | 4.1 |
| candidates | person, candidate, batches, resumes, notes, timeline events, sample profiles | 4.2, 4.12 |
| marketing | submissions, preferred vendors | 4.3, 4.4, 4.13 |
| interviews | interviews, feedback, feedback tokens | 4.5 |
| placements | placements, assignments, contacts | 4.6, 4.9 |
| compliance | documents, checklists, BGC, work authorization | 4.7, 4.8 |
| finance | invoices, payments | 4.10 |
| reporting | scoped report queries and exports | 4.11, 4.15 |
| notifications | rules, templates, delivery log, in-app inbox | 4.14 |
| audit | append-only audit log and access log | NFR-SEC-04 |
| files | upload/download orchestration and scan status | 4.7 |

## A5. Technology choices

The scale (hundreds of users), the access model and the need for one small team to move fast point to a single-language TypeScript stack on AWS.

| Layer | Choice | Why | Swap path |
|---|---|---|---|
| Web app | React 18, TypeScript, Vite, TanStack Router/Query/Table, Tailwind CSS, shadcn/ui (Radix) | Data-heavy grids with saved views and column pickers; accessible components; no SSR needed for an authenticated internal app | Next.js if public pages appear |
| API and worker | Node.js 22 LTS, NestJS 10 (Fastify adapter), Zod | Modules match the modular monolith; guards and interceptors fit layered authorization; one language and shared Zod schemas across web and API | Java 21 + Spring Boot fits the same design equally well; extract modules into services when needed |
| Data access | Drizzle ORM + node-postgres, SQL-first migrations | Full control of SQL, needed for scope predicates and RLS; typed queries | Kysely or raw SQL |
| Database | PostgreSQL 16 on Amazon RDS Multi-AZ | Relational integrity; Row-Level Security; `pg_trgm` and full-text search at this volume; exclusion constraints for effective dating | Aurora, read replicas, partitioning, OpenSearch for search, warehouse via CDC |
| Authentication | Direct OIDC with Google Workspace from the API acting as Backend-for-Frontend | Company SSO; step-up via `prompt=login`; `hd` domain claim available; no tokens in the browser | Cognito, Auth0 or Okta as a broker when a second IdP is needed |
| Jobs and events | Transactional outbox + a Postgres job table (`job_run`, leases and SKIP LOCKED) in the worker; pg-boss was rejected because it needs DDL rights at runtime | No extra infrastructure; exactly-once intent, at-least-once delivery; easy reschedule of interview-related jobs | SQS, then Amazon MSK, fed from the same outbox |
| Files | S3 with SSE-KMS; presigned POST into a quarantine prefix; GuardDuty Malware Protection; promotion on clean scan | Files never pass through the API; scanning before availability | Same |
| Email | Amazon SES with DKIM, SPF, DMARC | Transactional email | SendGrid or Postmark |
| Compute | ECS on Fargate (api, worker) behind an ALB; rolling deploys with circuit breaker | No servers to patch; autoscaling | EKS when many services exist |
| Edge | CloudFront + AWS WAF | Static hosting, L7 protection, rate limits | Same |
| Secrets and keys | Secrets Manager; KMS keys: `eureka-data` (RDS, S3 general), `eureka-restricted` (restricted documents), `eureka-field` (field encryption), `eureka-bidx` (blind index HMAC) | Key separation limits blast radius | Same |
| IaC and CI/CD | Terraform; separate AWS accounts for dev, staging, prod; GitHub Actions with OIDC to AWS; pnpm workspaces | Reviewable, repeatable; no long-lived cloud keys | Same |
| Observability | OpenTelemetry → CloudWatch and X-Ray; Sentry for the web app | Traces across API, worker and database | Grafana or Datadog |
| Testing | Vitest, Supertest, real PostgreSQL for integration and RLS, Playwright per role, k6, OWASP ZAP baseline | Authorization is the top risk and needs tests against the real database | Same |

## A6. Security architecture

Target: OWASP ASVS 4.0 Level 2 overall; Level 3 controls around restricted documents and access management.

### A6.1 Authentication

- **Sign-in:** OIDC Authorization Code flow with PKCE between the API (confidential client) and Google. The API validates issuer, audience, nonce, signature, expiry and the `hd` claim (company domain). The user must exist and be active in Eureka.
- **Account linking:** by Google `sub` only. Email matching is allowed once, for a pre-provisioned user with no `sub` recorded yet, and is audited.
- **Session:** server-side row (`session`); cookie `eureka_sid` holds a 256-bit random id (stored hashed); httpOnly, Secure, SameSite=Lax, Path=/. Lifetime 12 h absolute, 60 min idle. Tokens never reach the browser.
- **Step-up:** restricted actions (viewing I-9, DL or work-authorization files; approving role grants) require a fresh authentication within 15 minutes. Google's documented `prompt` values do not include `login`, and `auth_time` is not a documented Google claim, so a Phase 0 spike tests `max_age` and the returned claims. If Google cannot prove a fresh sign-in, step-up is done in the app with WebAuthn (a security key or passkey registered in Eureka by each user in HR, Accounts, Immigration and admin roles), and those roles get a 15-minute idle timeout.
- **MFA:** enforced by Google Workspace 2-Step Verification (AS-04).
- **CSRF:** SameSite cookie plus `X-CSRF-Token` header equal to HMAC-SHA256(server secret, session id), required on every state-changing request.
- **Session invalidation:** on role change, deactivation or logout; `access_version` mismatch forces re-evaluation (B4.3).
- **Candidate feedback links:** random 256-bit token, stored as SHA-256 hash, bound to one interview, 48-hour expiry. `GET` renders the form (no personal data shown beyond first name, client name and date); only `POST` consumes the token. `/api/public/*` is rate-limited per IP and token.
- **Development mode:** a development identity provider is enabled only when `AUTH_MODE=dev`; the production configuration refuses to start with it.

### A6.2 Authorization model

Every request passes three checks on the server:

1. **Permission (RBAC):** roles map to permissions (catalog in B4.1).
2. **Data scope:** each grant carries a scope (`own`, `team`, `coached`, `hierarchy`, `location`, `org`), resolved from teams, reporting lines, coach assignments and location roles.
3. **Field policy:** sensitive fields are masked or removed unless a field permission covers the record.

The database enforces rows independently with RLS policies that compute scope from its own tables (B4.5). The web app hides navigation and actions from a capability list (`GET /api/v1/me`), for presentation only.

**Governance of access:**

- Grants (role → permission → scope) are defined in code (`packages/shared/src/authz/catalog.ts`), seeded by migration, and changed only through reviewed pull requests. They are not editable at runtime.
- Role assignments (user → role, location, validity) are data, managed by `access:manage` holders in the admin screen.
- A user cannot change their own role assignments.
- Assigning a role that holds a restricted permission requires a second approver with `access:manage`.
- `org_admin` holds no data permissions.
- Every role change is audited and notifies org admins.

### A6.3 Data protection

| Class | Examples | Controls |
|---|---|---|
| Restricted | I-9, driving license, work-authorization copies, visa numbers | Separate S3 prefix and KMS key; `document.restricted:read`; step-up; every view and download audited; presigned GET TTL 5 min |
| Confidential | DOB, phone, personal email, rates, invoice amounts | Field permissions and masking; DOB and visa number encrypted in the application |
| Internal | Names, technology, status, client names | Standard RBAC scope |

**Field encryption scheme:** envelope encryption with AES-256-GCM. A data key per field class is generated by KMS (`eureka-field`) and cached in memory for up to 24 hours. The ciphertext stores the key id, IV and tag. A rotation job re-encrypts rows under the current key. Built in migration 0042 (`docs/work-authorization-api.md` FE-1 to FE-7): the field key is the `restricted` KMS key used only with the encryption context `eureka:purpose = field` (IAM condition), data key versions in `eureka.field_key`, the AAD binds table, column and row id, a local provider for development is refused in production, and the blind index key is a separate KMS HMAC key (`bidx`).

**Searchable encrypted fields:** DOB gets a blind index `dob_bidx = HMAC-SHA256(bidx key, normalized value)` for exact-match duplicate detection. Phone numbers are stored in plain text (normalized to E.164) because recruiters search and call them; they are protected by field policy, audit of exports and RLS.

TLS 1.2+ everywhere; RDS, snapshots and S3 encrypted with KMS; the database is in private subnets only.

### A6.4 Audit

- `audit_event` is append-only: the application role has INSERT only; UPDATE, DELETE and TRUNCATE are revoked.
- Each row records actor, action, entity, before/after values for changed fields (sensitive values redacted), request id and IP.
- Always logged:
  - views and downloads of restricted documents
  - reveals of DOB
  - exports
  - role changes
  - failed authorization on existing records
- A nightly job exports the previous day's rows to an S3 bucket with Object Lock (compliance mode, 3 years per OD-03) and records a SHA-256 digest of each export file. Per-row hash chaining is deferred (A10).

### A6.5 Application controls

- Zod validation on every endpoint, with per-role write schemas (B4.7).
- Headers: CSP without inline scripts, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Rate limits: WAF per IP; API per user; stricter limits on login, public and export endpoints.
- **Uploads:**
  - presigned POST with content-length-range (15 MB) and a fixed key into `quarantine/` (resumes: exact declared size, 120 s)
  - allowlisted types (PDF, DOCX, PNG, JPEG), checked after the scan by parsing the file: DOCX through the ZIP central directory (`[Content_Types].xml` and `word/document.xml` required; macros, ActiveX, macro-enabled types and external template/OLE links refused); PDF by header and names (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile(s)`, `/RichMedia`, `/XFA`, `/AA`, and `/OpenAction` unless it is a page destination), including `#xx`-escaped names and names inside Flate-compressed object streams
  - GuardDuty scan; on clean, the worker copies the file create-only to `clean/` (or `restricted/`) and marks it available; infected files are deleted, the outcome is shown on the record (status "Blocked: malware found") and an alert is logged. Emailing the uploader is an open question
  - PDF residual risk: the PDF check is a lexical scan, not a full parser. Active content behind other stream filters (LZW, ASCII85 or chained filters), in encrypted PDFs, or in malformed files a viewer repairs differently can go unseen; GuardDuty's scan is the main control and downloads are attachments opened outside the app
- Exports: `report:export`, scope-limited, capped at 50,000 rows, audited; phone masked in exports.
- CI security: Dependabot, `pnpm audit`, CodeQL, secret scanning, ECR image scanning, nightly ZAP baseline.
- Least-privilege IAM for task roles.

### A6.6 Threat model (STRIDE)

| Threat | Example | Mitigation |
|---|---|---|
| Spoofing | Stolen session cookie | httpOnly/Secure cookie, idle timeout, step-up for restricted actions, revoke on role change |
| Spoofing | Link-scanner or forwarded feedback link | GET does not consume; minimal data on form; single use on POST; rate limit |
| Tampering | Recruiter edits another team's candidate through the API | Scope check in API + RLS WITH CHECK; authorization matrix tests |
| Tampering | Mass assignment (changing `recruiter_id`, `team_id`, `visibility`) | Per-role write schemas; protected-column trigger checks permission (B4.7) |
| Tampering | SQL injection sets session settings | Only `eureka.user_id` is read by policies and set via `set_config` with bound parameters; scope is computed in the database; parameterized queries everywhere |
| Repudiation | Disputed rate change | Audit with before/after; Object Lock export |
| Information disclosure | Mass export of Hot List | Export permission, row cap, phone masking, audit, rate limit |
| Information disclosure | Existence oracle through duplicate checks or error codes | Security-definer duplicate check with minimal output; generic 409/422; 404 for out-of-scope records |
| Information disclosure | Reports bypass row security | Reports query base tables through RLS; no materialized views in MVP |
| Denial of service | Expensive queries | Statement timeout (5 s API), pagination caps, indexes on scope columns, rate limits |
| Elevation of privilege | Admin grants self restricted access | No self-assignment; second approver for restricted roles; grants in code; alerts |
| Elevation of privilege | Worker compromise reads everything | Worker role without BYPASSRLS; per-table worker policies and grants |

## A7. Asynchronous processing

- Side effects are written as `outbox_event` rows in the same transaction as the business change.
- The worker polls the outbox and the `job_run` table (leases, SKIP LOCKED). Handlers are idempotent and deduplicate on event id.
- Timed work is polled rather than scheduled one-by-one. Example: every 5 minutes, find interviews with `ends_at + 60 min <= now()` and no feedback email sent. Reschedules and cancellations need no schedule cleanup.

## A8. Deployment and environments

- AWS accounts `eureka-dev`, `eureka-staging`, `eureka-prod` under AWS Organizations; region us-east-1.
- VPC with public subnets (ALB only) and private subnets (ECS, RDS); VPC endpoints for S3, Secrets Manager, KMS, SES.
- ECS rolling deploys with the deployment circuit breaker.
- Migrations run as a one-off task before the deploy and follow expand/contract so old and new code both work.
- Backups: RDS PITR (35 days) and a daily snapshot copied to us-west-2.

## A9. Observability

- Structured JSON logs with request id and user id; no personal data in logs.
- OpenTelemetry traces.
- Dashboards for p95 latency, error rate, job backlog and failures.
- Alerts on 5xx rate, dead-lettered jobs, repeated authorization denials on existing records, failed logins and export spikes.

## A10. Scale and evolution

| Trigger | Change |
|---|---|
| Report queries affect transactional latency | Read replica for reports (RLS applies on replicas); later CDC to a warehouse with its own access model |
| Fuzzy search across resumes | OpenSearch fed from the outbox, with scope filters applied at query time |
| Job volume or many event consumers | Move queue to SQS, then MSK, fed from the same outbox |
| Module needs independent scaling | Extract it (notifications or reporting first); its tables move with it |
| Second identity provider | Put an OIDC broker (Cognito, Auth0, Okta) in front; the BFF interface is unchanged |
| Stronger tamper evidence required | Add per-row hash chain with a single-writer audit sequence |
| Second company or brand | Enable `org_id` predicates in RLS |

## A11. Non-functional requirements mapping

| NFR | Design element |
|---|---|
| NFR-SEC-01 | Google SSO with 2SV and step-up (A6.1) |
| NFR-SEC-02 | KMS, field encryption (A6.3) |
| NFR-SEC-03 | Server-side RBAC + independent RLS (A6.2, B4) |
| NFR-SEC-04 | Append-only audit, Object Lock export (A6.4) |
| NFR-SEC-05 | Export permission, caps, masking, audit (A6.5) |
| NFR-CMP-01 | Retention job (B6), consent flag (AS-12) |
| NFR-PRF-01 | Indexed scope columns, pagination; p95 < 500 ms target |
| NFR-SCL-01 | Stateless API tasks, autoscaling (A8) |
| NFR-AVL-01, NFR-BKP-01 | Multi-AZ, PITR, cross-region snapshots (A8) |
| NFR-USE-01, 02 | TanStack Table grids, saved views, status badges |
| NFR-TZ-01 | UTC storage, per-user display (AS-05) |
| NFR-DQ-01 | Zod validation, constraints, enums |

---

# Part B: Low-Level Design

## B1. Repository layout

```
eureka-app/
  apps/
    api/              NestJS: HTTP entrypoint and worker entrypoint
      src/modules/<module>/   controller, service, repository, dto
      src/platform/           auth, authz guard, db (request transaction), audit, outbox, config
    web/              React SPA
  packages/
    shared/           authz catalog and engine, Zod schemas, enums, DTO types
  db/
    migrations/       ordered SQL migrations (schema, RLS, grants)
    seed/             fictional development data
  infra/              Terraform modules and environments
  docs/               design, implementation plan, ADRs
```

## B2. Data model

Every table has `id uuid` (UUIDv7), `org_id uuid`, `created_at`, `created_by`, `updated_at`, `updated_by`, and `row_version int` for optimistic concurrency. Money is `numeric(12,2)` with `currency char(3)`. Retirable records have `deleted_at`.

### B2.1 Organization and identity

| Table | Key columns and constraints |
|---|---|
| `location` | name, kind (`training`,`gh`,`office`,`remote`), state, timezone |
| `app_user` | email citext unique, display_name, designation, status, primary_location_id, google_sub unique, access_version int |
| `role` | key (16 roles, seeded from the catalog) |
| `role_permission` | role_key, permission, scope; seeded by migration from the catalog; application role has SELECT only |
| `user_role` | user_id, role_key, location_id (required for location roles, CHECK), valid tstzrange, approved_by (required for restricted roles) |
| `reporting_line` | user_id, manager_id, valid tstzrange; EXCLUDE USING gist (user_id WITH =, valid WITH &&) to allow one manager at a time; CHECK manager_id <> user_id |
| `reporting_closure` | ancestor_id, descendant_id, depth; current lines only; rebuilt by trigger on `reporting_line` in the same transaction; trigger rejects cycles |
| `team` | name, lead_id → app_user, location_id |
| `team_member` | team_id, user_id, valid tstzrange; EXCLUDE (user_id WITH =, valid WITH &&) so a recruiter is in one team at a time |
| `coach_assignment` | coach_id, team_id, valid tstzrange |
| `session` | id_hash, user_id, created_at, last_seen_at, expires_at, auth_time, access_version, revoked_at |

Triggers on `user_role`, `reporting_line`, `team_member` and `coach_assignment` increment `app_user.access_version` for affected users.

### B2.2 Candidates and marketing

| Table | Key columns and constraints |
|---|---|
| `person` | first_name, last_name, personal_email, phone_e164, dob_enc, dob_bidx, dob_year |
| `candidate` | person_id, technology_id, batch_id, team_id, recruiter_id (nullable), location_id, gh_location_id, marketing_status, visibility (`team`,`all_teams`), priority (P1–P3), marketing_email, vitel_number, marketing_start_date, marketing_locations text[], technical_rating smallint 1–5, in_person_ok, eligibility jsonb, everify_entity_id, offer_letter_entity_id, entity_1099_id, office, bench_since date; indexes (team_id), (recruiter_id), (location_id), (visibility, marketing_status), trigram on names and emails |
| `candidate_assignment_history` | candidate_id, team_id, recruiter_id, valid tstzrange (for FR-ORG-04) |
| `candidate_event` | candidate_id, type, at, actor_id, ref_type, ref_id, summary (timeline for FR-CAN-10) |
| `technology` | name unique, active |
| `batch` | location_id, technology_id, start_month, size_planned, status |
| `resume` | candidate_id, file_id, version, is_current (partial unique on candidate_id where is_current) |
| `candidate_note` | candidate_id, body, author_id |
| `sample_profile` | technology_id, team_id, recruiter_id, file_id, title (placeholder until SRS 4.12 is defined) |
| `submission` | candidate_id, recruiter_id, team_id (snapshot), lead_id, manager_id, ad_id (snapshots), location_id (candidate's at time), submitted_at, job_title, client_id, implementation_partner_id, vendor_id, rate, rate_type, status, rejection_reason; index (candidate_id, client_id, submitted_at) |
| `client`, `vendor`, `implementation_partner` | name unique, contacts jsonb |
| `preferred_vendor` | submitted_by, company, contact_name, email, phone, technologies text[], notes, status |

Built in migration 0026 (2026-10-01), candidate extras:

| Rule | Enforcement |
|---|---|
| `batch` (location, technology, start month, size, status `planned`/`in_training`/`completed`/`cancelled`; unique per location, technology and month) is readable by every `candidate:read` holder and created only by Sales leadership: `candidate:create` at team, hierarchy or org scope (`canCreateBatch`; a recruiter's `own` grant does not qualify) | RLS; `authz.create_batch` (definer); the app has no INSERT; a write guard refuses any other writer and every UPDATE/DELETE (no status change endpoint yet) |
| `candidate.batch_id` is a profile field (`candidate:update`) and must be a planned or in-training batch at the candidate's location | column guard (0026 replaces 0013's); trigger `candidate_batch_check`; API 422 `batch_not_allowed` |
| `candidate_event` (id, candidate_id, type, at, actor_id, ref_type, ref_id, from_value, to_value) is append-only and written only by definer triggers on `candidate` (created, status, visibility, rating, assignment, batch), `submission` (created, status), `interview` (scheduled, call status, cleared) and `placement` (created, status). Values are state identifiers only (CHECK `^[a-z0-9_]{1,40}$`): no names, contacts, rates or reasons; the design's free-text `summary` is replaced by `from_value`/`to_value` | triggers; write guard; app has SELECT only |
| Timeline read: the candidate must be readable (`EXISTS` by primary key under candidate RLS); events about a submission, interview or placement also need that record readable (D-02: a teammate does not see another recruiter's submissions on the timeline) | policy `candidate_event_read`; the API applies the same rule with the engine |
| Duplicate check (FR-CAN-09, N11): name plus email or phone; matches normalized personal or marketing email (lower-case) and E.164 phone (country code required, nothing guessed) against every candidate; returns at most three rows of owning team name, team lead as contact and which supplied identifier matched; the candidate id only when the caller can read it | `authz.candidate_duplicates` (definer, `candidate:create` holders); API rate limit 20/min/user with a warning log, audited without values; `POST /candidates` answers 409 `possible_duplicate` (no details) unless `confirmDuplicate` |

Review follow-ups in migration 0032 (2026-10-01):

| Rule | Enforcement |
|---|---|
| Candidate status changes driven by a placement (create, backout, BGC failed, joined) are timeline events with `ref_type = 'placement'`, so they are listed only where that placement is readable (D-02: an Open-to-all-teams viewer from another team no longer sees the placement history) | `authz.candidate_status_by_placement` records the placement in `authz.placement_status_context` (keyed by transaction id; only `authz_definer` can read or write it, so a client cannot spoof the link the way it could a GUC) and the candidate trigger reads it |
| A viewer who reads the candidate only through Open to all teams gets no actor names and no events from before the candidate was last opened to all teams | API timeline filter (RLS keeps the coarser rule above) |
| Batches: create and status changes only for locations in the caller's scope (team locations and candidate locations of the teams their team/hierarchy `candidate:create` grant owns; every location for an org grant). Status: `planned → in_training → completed`, `planned`/`in_training → cancelled` | `authz.batch_location_ids`, `authz.create_batch` (403 `location_not_in_scope`), `authz.set_batch_status`, `PUT /batches/{id}/status`; the write guard lets the definer change `status` only |
| Duplicate check is three index lookups (personal email, marketing email, phone) and primary-key probes; about 100 ms → 5 ms on 50,000 candidates | `authz.candidate_duplicates` |
| App-role candidate inserts start from server defaults (status `in_training`, visibility `team`, no rating, no bench date, version 1; timestamps set by the server) | trigger `candidate_0_insert_guard` (rule 4); seeds running as the owner or migration user are not affected |
| Phones: a bracketed `(0)` after the country code is dropped (`+44 (0)20 …`); a bare national `0` after a trunk-prefix country code (`+91 098…`) is refused with a message instead of guessed | `normalizePhoneE164` / `phoneProblem` in `packages/shared` |

TODO (retention, OD-03): there is no purge job yet. `candidate_event` and `batch` refuse DELETE from everyone, so the retention job will need its own path: a dedicated definer function (owned by `authz_definer`, executable only by the worker) that sets a transaction-local marker the write guard checks before allowing the delete. The marker must not be a plain `set_config` GUC, which any client can set; use the same pattern as `authz.placement_status_context` (a row only the definer can write, keyed by `pg_current_xact_id()`).

Built in migration 0036 (2026-10-01), resumes (FR-CAN-07) on the A6.5 upload pipeline:

| Rule | Enforcement |
|---|---|
| `resume` (candidate_id, status `pending`/`clean`/`infected`/`failed`/`rejected`/`expired`, scan_result code, content_type PDF or DOCX, size_bytes ≤ 15 MB, sha256_hex, version, is_current, uploaded_by, created_at, upload_expires_at, scanned_at) holds the file metadata itself; the generic `file_object` waits for compliance documents. No file names are stored | table CHECKs; partial unique index: one current resume per candidate; unique (candidate_id, version) |
| Read: `document:read` covering the candidate (own/team/hierarchy/location/org, never the all-teams rule) and the candidate readable | policy `resume_read` (InitPlan scope arrays, EXISTS on candidate by primary key); API `resumeAccess` in `packages/shared` |
| Upload: `document:upload` covering the candidate; at most three pending uploads per candidate; the server sets status, uploader, timestamps and the 5-minute upload window | `authz.create_resume_upload` (definer; 404/403/422/409); guard trigger; the app has SELECT only |
| Presigned POST into the fixed key `quarantine/resumes/<id>`: bucket, exact key, exact Content-Type, `content-length-range` = declared size, 120 seconds (the database upload window, 5 minutes, is the bound the worker uses); a key holding more than `RESUME_MAX_KEY_VERSIONS` (3) versions logs an alert; the API role has no tagging rights | `S3DocumentStorage`; IAM (`app.tf`); bucket policy: only the GuardDuty role tags `quarantine/`, only the worker writes `clean/` |
| Scan and promotion by the worker (`resume-scan`, B6), polling the `GuardDutyMalwareScanStatus` tag of the exact object version (no EventBridge rule): NO_THREATS_FOUND + size and content inspection (A6.5: DOCX central directory and active content, PDF names) → copied create-only (`If-None-Match: *`, checksum compared on 412) to `clean/resumes/<id>`, next version, current; THREATS_FOUND → `infected`, version deleted; other results or no result within 60 min → `failed` (left to the 2-day quarantine expiry); bad bytes → `rejected` (`BAD_CONTENT`, `SIZE_MISMATCH`, `ACTIVE_CONTENT`); nothing uploaded → `expired` | `authz.resume_scan_queue` / `authz.resume_scan_finish` (worker only; pending rows only; clean needs the declared size and a SHA-256); a scanned row is final except losing `is_current` |
| Download: clean only, presigned GET of `clean/` for 60 s with `Content-Disposition: attachment` and a generated name (`resume-v2.pdf`) | `POST /candidates/{id}/resumes/{resumeId}/download`; audit `resume.downloaded` |
| Audit: `resume.upload_requested` (candidate id, type, size), `resume.downloaded` (candidate id, version), `resume.scanned` (status, result code; worker, no actor) | no file names or personal data |
| Local development and tests: the API serves a directory with HMAC-signed policies enforcing the same conditions; the worker uses a deterministic fake scanner (EICAR = infected); refused in production | `LocalDocumentStorage`, `LocalDocumentStore`; config checks |

Not built (need other work first): the **DOB blind index** in the duplicate check waits for OD-04 (DOB visibility). The encryption platform and the blind index helper exist (migration 0042: `person.dob_enc` must be in the envelope format and `dob_bidx` a 32-byte MAC), but nothing reads or writes DOB yet. Resume retention (OD-03) and emailing the uploader about a blocked file (today: status on the profile and an alert log) are open questions for Ravi.

### B2.3 Interviews

| Table | Key columns |
|---|---|
| `interview` | candidate_id, submission_id, recruiter_id, team_id and hierarchy snapshots, client_id, vendor_id, round, starts_at, ends_at, location_id, system_name, coach_id, invite_received bool, call_status, cleared bool, cleared_at, cleared_by, otter_url, recording_url, consent_captured, feedback_email_sent_at; index (location_id, starts_at), (team_id, starts_at) |
| `interview_feedback` | interview_id, source (`candidate`,`client`,`location_admin`,`coach`), rating, format, topics text[], difficult_questions, duration_min, next_step, submitted_at, submitted_by |
| `feedback_token` | interview_id, token_hash unique, expires_at, used_at |

### B2.4 Placements, employment, compliance, finance

| Table | Key columns |
|---|---|
| `placement` | candidate_id, submission_id, recruiter_id, location_id and hierarchy snapshots, client_id, implementation_partner_id, vendor_id, paperwork_entity_id, placement_type (`c2c`,`w2`,`1099`), rate, is_first_placement, work_mode, project_city, project_state, tentative_start, status |
| `placement_contact` | placement_id, kind (`vendor_poc`,`invoicing_poc`,`client_manager`), name, email, phone |
| `assignment` | person_id, placement_id, assignment_no, start_date, end_date, end_reason, payroll_entity_id, everify_date, onboarded_date |
| `legal_entity` | name, kinds text[] |
| `checklist_template` | kind (`paperwork`,`onboarding`), placement_type, items jsonb (doc_type, owner_role, required) |
| `checklist_item` | owner_type (`placement`,`assignment`), owner_id, doc_type, owner_role, required, status, document_id |
| `document` | candidate_id or placement_id (two nullable FKs, CHECK exactly one), doc_type, classification, file_id, status, verified_by, verified_at, expires_on |
| `file_object` | s3_key, kms_key_alias, sha256, size, mime, scan_status (`pending`,`clean`,`infected`) |
| `bgc` | placement_id unique, bgc_company, initiated_at, helped_by, education_level, employment_years, address_years, status (`not_started`,`initiated`,`in_progress`,`cleared`,`failed`), notes |
| `work_authorization` | person_id, auth_type, number_enc + number_key_id (envelope ciphertext, A6.3), valid_from, valid_to, status (`pending`,`valid`,`revoked`; expired is derived), row_version, created/updated by and at (migration 0042, `docs/work-authorization-api.md`) |
| `invoice` | placement_id, number, invoice_date, period_start, period_end, timesheet_submitted_on, hours, amount, terms_days, expected_date GENERATED (invoice_date + terms_days) |
| `payment` | invoice_id, received_date, amount |
| view `invoice_status` | derives `received`, `delayed` (expected_date < current_date and unpaid) or `pending`; nothing stored that can drift |

### B2.5 Platform tables

| Table | Purpose |
|---|---|
| `outbox_event` | id, type, aggregate_type, aggregate_id, payload jsonb (ids and states only, no PII), created_at, published_at (migration 0022; delivered and pruned by the worker, migration 0024) |
| `outbox_delivery` | event_id, user_id, status (`pending`, `sending`, `sent`, `skipped`, `in_doubt`), created_at, attempt_at, done_at: per-recipient dedupe marker of the outbox delivery job, no addresses (migration 0024) |
| `notification` | recipient_id, type, entity ref, title, body, read_at |
| `notification_delivery` | notification_id, channel, sent_at, error |
| `audit_event` | seq bigserial, at, actor_id, action, entity_type, entity_id, changes jsonb (redacted), request_id, ip |
| `saved_view` | user_id, screen, name, filters jsonb, columns jsonb |
| `idempotency_key` | key, user_id, endpoint, request_hash (SHA-256 of the canonical body), response jsonb, created_at; PK (user_id, endpoint, key); RLS: own rows only (migration 0022; placements now, payments later) |

### B2.6 State machines

**Candidate marketing status**

| From | To |
|---|---|
| `in_training` | `active` |
| `active` | `on_hold`, `stopped`, `full_of_interviews`, `confirmation` |
| `on_hold`, `full_of_interviews` | `active` |
| `confirmation` | `placed` (when the assignment starts), `active` (backout or BGC failed) |
| `placed` | `bench` (assignment ended; the team is reassigned through FR-EMP-05 and the candidate returns to the Hot List) |
| `bench` | `active` |
| any | `terminated` |

`Active/Remote` and `Active/All Teams` from the sheets become `active` with `work_mode_pref=remote` and `visibility=all_teams`.

**Submission:** `submitted → under_review → interview_requested → interview_scheduled → interview_completed → selected`. `rejected` or `withdrawn` is allowed from any non-terminal state.

Built in migration 0017 (2026-09-29): submission status changes only through the definer function `authz.transition_submission(id, to, reason)`; the application role has no UPDATE on `submission`, and a trigger refuses status changes outside the function. Steps are strictly forward (no skipping); `selected`, `rejected` and `withdrawn` are terminal. `rejected` requires a non-blank `rejection_reason` (also a table CHECK) and no other status accepts one. Every check is NULL-safe (a NULL target, id or user context is refused). Permission is `submission:update` on the actor snapshot, as the RLS update policy. `status_changed_at` and `status_changed_by` are recorded. Interviews cannot be opened on a terminal submission. Not yet done: outbox rows, and automatic `interview_scheduled` when an interview is created (`candidate_event` rows: migration 0026).

**Interview (migration 0017):**

| Rule | Enforcement |
|---|---|
| Sales grants (own, team, hierarchy on the actor snapshot) edit `round`, `starts_at`, `ends_at`, `otter_url`, `recording_url`, `coach_id`, `invite_received`, `call_status` | Trigger `interview_guard`, column grants, per-role allowlist in the API (422 `field_not_permitted`) |
| Location grants (on `interview.location_id`) edit `cleared`, `consent_captured`, `system_name`, `call_status`; `cleared_at` and `cleared_by` are set by the server | same |
| Coaches have no `interview:update`; they add feedback | catalog |
| Recording or Otter links only while `consent_captured` (AS-12) | CHECK `interview_recording_consent`; API 422 `consent_required` |
| No overlapping live interviews for one candidate, across teams | `EXCLUDE USING gist (candidate_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE call_status NOT IN ('cancelled','rescheduled','no_invite')`; API 409 `interview_conflict` without naming the other record |
| New interviews start `scheduled`, not cleared, without consent | trigger |
| `client_id` is a snapshot from the submission | snapshot trigger |

**Interview feedback:** append-only (`interview_feedback`, no UPDATE or DELETE, trigger refuses both even for the owner). `kind` is derived from the grant that covers the interview, the way interview visibility is defined in B4.4: `coach` (coached teams), `location` (location grants), `client` (Sales grants; the recruiter relays the client's feedback). `candidate` is reserved for the public token form (B5.4). Readable wherever the interview is readable.

**Placement:** `confirmed → paperwork → bgc → ready → joined`. `backout` is allowed from any state before `joined`. `bgc_failed` is allowed from any state, including after `joined` (FR-PLC-06); from `joined` it also ends the assignment.

Built in migration 0022 (2026-09-30), contract in `docs/placements-api.md` (PL-1..PL-9):

| Rule | Enforcement |
|---|---|
| Created only from a `selected` submission by a caller holding `placement:create` **and** `submission:update` on its actor snapshot, with the candidate visible for `placement:create` (incl. Open-to-all-teams) and in `active` or `full_of_interviews` | `authz.create_placement` (definer); the app has no INSERT/UPDATE/DELETE on `placement`, `placement_contact`, `assignment`, `outbox_event`; trigger `placement_write_guard` refuses any writer other than `authz_definer` (on `outbox_event`, `outbox_event_guard` since 0024 also lets the worker set published_at once and prune old published rows) |
| Snapshots (candidate, person, recruiter, team, location, client, vendor) and `is_first_placement` set by the database | same function; `is_first_placement` = no earlier placement for the person that reached `joined` or is not `backout` |
| One active placement per submission; one open (pre-join) placement per candidate | partial unique indexes; API 409 `placement_exists` |
| Forward steps one at a time; `backout` before `joined`; `bgc_failed` from any live state including `joined` (needs `placement.bgc_status:update` as well as `placement:update`); `backout`/`bgc_failed` need a reason | `authz.transition_placement` (NULL-safe); table CHECK on the reason |
| Candidate side effects: create → `confirmation`; `joined` → `placed` + new `assignment` (number per person, start = the day marked joined); `backout`/`bgc_failed` before joining → `active` (only if still in `confirmation`); `bgc_failed` after joining → assignment ended (`bgc_failed`) and candidate → `bench` | internal definer `authz.candidate_status_by_placement` (not executable by the app; authorized by the placement action, N2). Adds the edge `full_of_interviews → confirmation` for placements only |
| While a placement is open, manual candidate transitions are refused (`placement_open`) | `authz.transition_candidate` (replaced in 0022) |
| `placement.created` / `placement.state_changed` outbox rows in the same transaction (HR, Accounts, Immigration) | both functions |

Built in migration 0035 (2026-10-01): the paperwork checklist is created with the placement (B5.3, N2). `authz.checklist_template` (kind, placement type, validated items; configuration owned by `authz_definer`, no app grant) is copied into `eureka.checklist_item` (placement_id, kind, position, doc_type, owner_role, required, status `pending`) by an AFTER INSERT trigger on `placement`, inside `authz.create_placement`. Items are append-only, written only by the definer, readable wherever the placement is (EXISTS by key). Deviation from B2.4: items reference the placement directly (`placement_id` with a foreign key) instead of `owner_type`/`owner_id`; onboarding items on assignments and the document link come with Phase 3. Template content is an open question (`docs/phase2-status.md`).

Not yet done: nothing in this list. The outbox delivery job is built (migrations 0024 and 0029, B6 `outbox-delivery`); `candidate_event` rows are written by migration 0026.

## B3. API design

- REST under `/api/v1`, JSON; OpenAPI 3.1 generated from Zod schemas.
- Cursor pagination (limit ≤ 200); allow-listed filters and sort keys.
- Errors are RFC 9457 problem details.
- **Read-before-write rule:** the target is first read under the caller's read scope. Not visible → 404. Visible but the action is not permitted → 403. Constraint violations are mapped to generic 409 or 422 responses that never name another team's record.
- **Duplicate checks** (candidate by email/phone/DOB, submission to the same client within 90 days) call the security-definer function `authz.check_duplicate(...)`. It returns only "possible duplicate", the owning team's name and a contact, and every call is audited.
- `If-Match` with `row_version` on updates. `Idempotency-Key` on placement and payment creation.
- Statement timeout 5 s for API requests.
- Pipeline error codes (problem `detail`): `invalid_transition`, `rejection_reason_required`, `rejection_reason_not_allowed`, `submission_closed`, `field_not_permitted: <fields>`, `consent_required`, `kind_required`, `kind_not_permitted` (422); `interview_conflict` (409). Placement codes: `submission_not_selected`, `candidate_not_available`, `invalid_transition`, `reason_required`, `placement_open` (candidate transition) (422); `placement_exists`, `idempotency_key_reused` (409); `idempotency_key_required` (400). List cursors are opaque keyset cursors.
- `Idempotency-Key` (POST /placements): stored per (user, endpoint, key) in the same transaction as the create, with a SHA-256 of the canonical (key-order independent) body. A repeat with the same body returns the stored response; a different body gets 409. A failed request rolls back and does not consume its key.
- Read endpoints carry action hints computed by the engine (`packages/shared/src/authz/actions.ts`): `actions` on GET /candidates/{id} and on submission items, `allowedTransitions` on placements. The state machines live once in `packages/shared/src/authz/state-machines.ts`; integration tests check that every hint matches what the server does.

Core MVP endpoints:

| Method and path | Permission | Notes |
|---|---|---|
| GET /me | authenticated | user, roles, capabilities, teams, locations |
| GET /candidates, GET /candidates/{id} | candidate:read | visibility policy, field policy |
| POST /candidates | candidate:create | team defaults to caller's team |
| PATCH /candidates/{id} | candidate:update | per-role write schema |
| PUT /candidates/{id}/assignment | candidate:assign | team and recruiter change |
| PUT /candidates/{id}/visibility | candidate.visibility:update | Lead and above |
| PUT /candidates/{id}/technical-rating | candidate.rating:update | Location roles |
| GET /candidates/{id}/timeline | candidate:read | 404 unless the candidate is readable; activity events only where the activity is readable; `?cursor=&limit=` (newest first) |
| POST /candidates/duplicate-check | candidate:create | name plus email or phone; team, contact, `matchedOn`, id only if readable; rate-limited, audited |
| GET, POST /batches; PUT /batches/{id}/status | candidate:read; Sales leadership (`canCreateBatch`) for the location | list has a `canCreate` hint; `GET /candidates?batchId=` filters (not the Hot List) |
| GET /hotlist | hotlist:read | marketable statuses, saved view filters |
| GET, POST /hotlist/views; PATCH, DELETE /hotlist/views/{id} | hotlist:read | the caller's own saved filter sets only (RLS on `hotlist_view`, migration 0025); max 50 per user, names unique per user |
| POST /hotlist/bulk/status, POST /hotlist/bulk/visibility | candidate:update, candidate.visibility:update | up to 100 ids; each record goes through its single-record path (404/403/422 per record) and reports its own result; `terminated` and `confirmation` are not offered in bulk |
| POST /hotlist/export | report:export | CSV of the filtered Hot List limited to the caller's `report:export` scope, phones always masked, capped at 50,000 rows (`x-export-truncated`), 60 s timeout, 5 per user per 10 minutes, audited as `hotlist.export` (filter summary and row count only) |
| GET, POST /submissions; GET /submissions/{id}; PATCH /submissions/{id}/status | submission:* | create requires the candidate to be visible; list filters status, candidateId, recruiterId, from, to; `rate` only when `rate:read` covers the row |
| GET /interviews?from=&to=&status=&teamId=&locationId=&candidateId=&cleared=; GET /interviews/{id} | interview:read | board rows carry `editableFields` and `feedbackKinds` hints |
| POST /interviews; PATCH /interviews/{id} | interview:create, interview:update | create is authorized against the parent submission; PATCH fields depend on the grant kind (B2.6) |
| GET, POST /interviews/{id}/feedback | interview:read, interview.feedback:create | coach, location admin or client (Sales) feedback; `kind` required only when the caller holds more than one |
| GET, POST /public/feedback/{token} | token | GET renders, POST consumes |
| GET, POST /placements; GET /placements/{id}; PATCH /placements/{id}/status | placement:read, placement:create, placement:update | rate omitted without rate:read; POST needs Idempotency-Key; `bgc_failed` also needs placement.bgc_status:update |
| GET /lookups | authenticated | technologies (active), clients, vendors, implementation partners, locations, coaches; id and name only |
| GET /admin/users; PUT /admin/users/{id}/roles | access:manage | no self-change; second approver for restricted roles |

## B4. Authorization engine

### B4.1 Permission catalog

The catalog is in `packages/shared/src/authz/catalog.ts`. It defines the following.

**Scopes:** `own`, `team`, `coached`, `hierarchy`, `location`, `org`.

**Permissions:**

| Area | Permissions |
|---|---|
| Candidates | `candidate:read`, `candidate:create`, `candidate:update`, `candidate:assign`, `candidate.visibility:update`, `candidate.rating:update`, `candidate.phone:read`, `candidate.dob:read`, `hotlist:read` |
| Submissions | `submission:read`, `submission:create`, `submission:update` |
| Interviews | `interview:read`, `interview:create`, `interview:update`, `interview.feedback:create` |
| Placements | `placement:read`, `placement:create`, `placement:update`, `placement.bgc_status:update`, `rate:read` |
| Documents and compliance | `document:read`, `document:upload`, `document:verify`, `document.restricted:read`, `bgc:update`, `visa:read`, `visa:update` |
| Employees and finance | `employee:read`, `assignment:update`, `invoice:read`, `invoice:update` |
| Reports | `report:read`, `report:export`, `performance:read` |
| Vendors and teams | `vendor.preferred:create`, `vendor.preferred:read`, `team:move_member`, `designation:change` |
| Administration | `access:manage`, `audit:read` |

**Restricted permissions (second approver):** `document.restricted:read`, `candidate.dob:read`, `visa:update`.

### B4.2 Role grants (generated from the catalog)

| Role | Grants by scope |
|---|---|
| Recruiter | **own:** assignment:read, candidate:create, candidate:update, document:read, document:upload, interview.feedback:create, interview:create, interview:read, interview:update, performance:read, placement:read, placement:update, report:read, submission:read, submission:update, vendor.preferred:create<br>**team:** candidate.phone:read, candidate:read, hotlist:read, placement:create, submission:create |
| Lead (Sales) | **own:** vendor.preferred:create<br>**team:** assignment:read, candidate.phone:read, candidate.visibility:update, candidate:assign, candidate:create, candidate:read, candidate:update, document:read, document:upload, hotlist:read, interview.feedback:create, interview:create, interview:read, interview:update, performance:read, placement:create, placement:read, placement:update, report:export, report:read, submission:create, submission:read, submission:update, vendor.preferred:read |
| Manager (Sales) | **hierarchy:** assignment:read, candidate.phone:read, candidate.visibility:update, candidate:assign, candidate:create, candidate:read, candidate:update, designation:change, document:read, document:upload, hotlist:read, interview.feedback:create, interview:create, interview:read, interview:update, performance:read, placement.bgc_status:update, placement:create, placement:read, placement:update, rate:read, report:export, report:read, submission:create, submission:read, submission:update, team:move_member, vendor.preferred:read |
| Associate Director | **hierarchy:** assignment:read, candidate.phone:read, candidate.visibility:update, candidate:assign, candidate:create, candidate:read, candidate:update, designation:change, document:read, document:upload, hotlist:read, interview.feedback:create, interview:create, interview:read, interview:update, performance:read, placement.bgc_status:update, placement:create, placement:read, placement:update, rate:read, report:export, report:read, submission:create, submission:read, submission:update, team:move_member, vendor.preferred:read |
| Offshore Office Manager | **org:** assignment:read, candidate.phone:read, candidate:assign, candidate:read, designation:change, hotlist:read, interview:read, performance:read, placement:read, rate:read, report:export, report:read, submission:read, team:move_member, vendor.preferred:read |
| CEO | **org:** assignment:read, candidate:read, employee:read, hotlist:read, interview:read, invoice:read, performance:read, placement:read, rate:read, report:export, report:read, submission:read, vendor.preferred:read |
| Location Incharge | **location:** candidate.phone:read, candidate.rating:update, candidate:read, hotlist:read, interview.feedback:create, interview:read, interview:update, performance:read, placement:read, report:read, submission:read |
| Location Ops Admin | **location:** candidate.phone:read, candidate.rating:update, candidate:read, hotlist:read, interview.feedback:create, interview:read, interview:update, placement:read, report:read, submission:read |
| HR | **org:** assignment:read, assignment:update, bgc:update, candidate.dob:read, candidate.phone:read, candidate:read, document.restricted:read, document:read, document:upload, document:verify, employee:read, placement:read, report:read, visa:read |
| Associate HR | **org:** assignment:read, assignment:update, candidate.phone:read, candidate:read, document:read, document:upload, employee:read, placement:read |
| Accounts | **org:** assignment:read, assignment:update, candidate:read, document.restricted:read, document:read, employee:read, invoice:read, invoice:update, placement:read, rate:read, report:read |
| Immigration | **org:** assignment:read, candidate.dob:read, candidate.phone:read, candidate:read, document.restricted:read, document:read, document:upload, document:verify, employee:read, visa:read, visa:update |
| Interview Coach | **coached:** candidate:read, hotlist:read, interview.feedback:create, interview:read |
| Documents Team | **org:** candidate:read, document:read, document:upload, document:verify |
| BU Head | **org:** assignment:read, employee:read, placement:read, report:read |
| Org Admin | **org:** access:manage, audit:read |

Notes:

- Recruiters see their whole team's candidates and Hot List, but read and update only their own submissions, interviews and placements (SRS 5). They can log a submission or placement for any candidate they can see, including Open-to-all-teams candidates (SRS "any Hotlist candidate").
- Leads, Managers and ADs log activity for any candidate visible through their own scope, including Open-to-all-teams candidates, but not candidates seen only on the open Hot List (AS-14, D-01 confirmed).
- Offshore Manager and CEO are read-only on Sales data at org scope. The CEO also sees employees and invoices; neither sees restricted documents or DOB.

### B4.3 Scope resolution

Input, loaded once per request from current rows:

- the user's roles (with location ids)
- teams the user belongs to or leads
- subordinate users (reporting closure)
- teams led by the user or subordinates
- coached teams

For each grant the user holds for the permission:

| Scope | Adds |
|---|---|
| own | recruiter ids: {user} |
| team | recruiter ids: {user}; team ids: user's teams |
| coached | team ids: coached teams |
| hierarchy | recruiter ids: {user} ∪ subordinates; team ids: user's teams ∪ teams led within the subtree |
| location | location ids: grant's location |
| org | all |

The all-teams flag is set when a Sales role grants `candidate:read`, `hotlist:read`, `submission:create` or `placement:create`. No grant means deny.

**Staleness:** each session stores the `access_version` it was evaluated with; every request compares it with `app_user.access_version` (one indexed read) and reloads access data on mismatch. There is no time-based cache.

### B4.4 Visibility rules per entity

| Entity | Visible when |
|---|---|
| Candidate | all; or recruiter_id ∈ recruiter ids; or team_id ∈ team ids; or location_id ∈ location ids; or (all-teams flag and visibility = all_teams and status ∈ {active, full_of_interviews}) |
| Submission, interview, placement | all; or recruiter_id (actor) ∈ recruiter ids; or team_id snapshot ∈ team ids; or location_id ∈ location ids; or the candidate is visible through ownership (not through the all-teams rule). The team that owns a candidate therefore sees other teams' activity on it, while all-teams viewers see only their own activity. |
| Interview location scope | `interview.location_id` (where the candidate interviews) |
| Documents, BGC, work authorization | document:read scope over the owning candidate or placement; restricted classification additionally needs `document.restricted:read` |
| Employees, assignments | employee:read (org-scoped roles only) |
| Invoices, payments | invoice:read |
| Preferred vendors | submitter, or `vendor.preferred:read` holders whose hierarchy contains the submitter (superiors only, FR-VEN-02) |

These rules are implemented in `packages/shared/src/authz/engine.ts` and unit-tested.

### B4.5 Database enforcement (RLS)

**Principles:**

- The API opens a transaction per request and calls `SELECT set_config('eureka.user_id', $1, true)` with a bound parameter. No other scope data is passed to the database.
- Policies call `STABLE SECURITY DEFINER` functions in schema `authz`, owned by a role that is not the application role. The functions compute scope from `user_role`, `role_permission`, `team_member`, `reporting_closure` and `coach_assignment`. Each function is wrapped as `(SELECT authz.team_ids('candidate:read'))` so it is evaluated once per statement, not per row.
- The application role `eureka_app` owns no tables, has no BYPASSRLS, and gets only the table and column privileges it needs.
- RLS is ENABLED and FORCED on every table holding personal data, money or documents, including:
  - person, candidate, candidate_note, candidate_event, resume
  - submission, interview, interview_feedback
  - placement, placement_contact, assignment
  - document, file_object, bgc, work_authorization
  - invoice, payment
  - preferred_vendor, saved_view, notification
- The default is deny: a table with RLS and no matching policy returns no rows.
- A CI test fails if any table outside an allow-list of reference tables (location, technology, client and similar) lacks `relrowsecurity` and `relforcerowsecurity`.

**Example (candidate):**

```sql
CREATE POLICY candidate_read ON candidate FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('candidate:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:read')))
  OR team_id      = ANY ((SELECT authz.team_ids('candidate:read')))
  OR location_id  = ANY ((SELECT authz.location_ids('candidate:read')))
  OR ((SELECT authz.all_teams('candidate:read'))
      AND visibility = 'all_teams' AND marketing_status IN ('active','full_of_interviews'))
);

CREATE POLICY candidate_update ON candidate FOR UPDATE TO eureka_app
  USING (
    recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:update')))
    OR team_id = ANY ((SELECT authz.team_ids('candidate:update')))
    OR (SELECT authz.has_org('candidate:update')))
  WITH CHECK (
    recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:update')))
    OR team_id = ANY ((SELECT authz.team_ids('candidate:update')))
    OR (SELECT authz.has_org('candidate:update')));
```

**Worker role:** `eureka_worker` has no BYPASSRLS and is a member of `eureka_app` only `WITH INHERIT FALSE, SET TRUE`. It can switch role to act for a user, but gains none of the app's privileges by default (a gap found by the integration tests). It has its own policies (`TO eureka_worker`) and column grants limited to what each job reads. For example, the feedback-email job reads interview id, times and candidate first name and email, and writes `feedback_email_sent_at`. When a job acts for a user (for example a scheduled export), it sets that user's id and runs under the user's policies.

**Reports:** report queries run against base tables (or `security_invoker` views) under the caller's RLS. Materialized views are not used in MVP because RLS does not apply to them.

**Open Hot List (OD-01).** Base-table RLS does not change with the Hot List switch. The open Hot List is served by one SECURITY DEFINER function, `authz.hotlist_page(...)` (migration 0011), which returns only list columns for active users, masks the phone in SQL unless the caller owns the candidate for `candidate.phone:read`, returns the technical rating only for candidates the caller can read, and never returns DOB or email. Each page read is audited (`hotlist.read`) and limited to 60 pages per user per minute. The switch lives in `authz.policy_setting` (seeded from the catalog, CHECK-constrained, not writable by the app); the API logs an error at startup if code and database disagree.

### B4.6 Field policy

| Field | Rule |
|---|---|
| person.phone_e164 | Shown with `candidate.phone:read` when the candidate is visible through ownership; masked (last two digits) when visible only through the all-teams rule, and in exports |
| person.dob | Only with `candidate.dob:read`; otherwise `•• / •• / YYYY`; each reveal audited |
| placement.rate, invoice amounts | Omitted without `rate:read` or `invoice:read` |
| work_authorization.number | Only with `visa:read` |
| document download URL | Restricted documents need `document.restricted:read` and step-up |

### B4.7 Write-side controls

- Per-role Zod write schemas define which fields each role may send (e.g., recruiters cannot send `team_id`, `recruiter_id`, `visibility`, `technical_rating`). Unknown fields are rejected, not ignored.
- Narrow grants use dedicated endpoints (`/assignment`, `/visibility`, `/technical-rating`, `/work-authorization`).
- A `BEFORE UPDATE` trigger on `candidate` rejects changes to protected columns unless the corresponding permission holds in the database:
  - `team_id` and `recruiter_id`: `authz.has_perm('candidate:assign')`
  - `visibility`: `candidate.visibility:update`
  - `technical_rating`: `candidate.rating:update`
- INSERT and UPDATE policies have WITH CHECK clauses so a row cannot be moved out of the caller's scope.

### B4.8 Database hardening details

**Function ownership and hardening (N1).**
- A NOLOGIN role `authz_definer` owns schema `authz` and every function in it; no other role has CREATE on that schema. It does **not** have BYPASSRLS: the RDS master user is not a superuser and cannot grant it. Instead, migration 0009 adds explicit policies `TO authz_definer` (SELECT on candidate, submission and interview; UPDATE on candidate for `authz.transition_candidate`), and column grants limit what it can change. CI proves migrations apply as a plain CREATEROLE user, the same privileges RDS gives its master user.
- Every function declares `SET search_path = pg_catalog, pg_temp` and uses fully qualified names.
- `REVOKE ALL ON FUNCTION … FROM PUBLIC`; EXECUTE is granted only to `eureka_app` and `eureka_worker`.
- Identity and org tables (`app_user`, `user_role`, `role_permission`, `team`, `team_member`, `reporting_line`, `reporting_closure`, `coach_assignment`, `session`, `location` and other reference lists) are on the RLS allow-list. The application role has SELECT only on the columns it needs, and writes go only through admin endpoints that check `access:manage`. This avoids recursion when the `authz` functions read them.
- All views, including `invoice_status` and report views, are declared `WITH (security_invoker = true)`.
- Integration tests call each definer function as `eureka_app`.

**Cross-entity writes (N2).**
- `candidate.marketing_status` and `candidate.bench_since` are protected columns. They change only through `app.transition_candidate(candidate_id, event, ref_id)`, a definer function that:
  - checks the permission of the triggering action on the referenced row (for example `placement:create` on the placement, `assignment:update` on the assignment)
  - validates the transition
  - writes the `candidate_event`
- First-placement detection runs in a definer function that reads assignment history without exposing it.
- Checklist items and timeline events are inserted by definer functions tied to the triggering action.

**Column allowlist trigger (N3).**
- A `BEFORE UPDATE` trigger on each protected table compares every column with `IS DISTINCT FROM`. Each changed column must be covered by a permission the caller holds on that row:

| Columns | Permission |
|---|---|
| Profile fields | `candidate:update` |
| `technical_rating` | `candidate.rating:update` |
| `team_id`, `recruiter_id` | `candidate:assign` |
| `visibility` | `candidate.visibility:update` |
| `location_id`, `person_id`, `org_id` | never changeable from the API |

- The candidate UPDATE policy includes a location branch for `candidate.rating:update`; the trigger stops that branch from touching other columns.
- A `BEFORE INSERT` trigger fills the snapshot columns on submission, interview and placement (team, lead, manager, AD, location) from the actor's current `team_member` and closure rows and rejects any value the client supplies.
- Interview creation is authorized against the parent submission: the caller must be able to update that submission.

**Team invariants (N5).**
- A trigger enforces that `candidate.recruiter_id`, when set, is an active member of `candidate.team_id`.
- A trigger on `team` and `reporting_line` enforces that a team's lead reports within the hierarchy that owns the team.
- `team:move_member` applies OD-07 in the same transaction: the mover's candidates stay with the old team and are reassigned to the chosen recruiter (default: the old team's lead).

**Minor items (N8 to N13).**
- **Residual risk (N8):** an injected `set_config('eureka.user_id', …)` would impersonate another user at the database layer. The residual risk is accepted. It is mitigated by parameterized queries everywhere, CodeQL SQL-injection rules, and a lint rule forbidding raw SQL outside `db/` and `authz`. A signed actor token checked by `authz_definer` is the Phase 4 option.
- **Worker on behalf of a user (N9):** the worker runs `SET LOCAL ROLE eureka_app` plus `eureka.user_id`.
- **Timeouts (N9):** exports and org-wide reports use a separate 60-second statement timeout.
- **Job queue (N9):** the `pgboss` schema is on the allow-list and reachable only by the worker.
- **Closure rebuild (N10):** serialized with `pg_advisory_xact_lock`. The `access_version` bump covers the moved user, all ancestors of the old and new positions, and the leads and coaches of affected teams.
- **Duplicate check (N11):** requires name plus email or phone, is rate-limited per user, and alerts on high volume.
- **Approvals (N12):** `user_role` has `CHECK (approved_by <> user_id AND approved_by <> created_by)`. `app_user.designation` is a display label and never maps to a role.
- **Placement location (N13):** placements carry a `location_id` snapshot.

## B5. Key flows

1. **Login:**
   1. `GET /api/auth/login` redirects to Google with state, nonce, PKCE and `hd`.
   2. Google returns the user to `GET /api/auth/callback`.
   3. The API exchanges the code and validates the ID token. It links the user by `sub`, creates a session, sets the cookie and redirects to `/`.
   4. An unknown or inactive user gets 403, which is audited.
2. **Hot List:**
   1. `GET /api/v1/hotlist?technology=…` validates the session and access_version.
   2. The API resolves the scope, then opens a transaction and sets `eureka.user_id`.
   3. The query applies the scope predicate (the engine) while RLS applies independently.
   4. The field policy is applied, and the response returns a cursor.
3. **Create placement:**
   1. Validate the request, apply the read-before-write rule and check `placement:create`.
   2. In one transaction:
      - insert the placement and contacts
      - set candidate status to `confirmation`
      - create checklist items from the template for the placement type
      - write a `candidate_event` and outbox `placement.created`
   3. The worker notifies the Lead, Manager, HR, Accounts and Immigration.
4. **Interview feedback:**
   1. The worker polls for interviews due for a feedback email.
   2. It creates a token and sends the email.
   3. The candidate opens the form (GET) and submits (POST).
   4. The API inserts `interview_feedback` and notifies the recruiter and coach.
5. **Restricted document download:**
   1. Read under scope.
   2. Check `document.restricted:read` and `auth_time` (step-up), and confirm `scan_status = clean`.
   3. Audit `document.viewed`.
   4. Return a presigned GET URL (5 min).
6. **Project exit (FR-EMP-03 to 05):**
   1. HR or Accounts records the end date and reason on the assignment.
   2. The candidate moves to `bench`.
   3. The outbox notifies admin teams, the BU and the CEO.
   4. A Manager assigns a team (`candidate:assign`). This notifies the new Lead and Manager and returns the candidate to the Hot List.

## B6. Jobs (worker)

| Job | Frequency | Action | SRS |
|---|---|---|---|
| feedback-email | every 5 min | Email feedback link 60 min after interview end | FR-INT-05, FR-NTF-01 |
| candidate-unresponsive | daily | Warn candidate after N days without response (configurable) | FR-NTF-02 |
| documents-pending | daily | Remind assigned Documents Team member | FR-VIS-04, FR-NTF-03 |
| paperwork-pending | daily | Remind TL, recruiter, manager | FR-NTF-04 |
| bench-time | daily | Notify POC, TL, recruiter, manager, CEO when bench > N days | FR-NTF-05 |
| recruiter-target | weekly | Notify recruiters below target, TL, manager | FR-NTF-06, FR-PRF-04 |
| first-payment | on `payment.created` | Notify recruiter, TL, manager on first payment for a placement | FR-PAY-05, FR-NTF-07 |
| payment-delay | daily | Notify recruiter and TL for delayed invoices | FR-PAY-06, FR-NTF-08 |
| project-exit | on `assignment.ended` | Notify admin teams, BU, CEO | FR-EMP-04, FR-NTF-09 |
| team-assigned | on `candidate.assigned` | Notify new Lead and Manager | FR-EMP-05, FR-NTF-10 |
| visa-expiry | daily 06:00 America/New_York | 90/60/30-day notices to HR and Immigration (`WORK_AUTH_EXPIRY_NOTICE_DAYS`): `authz.work_auth_expiry_notices` inserts one `work_authorization.expiring` outbox row per valid record at the smallest threshold reached (ids, dates and day counts only), deduplicated in `work_authorization_notice`; delivered by the notification jobs (migration 0042, `docs/work-authorization-api.md`) | FR-VIS-03, FR-NTF-11 |
| retention | nightly | Purge per AS-13 | NFR-CMP-01 |
| audit-export | daily 03:30 America/New_York (run key = UTC day exported; due days = every day since the first exported day with no `audit_export` row, oldest first, max 7 per tick; alert log when more than one day behind) | Previous UTC day of `audit_event`, paged on the (at, seq) index and streamed through gzip + SHA-256 with a size cap, as gzip JSON Lines to `audit/YYYY/MM/DD/audit-events.jsonl.gz` in the Object Lock bucket (create-only `If-None-Match: *`, x-amz-checksum-sha256, bucket-default SSE-KMS; on 412 the stored object's checksum must match); SHA-256, row count and seq range appended to `audit_export` (worker: SELECT/INSERT only, triggers block UPDATE/DELETE). One runner per key via a lease in `job_run` (`lease_until`, renewed while running, fenced on `attempts`); failures back off exponentially (`next_attempt_at`, capped, alert after repeated failures); the database sets run timestamps, rejects future run keys and requires the ledger row before a day is marked succeeded (migrations 0016, 0020; a table instead of pg-boss so the worker needs no DDL) | NFR-SEC-04 |
| outbox-delivery | every tick (run key = event id; up to `OUTBOX_BATCH_SIZE` unpublished events per tick, oldest first, events in backoff skipped) | Emails `placement.created` / `placement.state_changed` to every active user holding `hr`, `accounts` or `immigration` (role valid now), one email per user per event even with several roles. Recipients are fixed at the first run (`outbox_delivery` rows); before each send the user must still be active and hold the role (else `skipped`). Each row is marked `sending` (committed) before the provider call and `sent` after; a provider rejection (SES 4xx, `MailRejected`) goes back to `pending` and the event is retried with backoff; throttling (429, rate or sending-paused errors) is not counted, other rejections are (`rejections`), and after `OUTBOX_MAX_REJECTIONS` (default 5) the row is `failed` (final, alert). Any other error (5xx, timeout, abort, network), or a row still `sending` for longer than the runner lease when a later run starts (crash after send), becomes `in_doubt` and is never resent (at most once per recipient, alert log); a younger `sending` row may belong to a live runner after a lease takeover and is left alone (the run retries), and a final update that matches no row is logged as an alert. An event with no recipient at all stays unpublished and alerts (retried with backoff). The event is marked published when every row is final. `OUTBOX_DELIVER_SINCE` (backlog cut-off for the first enable): unpublished events created before it are marked published without sending, logged with a count. Emails carry only the event, statuses, the placement id and a sign-in link (`APP_PUBLIC_ORIGIN`); SES in production, a local directory in development (`OUTBOX_MAIL_MODE`). Worker: SELECT, UPDATE (published_at), DELETE on `outbox_event`; a trigger allows only published_at NULL→now() and only for the worker; `outbox_delivery` rows cannot be updated out of a final state, deleted (except by the cascade of their pruned event) or truncated by anyone, owner and superuser included (migrations 0024, 0029) | FR-NTF (placements, PL-7) |
| outbox-prune | daily 04:00 America/New_York | Deletes events published more than `OUTBOX_RETENTION_DAYS` (default 30) days ago, with their delivery rows; the database refuses deleting unpublished rows or rows published less than 7 days ago. Also deletes succeeded `outbox-delivery` `job_run` rows (one per event) finished that long ago, through the definer function `eureka.prune_outbox_job_runs` (the worker still has no DELETE on `job_run`; a trigger refuses every other `job_run` delete or truncate). Safe because delivery is deduplicated by `published_at` and `outbox_delivery`, not by `job_run` | — |
| idempotency-cleanup | daily 04:15 America/New_York | Deletes `idempotency_key` rows older than 24 hours (index on created_at); the worker cannot read stored responses | B3 |
| key-rotation | monthly, 1st 05:00 America/New_York (run key = UTC month) | Re-encrypt fields under the current data key: one new data key per class and month (`authz.field_key_rotate`), rows in id-ordered batches, compare-and-swap to the newest key only (`authz.field_rotation_apply`); counts only in job_run (migration 0042) | A6.3 |
| resume-scan | every tick (run key = resume id, only once its outcome is known) | Polls up to 50 pending uploads for the GuardDuty `GuardDutyMalwareScanStatus` tag on the exact object version (ListObjectVersions limited to `quarantine/resumes/`); clean → size and content inspection (A6.5), create-only write of `clean/resumes/<id>`, `authz.resume_scan_finish` (version, current), delete the quarantine version; infected → recorded, version deleted, alert log; other results, no result after `RESUME_SCAN_TIMEOUT_MINUTES` (60) or no upload `RESUME_UPLOAD_GRACE_MINUTES` (10) after the 5-minute window → `failed` / `expired`. Audited `resume.scanned`; more than `RESUME_MAX_KEY_VERSIONS` versions under one key logs an alert. Local mode: fake scanner (migration 0036) | FR-CAN-07, A6.5 |

## B7. Reporting

- Reports are parameterized SQL over base tables under the caller's RLS, grouped by date, recruiter, team, location and technology.
- Activity rows carry team and hierarchy snapshots, so reports attribute work to the team at the time (FR-ORG-04).
- Exports stream CSV under the same scope, mask phone numbers, are capped at 50,000 rows and are audited.
- Materialized views or a warehouse are added only when measured load requires it (A10).
- Role dashboards (activity counts and "needs attention") follow the same rule: `docs/dashboards-api.md`.

## B8. Testing strategy

Tests are written with each feature.

| Level | What | Tooling | Gate |
|---|---|---|---|
| Unit | Catalog integrity, scope resolution, visibility rules, field policy, state machines, date math | Vitest | Every PR; ≥ 90% line coverage of `packages/shared/src/authz` |
| Integration | Repositories and services against real PostgreSQL with migrations | Vitest + Postgres (local cluster or CI service container) | Every PR |
| RLS | Policies with the app role; **differential tests** that run queries with the application predicate removed and confirm RLS alone returns the same rows; WITH CHECK and protected-column trigger tests; worker role tests | Vitest + Postgres | Every PR |
| RLS coverage | Every non-reference table has RLS enabled and forced | SQL assertion in CI | Every PR |
| SRS golden expectations | Hand-written from SRS 5 (role × record position × action), tested against the catalog; deviations listed with D-xx references | Vitest | Every PR |
| Authorization matrix | Generated from the catalog: every role × endpoint × record position (own, teammate, other team, all-teams, other location) → expected status and masked fields | Vitest + Supertest | Every PR |
| Mass assignment | Each role sends forbidden fields → 422 | Vitest + Supertest | Every PR |
| API contract | OpenAPI snapshot and breaking-change diff | openapi-diff | Every PR |
| End-to-end | Per-role journeys: recruiter logs submission, lead sees team, location admin clears an interview, HR opens a restricted document with step-up | Playwright | Nightly, pre-release |
| Security | ZAP baseline, dependency, secret and image scans, CodeQL | CI | Every PR / nightly |
| Performance | Hot List and interview board p95 < 500 ms at 120 concurrent users, 50k candidates | k6 | Pre-release |

## B9. Data migration from sheets

1. Export each sheet to CSV.
2. Normalize:
   - technology names to the standard list
   - statuses, mapping row colors per the answer to SRS Q6
   - dates, detecting DD/MM vs MM/DD per row and sending ambiguous values to a review list
3. Match people across sheets:
   1. by marketing email
   2. then by phone
   3. then by name + DOB blind index
   4. anything unresolved goes to a review queue
4. Load to staging, reconcile counts per sheet, get sign-off, then load production.
5. Keep the sheets read-only in parallel for two weeks.

Built in migrations 0028 and 0033, `apps/api/src/import/` and `/api/v1/imports` (usage, mapping
file, review reasons and safeguards in `docs/import.md`): staging and review tables readable only
by the `eureka_import` role; a configurable column/status mapping whose SRS Q6 entries are
placeholders (unmapped or unconfirmed labels go to review); review decisions and sign-off by
signed-in org admins (a second person approves; the approval is bound to a digest of the rows and
expires); each person loads through `authz.import_load_person`, which acts as the row's owner
under the same policies, guards, transitions and audit as the API; a ledger of keyed hashes and
natural keys makes re-runs idempotent.

## B10. Deviations and open decisions

| ID | Item | Owner |
|---|---|---|
| D-01 | SRS "Lead/Manager/AD can add for any candidate" implemented as any candidate visible to them (AS-14) | **Confirmed 2026-09-29** |
| D-02 | Recruiters see teammates' candidates but only their own submissions, interviews and placements (matches SRS 5 rows) | Confirm |
| OD-01 | Hot List rule (AS-07) | **Decided 2026-09-29:** visible to everyone for now; switchable |
| OD-02 | Incentive formula (AS-10) | **Partly decided:** placement-count based, manager-set custom amount; formula TBD (CEO, Accounts) |
| OD-03 | Retention periods (AS-13) | **Decided 2026-09-29:** 3 years; inactive after 6 months without activity; I-9 federal minimum applies |
| OD-04 | Whether Sales roles may see DOB (currently no) | HR, Legal |
| OD-05 | Candidate-unresponsive threshold, bench threshold, recruiter targets | Sales leadership |
| OD-06 | Definition of "sample profile" (SRS 4.12) | Sales leadership |
| OD-07 | When a recruiter moves team, their candidates stay with the old team and are **reassigned to a new recruiter** in the same transaction. The person making the move picks the new recruiter (a member of the old team); if none is picked, the old team's lead gets them. | **Decided 2026-09-29** |

---

# Part C: Requirements traceability

| SRS requirement | Design |
|---|---|
| FR-ORG-01, 02 | B2.1 location, team, reporting_line, closure |
| FR-ORG-03 | `team:move_member`, `designation:change` (B4.2) |
| FR-ORG-04 | Effective-dated team membership; snapshots on activity rows (B2) |
| FR-ORG-05 | Reference tables (technology, client, vendor, legal_entity, location) |
| FR-ORG-06 | `app_user.status`, sessions revoked on deactivation |
| FR-CAN-01, 05, 06 | `person`, `candidate` columns (B2.2) |
| FR-CAN-02 | `batch` |
| FR-CAN-03 | `candidate.rating:update`, `/technical-rating` |
| FR-CAN-04 | `in_person_ok`, `eligibility jsonb` |
| FR-CAN-07 | `resume` with `is_current` |
| FR-CAN-08 | Visibility rules (B4.4), RLS (B4.5) |
| FR-CAN-09 | `authz.check_duplicate` with email, phone, DOB blind index (B3) |
| FR-CAN-10 | `candidate_event` timeline |
| FR-HOT-01 to 07 | `/hotlist`, saved views, visibility and field policy, exports (B3, B4) |
| FR-SUB-01 to 06 | `submission`, state machine, 90-day duplicate warning (B2.2, B2.6, B3) |
| FR-INT-01 to 10 | `interview` (invite_received, cleared, links, location, system_name), feedback, conflict check on (candidate_id, starts_at overlap), jobs (B2.3, B6) |
| FR-PLC-01 to 07 | `placement`, first-placement detection from assignment history, bgc_failed transition, numeric rate (B2.4, B2.6) |
| FR-BGC-01 to 03, FR-PPR-01 to 03 | `bgc`, `document`, `checklist_template`, `checklist_item`, `placement_contact` |
| FR-VIS-01 to 04 | `work_authorization`, visa-expiry and documents-pending jobs |
| FR-EMP-01 to 09 | `assignment`, project exit flow, onboarding checklist, joinings/exits reports (B5.6, B7) |
| FR-PAY-01 to 06 | `invoice`, `payment`, `invoice_status` view, payment jobs |
| FR-PRF-01 to 04 | Performance reports under scope; recruiter-target job |
| FR-SMP-01 | `sample_profile` placeholder (OD-06) |
| FR-VEN-01 to 03 | `preferred_vendor`, superiors-only rule (B4.4) |
| FR-NTF-01 to 11 | Jobs and events (B6) |
| FR-RPT-01 to 11 | Scoped report queries and exports (B7) |
| NFRs | A11 |
