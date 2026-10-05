# Jobs, applicant portal and applications (jobs-portal package)

Migrations `0060_jobs.sql`, `0061_applicant_portal.sql`, `0062_applications.sql`. Code: `apps/api/src/modules/jobs`,
`modules/applications`, `modules/portal`, `platform/mail.ts`, `platform/portal-session.service.ts`; shared rules in
`packages/shared/src/jobs.ts`; web `apps/web/src/jobs`, `apps/web/src/portal`. Rule IDs (JP-n) are referenced from code and tests.

## Product decisions (owner, 2026-10-05) and how they were built

- A job is a **client requirement** (opening at a client; `client_id`; recruiters submit candidates to it; `submission.job_id` is optional)
  or an **internal opening** (position at one of the group's companies; `company_id` is a foreign key to `eureka.company(id)`,
  `ON DELETE RESTRICT`, in 0060; see "Companies" below).
- Only internal openings can be `published_to_portal` (DB CHECK). The portal shows published openings in status `open`.
- Applicants are not `app_user` rows; no passwords, no Google: one-time email links.
- Date of birth is **not collected** (deviation, see Open questions): the `dob` field class has no read or write path yet (OD-04).

## Permissions (catalog block `// jobs-portal`)

| Permission | Roles and scope |
|---|---|
| `job:read` | recruiter `team`; lead `team`; manager, associate director `hierarchy`; offshore manager, CEO `org`; HR `org` |
| `job:manage` | lead `team`; manager, associate director `hierarchy`; HR `org` |
| `applicant:read`, `application:read`, `application:manage` | HR `org` |
| `applicant.phone:read` | HR `org` (org-sensitive: HR was already a restricted role) |

Decisions (JP-1, JP-2): Sales roles read client requirements at their scope over the job's owner (creator) and the creator's team
(snapshot, set by the database); leads and managers manage client requirements of their teams; recruiters read only. HR manages internal
openings org-wide and cannot see client requirements. Non-org job grants are held by Sales roles only (catalog test), which the RLS
policies rely on. The **hiring manager** of a job can always read it, and manage its applications (`application:manage` is HR, or the job's
hiring manager for their jobs). An interviewer (lead or panel) can read the application and its job and file a scorecard (JP-18, JP-29).
Client-requirement pay is a rate: shown to managers of the job and `rate:read` holders, otherwise `payHidden: true`.

## Jobs API (`/api/v1/jobs`)

| Route | Rule |
|---|---|
| `GET /` | JP-1: `job:read`; RLS decides rows; `kind`, `status`, `clientId`, `search`, `mine`, keyset `cursor`; `{ items, nextCursor }` |
| `GET /options` | `job:manage`: creatable kinds, clients, staff for the hiring-manager picker |
| `GET /company-options` | JP-31: `job:manage` and the caller may create internal openings (HR; 403 otherwise): `{ companies: [{ id, name }] }`, active companies, all locations |
| `GET /:id` | RLS: 404 when not readable (also for the hiring manager and reviewers) |
| `POST /` | JP-2: `job:manage` and the kind must be creatable by the caller (403 otherwise); optional `Idempotency-Key`; strict body |
| `PATCH /:id` | JP-3: read-before-write (404/403); `If-Match` rowVersion (428 without, 412 stale); `kind`, owner, team never change |

