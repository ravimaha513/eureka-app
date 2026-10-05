# Interviews details, Settings & Preferences and people directories: API contract

Phase 3c package **interviews-settings**. Built in migrations `0080_interview_details.sql` and `0081_settings.sql`,
`apps/api/src/modules/interviews` (details, panel, scorecards, calendar file), `apps/api/src/modules/identity/settings.*`
(Settings), `apps/api/src/platform/client-info.ts` (login activity facts), `apps/api/src/modules/admin` (staff
directory), `apps/api/src/modules/employees` (contacts, export), the worker's inbox fan-out (preferences) and the web
screens Interviews (Create/Edit dialog, details drawer, feedback), Settings (avatar menu), Users & Access → Users and
Employees. Shared constants: `packages/shared/src/interviews.ts`, `packages/shared/src/notifications.ts`. JSON, RFC 9457
problems with the code in `detail`, CSRF header on every write.

## Interviews (IS)

| Rule | Enforcement |
|---|---|
| IS-1 An interview has a type (`phone`, `video`, `in_person`; optional, older rows have none), an optional meeting link, a panel of app users and at most one lead. | `interview.interview_type` CHECK, `interview_panelist` with partial unique index `interview_panelist_one_lead` |
| IS-2 The duration is not stored: `endsAt` stays the source of truth. Create and update accept `durationMin` (15..240 whole minutes) **instead of** `endsAt` and set `endsAt = startsAt + durationMin`; responses carry the derived `durationMin`. Sending both is 422. Older interviews longer than 240 minutes keep their end time; the Edit dialog then shows End instead of Duration. | zod (`CreateInterview`, `UpdateInterview`), the 12-hour limit of 0019 still applies |
| IS-3 Meeting links are `https://` URLs without whitespace, at most 500 characters. They are part of the interview row, so only readers of the interview (interview RLS and the API's scope predicate) ever receive them; the web app renders them only when they match `^https://\S+$`, with `rel="noopener noreferrer"`. | zod `meetingLink`, CHECK `meeting_url ~ '^https://[^[:space:]]+$'` |
| IS-4 The panel (1..10 distinct **active** app users, any role) and the lead (optional, must be a panel member) are replaced as a whole through `authz.set_interview_panel(interview, members[], lead)`. Panel membership grants nothing: a panel member who cannot read the interview still gets 404. The pickers list active staff names only (`GET /interviews/panel-options`, `interview:create`, no emails). | SECURITY DEFINER (REVOKE FROM PUBLIC, `search_path` pinned, EXECUTE to `eureka_app` only), same Sales check as the guard, advisory lock per interview; guard trigger: rows written only by `authz_definer` (or the FK cascade), `added_by`/`added_at` server-set, no UPDATE/TRUNCATE |
| IS-5 Type, meeting link, duration, panel and lead are **Sales fields** (like round, times and coach): only a Sales grant on the interview's actor snapshot changes them; location editors get 422 `field_not_permitted`. | `SALES_FIELDS` (API), `eureka.interview_guard` (0080 replaces 0017's with the two new columns in the Sales tuple), `authz.set_interview_panel` |
| IS-6 Scorecard: technical skills, communication, problem solving, attitude, 1..5 each, all four or none, on **coach** and **client** feedback only (decision: the coach's own evaluation and the client's evaluation relayed by Sales; location feedback is about logistics and conduct). Feedback stays append-only; a scorecard alone is valid feedback; the existing rating, notes and candidate feedback are unchanged. | zod `ScorecardInput` (strict), API 422 `scorecard_not_allowed`, CHECKs `interview_feedback_scorecard_complete`, `interview_feedback_scorecard_kind`, relaxed `interview_feedback_content` |
| IS-7 Calendar file: `GET /interviews/:id/calendar.ics` for readers of a **scheduled** interview (else 404 / 422 `interview_not_scheduled`). RFC 5545 VEVENT (UTC times, escaped text, lines folded at 75 octets), summary "Interview: round with candidate name", the meeting link as URL/LOCATION. **Attendees: the panel's work emails only** (lead as CHAIR); no candidate, client or recruiter address and no other email anywhere in the file. Downloads are audited (`interview.calendar_downloaded`, attendee count only). | `interviews.ics.ts`, unit-tested escaping and folding |
| IS-8 Audit: links are recorded as `set`/`cleared`, never their value; panel changes as `panelSize` and `leadId`; scorecards as numbers; notes never. | `AuditService` (+ `meeting_url` in `REDACT`) |
| IS-9 RLS: panel rows are readable wherever the interview is readable (`EXISTS` on `interview` under the caller's RLS, like `feedback_read`); the app has no INSERT/UPDATE/DELETE on them. | `panelist_read` |

### Endpoints (additions)

- `POST /api/v1/interviews` adds `interviewType?`, `meetingUrl?`, `durationMin?` (instead of `endsAt`), `panelIds?`
  (≤ 10), `leadId?` (must be in `panelIds`). 422 codes: `invalid_panel_member` (inactive or unknown user),
  `panel_too_large`, `invalid_panel`, `lead_not_in_panel` (also caught by zod first).
- `PATCH /api/v1/interviews/:id` adds `interviewType` (nullable), `meetingUrl` (nullable), `durationMin`, `panelIds`
  (replaces the panel; the current lead stays when still a member), `leadId` (needs `panelIds`; null = no lead).
  Returns the interview with `panel` and `lead`.
- `GET /api/v1/interviews` and `/:id` add `position` (the submission's job title; null when the caller cannot read the
  submission, e.g. coaches), `interviewType`, `meetingUrl`, `durationMin`; `/:id` adds
  `panel: [{ id, name, lead }]` and `lead: { id, name } | null`.
- `GET /api/v1/interviews/:id/feedback` items add `round` and `scorecard: { technicalSkills, communication,
  problemSolving, attitude } | null`. `POST` accepts `scorecard`.
- `GET /api/v1/interviews/panel-options` → `{ items: [{ id, name }] }` (active users, up to 500).
- `GET /api/v1/interviews/:id/calendar.ics` → `text/calendar` attachment.

## Settings & Preferences (ST)

| Rule | Enforcement |
|---|---|
| ST-1 Every signed-in user has Settings (avatar menu → Settings); no permission beyond a session; nothing reads or changes another user's data. | `SettingsController` names the caller in every query; RLS below |
| ST-2 Profile: display name (from Google), email and designation (changed by `designation:change` holders) and location are **read-only**. Editable: work phone (normalised to E.164 with the shared rules; country code required) and a short bio (≤ 500 characters, no control characters). Optimistic concurrency: `If-Match` carries `rowVersion` (`"0"` before the first save); 428 without it, 412 `stale` when it moved. Education, skills, certifications and resumes belong to candidate profiles and are not offered for staff. | `PUT /settings/profile` (strict zod), `eureka.staff_profile` with guard (row_version/updated_at server-set, no delete) |
| ST-3 Staff phone and bio are read by the owner and by `staff.contact:read` holders (HR, Org Admin; new permission). Users & Access → Users shows a Phone column only for them (`contactVisible`). | RLS `staff_profile_read` (InitPlan `has_org`), insert/update own row only |
| ST-4 Notifications: one in-app on/off per type of the worker's in-app registry (`NOTIFICATION_PREFERENCE_TYPES` = `INBOX_TYPES`, tested). On is the default (no row). **Mandatory** types cannot be switched off: `work_authorization.expiring` and `checklist.item_overdue` (compliance deadlines). Muting affects only the inbox row of later events; the recipients (and emails) stay as the registry decides; the `inbox_fanout` marker still counts every resolved recipient. | `notification_preference` (own rows, RLS), guard refuses `in_app = false` for mandatory types (list compared with the shared one by a test), worker filter in `outbox.ts` |
| ST-5 Login activity lists the caller's sessions of the last 30 days (newest first, at most 20; the current one first and marked): signed-in time, last seen, device class, browser family, masked IP and status (`active`, `signed_out`, `expired`). | `GET /settings/sessions`; `session` has no RLS (it is read before a user is known), so every query is limited to `user_id = caller` |
| ST-6 Stored per session, and only this: a public id (the cookie's hash never leaves the server), device class (`desktop`/`mobile`/`tablet`/`unknown`) and browser family (Chrome, Edge, Firefox, Safari, Opera, Other) parsed from the user agent at sign-in (the user agent is not stored), and the IP masked at sign-in (IPv4 first two octets `23.127.xx.xx`, IPv6 first two groups). The IP is CloudFront's `x-eureka-viewer-ip` behind the origin guard, else the socket address (X-Forwarded-For is never trusted). | `client-info.ts`, CHECKs on `session.device_class`, `browser`, `ip_masked` |
| ST-7 "Sign out" ends one other live session of the caller (404 when not theirs or already ended; 422 `current_session` for the current one: use Sign out); "Sign out of all other sessions" ends every other live one. The ended sessions' cookies stop working on the next request. Audited with the session's public id or the count. The app's UPDATE right on `session` is narrowed to `last_seen_at` and `revoked_at`. | `POST /settings/sessions/:id/revoke`, `POST /settings/sessions/revoke-others` |
| ST-8 Security shows "Signed in with Google (domain)" (`GOOGLE_HOSTED_DOMAIN`); there is no password section (Google SSO). | `signIn` in the profile and sessions responses |
| ST-9 Audit: `staff_profile.updated` `{ phoneSet, bioSet }`, `notification_preference.updated` `{ type, inApp }`, `session.revoked` / `session.revoked_others` `{ count }`; no phone, bio, IP or user agent. | `bio` added to `REDACT` as well |

### Endpoints

- `GET /api/v1/settings/profile` → `{ displayName, email, designation, location, phone, bio, rowVersion, signIn: { provider, domain } }`
- `PUT /api/v1/settings/profile` (`If-Match`) `{ phone: string|null, bio: string|null }` → profile
- `GET /api/v1/settings/notifications` → `{ items: [{ type, label, description, mandatory, inApp }] }`
- `PUT /api/v1/settings/notifications/:type` `{ inApp: boolean }` → the list; 422 for unknown types and `notification_type_mandatory`
- `GET /api/v1/settings/sessions` → `{ signIn, items: [{ id, signedInAt, lastSeenAt, device, browser, ip, current, status }] }`
- `POST /api/v1/settings/sessions/:id/revoke` → 204; `POST /api/v1/settings/sessions/revoke-others` → `{ revoked }`

## People directories (SD, EM)

| Rule | Enforcement |
|---|---|
| SD-1 Users & Access → Users shows KPI cards with the number of **active** users per role, only for roles that have users (`GET /admin/users/summary`, `access:manage`), plus the list's avatar, email and designation, and the phone where ST-3 allows it. | `AdminService.userSummary`, `listUsers` |
| EM-C1 Employees list and detail carry `contact: { email, phone, masked }`: the person's personal email and phone follow the existing candidate phone rule (design B4.6, like the marketing contacts on the profile): `candidate.phone:read` over a candidate the caller owns (HR, Associate HR, Immigration: org). Everyone else gets them masked (`a•••@example.com`, `•••-•••-43`), shown as plain text, not links. | `employeeContact` |
| EM-X1 `POST /api/v1/employees/export` (body: the list filters `status`, `locationId`, `clientId`, `endingWithinDays`, `search`; strict) for holders of `report:export` **and** `employee:read` at org scope (today: CEO). CSV with formula-injection-safe cells (the Hot List's `csvCell`), contacts masked as in the list, capped at 50 000 rows (`x-export-truncated`), 5 exports per 10 minutes per user, audited `employee.export` with row count, cap and the filter names only. | `EmployeesService.exportCsv` |

## Deviations and open product questions

- **Duration** is derived, not stored (IS-2), so a 6-hour legacy interview cannot be edited by duration.
- **Panel ≠ access:** being on a panel does not let a user read the interview, its feedback or the calendar file.
  Should panel members (e.g. a trainer from another team) get read access to the interviews they sit on?
- **Reviewer email** (shown on the reference screen) is not shown on reviewer cards; staff emails are available to all
  staff, but nothing needed it. Reviewer role = the feedback kind (Interview coach, Client (relayed)).
- **Scorecard kinds:** coach and client only (IS-6). Should location admins score too? Should a reviewer's scorecard be
  editable (feedback is append-only today)?
- **Mandatory notifications:** work-authorization expiry and overdue paperwork. Confirm the list; per-type email opt-out
  is not offered (emails follow the role).
- **Staff contacts:** `staff.contact:read` goes to HR and Org Admin (Org Admin gains no business data: the
  `engine.test.ts` invariant was updated to allow this one directory permission). Should Associate HR, managers or
  the whole staff see work phones?
- **Designation** is read-only in Settings (it is set by `designation:change` holders); there is still no API to change it.
- **Sessions:** the list covers 30 days; session rows are not pruned yet (as before). IP and device are recorded only
  for sessions created after 0081.
- The **Application status dialog** on the reference screens belongs to the jobs portal package, not here.
