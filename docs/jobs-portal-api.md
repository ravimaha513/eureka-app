# Jobs, applicant portal and applications (jobs-portal package)

Migrations `0060_jobs.sql`, `0061_applicant_portal.sql`, `0062_applications.sql`. Code: `apps/api/src/modules/jobs`,
`modules/applications`, `modules/portal`, `platform/mail.ts`, `platform/portal-session.service.ts`; shared rules in
`packages/shared/src/jobs.ts`; web `apps/web/src/jobs`, `apps/web/src/portal`. Rule IDs (JP-n) are referenced from code and tests.

## Product decisions (owner, 2026-10-05) and how they were built

- A job is a **client requirement** (opening at a client; `client_id`; recruiters submit candidates to it; `submission.job_id` is optional)
  or an **internal opening** (position at one of the group's companies; `company_id uuid` has **no foreign key yet**, marked
  `-- TODO(jobs-portal): FK to eureka.company added at integration` in 0060; the company name is `null` in API output until then).
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

## Applicant portal (JP-10..JP-16)

Routes under `/api/portal/*` only.

| Route | Rule |
|---|---|
| `POST /auth/sign-up` | JP-10: first name, last name, E.164 phone, email. **202** with a fixed message for new, existing, unverified and unknown emails alike; the mail is sent after the answer, not awaited. An unverified applicant's name and phone are replaced; a verified account is untouched. |
| `POST /auth/request-link` | JP-11: same generic 202 whether or not the email has an account |
| `POST /auth/verify` | JP-12: body `{ token }` (`<link id>.<secret>`); the web page reads it from the link's **fragment**, removes it from the address bar and posts it only on "Continue" (mail scanners that open links cannot burn it). 204 + cookie, or 400 `link_invalid` (same for malformed, wrong, used, expired). |
| `POST /auth/sign-out` | ends the caller's session |
| `GET /me` | the applicant (own row) and the CSRF token |
| `GET /jobs`, `GET /jobs/:id` | JP-22/23: published open internal openings (list: short plain excerpt; detail: rich text); no hiring manager or owner |
| `POST /jobs/:id/apply` | JP-24: no body; 201 `{ id }`; 409 `already_applied`; 404 not published/draft/client requirement; 422 `job_not_open` |
| `GET /applications`, `GET /applications/:id` | JP-25: own applications; detail with interviews (type, round, slot, duration, status, meeting link while scheduled) |
| `POST /applications/:id/withdraw` | JP-26: applied..offered; cancels scheduled interviews |
| `GET /dev/mailbox?to=` | development only: 404 unless `AUTH_MODE=dev` and the dev mail port outside production |

Links (JP-13): 256-bit secret; only its SHA-256 is stored; **single use, 15 minutes** (the database caps the TTL at 30); redeeming one link
burns the applicant's other open links; the stored hash is compared in constant time (`timingSafeEqual`, against a dummy hash when no link is open).
Rate limits: per email 5 requests / 15 minutes in memory per task and, in the database, at most 5 links per applicant per hour (shared by all
tasks); per client address 20 sign-up/link requests and 30 verifications per 15 minutes (429). The client address is the CloudFront-set
`x-eureka-viewer-ip` when the origin guard is on (same rule as the public feedback form). Every response to sign-up and link requests is the same
whichever case applies.

Sessions (JP-14): separate table `applicant_session`, cookie `eureka_portal_sid`, **path `/api/portal`**, `HttpOnly`, `SameSite=Strict`, `Secure` in
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

Overall rating = mean of all scorecard averages of the application. Audit rows and outbox payloads hold ids and codes only; comments and notes are never audited.
Notification (JP-31): `application.received` (ids only) from `authz.application_apply` → in-app inbox for HR and the job's hiring manager (no email), entity `application`;
`notification_entity` and `notification_recipients` were replaced carrying every earlier branch over (docs/notifications.md updated).

## Web

Sidebar section **Hiring**: Jobs (`job:read`), Applications (`application:read`, `job:read` or `interview:read`: hiring managers and interviewers see theirs), Applicants (`applicant:read`).
Portal: `/portal/sign-up`, `/portal/sign-in`, `/portal/verify`, `/portal/jobs` (Finding Job), `/portal/applications` (My Applications with Withdraw and interview details).

## Open questions

- Date of birth at sign-up was requested "if collected": it is not, because the `dob` class has no read/write path (OD-04). Collecting it needs the encrypt-at-write path, the
  `dob` class in the KMS `api_field_classes`, and a decision on who may read it.
- Company display name and FK: `company_id` has no FK and the name is `null` until the companies migration (0054) is integrated.
- Interviews of applications are separate from the sales `interview` table (different people, no client); is a unified calendar wanted (interviews-settings package)?
- Should the careers portal be on its own hostname (cookie isolation is by path today)?
- Email notices to applicants say only the status; wording and the sender name need approval. Applicant timezone is not collected (emails show UTC).
- Applicants have no profile edit or resume upload yet (the documents pipeline is the natural fit).