Server-managed (trigger): `owner_id`, `team_id` (the creator's team, client requirements only), `row_version`, timestamps, `posted_at`
(first time open). Jobs are never deleted (close them). Audit rows carry ids and codes only (no title, pay, text).

### Rich text (JP-4)

`requirements` and `description` are a document tree, never HTML: `{ blocks: [{type:"p", runs}|{type:"ul"|"ol", items}] }`, runs
`{ text, marks?: ["b","i","u","s"], href? }`. The zod schema (`RichDocSchema`) is the allow-list and runs on the server: no other
element, attribute or style can be represented, links must be absolute `https` URLs without credentials or whitespace, control
characters are refused, limits 200 blocks / 20,000 characters. The web view renders React elements (no `dangerouslySetInnerHTML`), the
editor builds its DOM from text nodes and allow-listed elements and converts it back through an allow-list walker (paste is plain text).

### Submissions (JP-8)

`POST /api/v1/submissions` accepts optional `jobId`. A definer trigger (0060) accepts only a job the caller can read that is an **open client
requirement of the same client**; errors `job_not_found`, `job_client_mismatch`, `job_not_open` (422). The Log submission dialog has a job
picker (open client requirements the user can read) that fills title and client.

## Companies (JP-31..JP-33; migrations 0054, 0060, 0062; `docs/facilities-api.md`)

`eureka.job.company_id` (internal openings only; client requirements keep `company_id NULL`, CHECK) references `eureka.company` with
`ON DELETE RESTRICT` (companies are never deleted, 0054 guard). `eureka.company` stays RLS-scoped to `company:read` holders (location
scope) and nobody in the jobs module gets table access or wider policies. Instead three narrow SECURITY DEFINER functions (pinned
`search_path`, `REVOKE FROM PUBLIC`, EXECUTE to one role each) expose the **name and nothing else** (no address, incharges, utilities,
bills, notes or status):

| Function | EXECUTE | Returns | Who gets what |
|---|---|---|---|
| `authz.job_company_names(p_jobs uuid[])` (0062) | `eureka_app` | `(job_id, name)` for the requested jobs (max 500) the caller can read, internal openings only | JP-32: HR (`job:read` org, non-Sales); the job's hiring manager; an interviewer (lead or panel) of an application to the job. Same rules as the `job_read` / `job_read_reviewer` policies, re-checked inside; a job the caller cannot read is absent. Used for job and application lists, details and the applications CSV (one batch call per page, never per row and never from a policy). Sales readers read client requirements only, which have no company. |
| `authz.portal_job_company_names(p_jobs uuid[])` (0062) | `eureka_portal` | same | Applicants: published, open internal openings and the jobs of their own applications (as `job_portal_read`); portal `employer` is this name. |
| `authz.company_options()` (0060) | `eureka_app` | `(id, name)` of active companies | JP-33: callers with `job:manage` at org scope from a non-Sales role (HR), all locations. Behind `GET /api/v1/jobs/company-options` (403 for anyone who cannot create internal openings). Feeds the Company picker of the job dialog (internal openings only; an inactive current company stays selectable by name). |

Attaching a company is `companyId` on `POST`/`PATCH /api/v1/jobs` (internal openings, HR); an unknown id is 422 `invalid_company`.
Whoever reads a job sees the company's name there even without `company:read`; they still cannot open the company
(`/api/v1/companies/*` follows `company:read`). The dev seed attaches its internal openings to Eureka Info Tech and Endeavour Technology.

## Applicant portal (JP-10..JP-16)

Routes under `/api/portal/*` only.

| Route | Rule |
|---|---|
| `POST /auth/sign-up` | JP-10: first name, last name, E.164 phone, email. **202** with a fixed message for new, existing, unverified and unknown emails alike; the mail is sent after the answer, not awaited. An unverified applicant's name and phone are replaced; a verified account is untouched. |
| `POST /auth/request-link` | JP-11: same generic 202 whether or not the email has an account |
| `POST /auth/verify` | JP-12: body `{ token }` (`<link id>.<secret>`); the web page reads it from the link's **fragment**, removes it from the address bar and posts it only on "Continue" (mail scanners that open links cannot burn it). 204 + cookie, or 400 `link_invalid` (same for malformed, wrong, used, expired). |
| `POST /auth/sign-out`, `POST /auth/sign-out-all` | end the caller's session / every session of the applicant (disabling an applicant revokes theirs too) |
| `GET /me` | the applicant (own row) and the CSRF token |
| `GET /jobs`, `GET /jobs/:id` | JP-22/23: published open internal openings (list: short plain excerpt; detail: rich text); no hiring manager or owner |
| `POST /jobs/:id/apply` | JP-24: no body; 201 `{ id }`; 409 `already_applied`; 404 not published/draft/client requirement; 422 `job_not_open` |
| `GET /applications`, `GET /applications/:id` | JP-25: own applications; detail with interviews (type, round, slot, duration, status, meeting link while scheduled) |
| `POST /applications/:id/withdraw` | JP-26: applied..offered; cancels scheduled interviews |
| `GET /dev/mailbox?to=` | development only: 404 unless `AUTH_MODE=dev` and the dev mail port outside production |

Links (JP-13): 256-bit secret; only its SHA-256 is stored; **single use, 15 minutes** (the database caps the TTL at 30); redeeming one link
burns the applicant's other open links; the stored hash is compared in constant time (`timingSafeEqual`, against a dummy hash when no link is open).
Sign-up and link requests are answered **before** any work: the reply is the same fixed 202 whatever the account state, and the database call and the mail
run afterwards (so latency cannot tell known from unknown addresses). The mail contains **no text the requester chose** (fixed greeting "Hello,", never the
typed name) because it goes to an unverified address. An existing applicant row is never overwritten by a sign-up: what a sign-up submitted travels on the
link it issued and is applied, to an *unverified* row only, when that link is redeemed (the mailbox owner confirms it).

Limits (JP-13b): per client address in memory per task (20 sign-up/link requests, 30 verifications per 15 minutes; IPv6 keyed by its /64; the map is hard-capped
with oldest-first eviction); everything per email or global is **database-backed and shared by all tasks, counted only for links actually issued**, so asking
for somebody else's link cannot lock them out: one link per 60 s and 10 per hour per applicant, and database-wide hourly caps of 600 links and 200 new
accounts (`eureka.portal_throttle`, definer-only). Infra: the existing WAF rule `login-rate-limit` (100 requests / 5 minutes per IP) now also covers `/api/portal/auth/`, so the web ACL stays at the 5 rules of the CloudFront flat-rate Free plan. Worker job `portal-prune-unverified` (daily 04:45 New York)
deletes applicants who never confirmed their mailbox after 30 days (no application, no open link); only counts are logged. CAPTCHA/proof-of-work on sign-up is an
open question (not built).

Sessions (JP-14): separate table `applicant_session`, cookie `eureka_portal_sid` (`__Secure-eureka_portal_sid` in production; `__Host-` needs Path=/, which would widen the scope), **path `/api/portal`**, `HttpOnly`, `SameSite=Strict`, `Secure` in
production; idle 60 min and absolute 12 h (`PORTAL_SESSION_IDLE_MINUTES`, `PORTAL_SESSION_HOURS`). The auth guard: portal routes take only the portal
cookie (a staff cookie, even renamed, is not an applicant session) and reject staff sessions with 401; staff routes never read the portal cookie, and
any non-portal handler under `/api/portal` is refused. Unauthenticated portal writes need the `x-eureka-portal: 1` header; authenticated writes need the
applicant CSRF token (HMAC bound to the session, domain-separated from staff tokens).

Database (JP-15): applicant rows are not `app_user`. Role `eureka_portal` (NOLOGIN, no memberships, no BYPASSRLS): `eureka_app` may `SET LOCAL ROLE` to it but
does not inherit it. A portal request runs under it with only `eureka.applicant_id` set; its policies limit every row to that applicant (own applicant row, own
applications, their interviews' public columns, published open jobs and the jobs they applied to). It has no grant on staff tables, on login links or on
sessions, and column grants hide internal columns (`status` of applicants, `candidate_id`, `lead_user_id`, hiring manager, owner). Writes are definer functions
(`authz.portal_*`, `application_apply`, `application_withdraw`) re-checking the applicant; a guard trigger refuses every other writer. The portal role may insert its own
audit rows (ids only).

Email (JP-16): `platform/mail.ts` is the port (the worker keeps its own transports for staff mail). `PORTAL_MAIL_MODE=dev` keeps messages in memory (and logs them
only when `NODE_ENV=development`); `ses` sends from `PORTAL_FROM_EMAIL`. **Production refuses to start** without `PORTAL_MAIL_MODE=ses` and a sender.
The link is never logged in production (the SES path logs nothing of the message, and the dev mailbox is unreachable there). Infra: `portal_from_email` in `env.hcl`
(required by the API task definition), an SES email identity, and an IAM `ses:SendEmail` permission scoped to that identity and `ses:FromAddress`. This replaces the
API role's earlier unused "any address at the domain" SES grant. The web app serves `/portal/*` from the same CloudFront distribution (SPA rewrite); the portal is a
separate minimal shell with its own Light/Dark switch.

### Production prerequisites (applicant mail)

1. A **verified SES domain identity with DKIM** (and SPF/DMARC alignment) for the sender's domain, out of the SES sandbox, so mail to arbitrary applicants is delivered.
2. `portal_from_email` set in `infra/live/<env>/env.hcl` (an address at that verified domain; Terraform creates the email identity and scopes the API task's `ses:SendEmail` to it).
   The API refuses to start in production without `PORTAL_MAIL_MODE=ses` and `PORTAL_FROM_EMAIL`.
3. The CloudFront origin secret and viewer-IP function are in place (the per-IP limits trust `x-eureka-viewer-ip` only behind them).

## Applications (staff)

State machine (JP-20, `applicationTransitionAllowed`, mirrored by `authz.application_transition_ok`): `applied → shortlisted → interview_scheduled → offered → hired`,
forward steps may be skipped, `rejected` from any open state, `withdrawn` only by the applicant; `hired`, `rejected`, `withdrawn` are final. Hiring or rejecting cancels future
scheduled interviews.

| Route | Rule |
|---|---|
| `GET /api/v1/applications` | JP-17: filters `status`, `jobId`, `search`; RLS: HR all, hiring manager their jobs', interviewer those they interview for |
| `POST /applications/export` | JP-19: `application:read`; CSV (formula-neutralised, no phone), capped at 5,000 rows, audited, 10 exports per 10 minutes |
| `GET /applications/:id` | JP-18: application + job + applicant + interviews with scorecards + history (internal comments visible to staff only) |
| `POST /applications/:id/status` | JP-20: `{ to, comment? }`, `If-Match` rowVersion; emails the applicant ("status is now …"), **never the comment** |
| `POST /applications/:id/interviews` | JP-27: type phone/video/in_person, round, lead user, panel (≤10), slot, duration, meeting link **https only**; moves applied/shortlisted to interview_scheduled; emails the applicant |
| `POST /application-interviews/:id/status` | JP-28: completed / cancelled / no_show |
| `PUT /application-interviews/:id/scorecard` | JP-29: the caller's own scorecard (technical, communication, problemSolving, attitude 1–5, notes); lead, panel or a manager of the application |
| `POST /applications/:id/candidate` | JP-30: hired only, `candidate:create`; reuses `CandidatesService.create` (team rules, duplicate check, `409 possible_duplicate` unless `confirmDuplicate`) and links the application in the same transaction |
| `GET /api/v1/applicants`, `POST /applicants/export` | JP-21: `applicant:read`; the phone needs `applicant.phone:read` (masked otherwise); export audited |

Interviewer access (JP-18b): an interviewer (lead or panel member) reads the application only while the interview is **scheduled or completed** and the
application is not final (hired, rejected, withdrawn). A manager can change the lead and replace the panel of a scheduled interview
(`PUT /application-interviews/:id/people`, definer re-checks manage); removed people lose access at once. Ids of lead, panel, additions and removals go to the audit.
Scorecards need a started (or completed) interview (`interview_not_started`). Applicant contact data follows the applicant permissions, not the job: **email and phone are
masked for everyone without `applicant:read` / `applicant.phone:read`**, and *Create candidate* copies the phone only for callers who hold
`applicant.phone:read` (otherwise the candidate is created without a phone). The link function requires `candidate:create` and only accepts a candidate created in the
same transaction and not linked to another application. The client of a job is locked once any submission answers it and may be set only by callers who can see clients
(the lookups rule).

Accepted (rationale): `GET /jobs/options` lists active staff (id and display name) to any `job:manage` holder for the hiring-manager and interview pickers: names only, the
same data the app's lookups already expose, and filtering by "holds a role at the job's scope" would hide legitimate cross-team interviewers.

Overall rating = mean of all scorecard averages of the application. Audit rows and outbox payloads hold ids and codes only; comments and notes are never audited.
Notification (JP-31): `application.received` (ids only) from `authz.application_apply` → in-app inbox for HR and the job's hiring manager (no email), entity `application`;
`notification_entity` and `notification_recipients` were replaced carrying every earlier branch over (docs/notifications.md updated).

## Web

Sidebar section **Hiring**: Jobs (`job:read`), Applications (`application:read`, `job:read` or `interview:read`: hiring managers and interviewers see theirs), Applicants (`applicant:read`).
Portal: `/portal/sign-up`, `/portal/sign-in`, `/portal/verify`, `/portal/jobs` (Finding Job), `/portal/applications` (My Applications with Withdraw and interview details).

## Open questions

- Date of birth at sign-up was requested "if collected": it is not, because the `dob` class has no read/write path (OD-04). Collecting it needs the encrypt-at-write path, the
  `dob` class in the KMS `api_field_classes`, and a decision on who may read it.
- Should HR (org-wide for internal openings) be limited to the companies of certain locations? Built: all active companies are offered.
- Interviews of applications are separate from the sales `interview` table (different people, no client); is a unified calendar wanted (interviews-settings package)?
- Should the careers portal be on its own hostname (cookie isolation is by path today)?
- Email notices to applicants say only the status; wording and the sender name need approval. Applicant timezone is not collected (emails show UTC).
- Applicants have no profile edit or resume upload yet (the documents pipeline is the natural fit).
