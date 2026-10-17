# Interview alerts, contracts, support calendar and staff birthdays: API contract

Package **interview-alerts** (2026-10-15, owner request). Built in migrations `0086_contracts.sql`,
`0087_staff_birthdays.sql`, `0088_calendar.sql`, `0089_interview_alerts.sql` and `0090_calendar_freebusy.sql`;
`apps/api/src/modules/{contracts,calendar,staff}`, the settings profile (`identity/settings.*`), the worker's
`notify-types.ts` (three event types and the delivery-time detail hook), `worker/jobs/birthdays.ts`; web: Interviews
(support calendar card, block / release in the drawer, opened from the inbox), Placements (Contracts section), Settings
(birthday), the HR screen **Staff birthdays**. Shared constants: `packages/shared/src/{contracts,birthdays}.ts`,
`notifications.ts`, `documents.ts` (MSA, PO, SOW types), the catalog (role `interview_coordinator`, permissions
`calendar:block`, `staff.birthday:manage`). JSON, RFC 9457 problems with the code in `detail`, CSRF header on every write.
Tests: `apps/api/test/alerts.int.test.ts`. Recipients and payload shapes are also in `docs/notifications.md`.

## Interview request alerts (IA)

| Rule | Enforcement |
|---|---|
| IA-1 The **interview coordinators** are the holders of the new role `interview_coordinator` ("Interview Coordinator (Support)"): `interview:read` at org scope (with the candidate's name on each interview through `authz.interview_candidate_name`, 0141; `candidate:read` was dropped with the team-scoped Hot List, `docs/candidates-api.md`), `calendar:block` at org scope, chat and DataHub like everyone. No Sales writes, no documents, no rates, no restricted data; not a restricted role (one admin grants it). | catalog, `engine.test.ts` invariants |
| IA-2 Creating an interview, moving its slot (`startsAt`/`endsAt`) or cancelling it (`callStatus = cancelled`) records one `interview.requested` outbox event (`change`: `created`, `rescheduled`, `cancelled`). Interviews whose start is already in the past (imported history, late edits) record nothing. Payload: ids, the change code and the New York date (rule 5). | AFTER trigger `interview_notice` → `authz.interview_notice()` (authz_definer), fires on INSERT and on UPDATE OF `starts_at`, `ends_at`, `call_status` only (the worker's feedback mark never fires it) |
| IA-3 Delivery: email **and** inbox to every active coordinator. **Owner decision 2026-10-15:** the email carries the full interview details, **including the candidate's email address** (marketing email, else personal email), candidate name, technology, client, position, round, type, slot (New York time plus the UTC instant for offshore readers), meeting link, recruiter, coach, panel, team, location and call status. The details are read by the worker at send time through `authz.interview_notice_details(event)` (SECURITY DEFINER, worker EXECUTE); nothing of them is stored in the outbox row, the inbox row or `job_run`. | `EVENT_SPECS["interview.requested"].details`, `renderEmail(..., details)` |
| IA-4 The inbox row stays ids-only ("Interview requested / rescheduled / cancelled. Open the interview for the details.") and opens the interview on the Interviews board (`entity.type = "interview"`, new in the inbox and the notification entity check). | `authz.notification_entity`, `App.tsx` `openEntity`, `InterviewsPage initialOpenId` |
| IA-5 Coordinators can switch the inbox entry off in Settings like other non-mandatory types; the email follows the role. | `NOTIFICATION_PREFERENCE_TYPES` |

Deviation from `docs/notifications.md` "Content rule": this is the first type whose **email** names a person and a contact
detail. The payload / inbox rule is unchanged; the producers' no-personal-data test excludes this type and
`alerts.int.test.ts` asserts the email content instead.

## Contracts (CT)

| Rule | Enforcement |
|---|---|
| CT-1 A **contract** is the commercial record of a closure on a placement: `kind` (`msa`, `po`, `sow`, `other`), `title` (≤ 120), optional `reference` (PO / MSA number, ≤ 80), optional `startsOn` / `endsOn` (end ≥ start), optional `notes` (≤ 2000, free text for Accounts and HR). Append-only in this version (no edit or delete). | `eureka.contract`, CHECKs, guard trigger |
| CT-2 Who may add: the placement must be visible under the placement read rule (else 404) and the caller must hold `placement:update` over its actor snapshot (recruiter / lead / manager / AD of the placement) **or** `invoice:update` at org scope (Accounts), else 403. Not on a `backout` or `bgc_failed` placement (422 `placement_closed`). Only through `authz.create_contract`. | SECURITY DEFINER, read-before-write (rule 6); `ContractsService.canAdd` mirrors it for the button |
| CT-3 Who reads: everyone who can read the placement (`contract_read`: EXISTS by primary key under the caller's placement policy). Notes are returned to those readers; they never reach audit or outbox rows. | RLS |
| CT-4 Adding a contract records `contract.created` (ids, the kind code, a count) and alerts **HR, Associate HR and Accounts**, email + inbox; the inbox entry opens the placement, where the MSA / PO / SOW files and the rest of the closure live. | `authz.create_contract` → outbox; resolver 0089; `whyLine` "a member of Associate HR" |
| CT-5 The closure documents are **placement documents** of the new types `msa`, `purchase_order`, `sow` (classification internal: readable and uploadable under the placement document rules, HR / Accounts / Associate HR included). No new pipeline. | `authz.document_type`, `DOCUMENT_TYPES` |
| CT-6 Audit `contract.created`: placement id, kind, dates and whether a reference / notes were given; never the title, reference or notes (added to `REDACT`). | `AuditService` |

### Endpoints

- `GET /api/v1/placements/:id/contracts` (`placement:read`) → `{ items: [{ id, placementId, kind, title, reference, startsOn, endsOn, notes, createdAt, createdBy: { id, name } }], canAdd }`, newest first; 404 outside the caller's scope.
- `POST /api/v1/placements/:id/contracts` (`placement:read`; the database decides, CT-2) body `{ kind, title, reference?, startsOn?, endsOn?, notes? }` (strict) → 201 the contract; 403 / 404 / 422 `placement_closed`.

## Staff birthdays and the CEO digest (BD)

| Rule | Enforcement |
|---|---|
| BD-1 A staff birthday is a **month and day** (`birth_month`, `birth_day` on `staff_profile`; 29 February allowed), never a year, so no age is stored. Staff set their own in Settings → Profile (`birthday` in `PUT /settings/profile`; omitted = unchanged, `null` = cleared; the `If-Match` rules of ST-2 apply). | CHECK `staff_profile_birthday`, 0081 own-row policies |
| BD-2 HR (`staff.birthday:manage`, org, new permission; "Add birthdays of all HRs and the offshore team") sets or clears anyone's through `authz.set_staff_birthday`; the **Staff birthdays** screen (nav section Admin) lists every active staff member with roles, location and birthday, filterable, with "only without a birthday". Reading uses the 0081 policy (own row or `staff.contact:read`, which HR holds). | SECURITY DEFINER, `GET /staff/birthdays`, `PUT /staff/:id/birthday` |
| BD-3 The worker job `birthday-digest` (daily 08:00 America/New_York) calls `authz.emit_birthdays(day)`: when at least one active staff member has a birthday that day, one `staff.birthdays_today` event (the day, user ids, a count), once per day through the notification ledger; 29 February birthdays are included on 28 February in non-leap years; a future day is refused. | `worker/jobs/birthdays.ts`, ledger key = the date |
| BD-4 Recipients: the **CEO** (role holders), email + inbox. The names are read at send time through `authz.birthday_names(event)` (staff display names, not candidate data) and go into **both** the email and the inbox body ("Birthdays today: …"); the inbox entry (`entity.type = "digest"`) opens nothing. | `EVENT_SPECS["staff.birthdays_today"]` with `detailsInInbox` |
| BD-5 Audit: `staff_profile.updated` gains `birthdaySet` when the birthday was sent; `staff_birthday.updated { birthdaySet }`; never the date. | |

### Endpoints

- `GET /api/v1/settings/profile` adds `birthday: { month, day } | null`; `PUT` accepts `birthday?` (strict object, 422 for a non-day).
- `GET /api/v1/staff/birthdays` (`staff.birthday:manage`) → `{ items: [{ id, name, email, designation, location, roles: [labels], birthday }] }` (active users, up to 2000).
- `PUT /api/v1/staff/:id/birthday` (`staff.birthday:manage`) `{ birthday: { month, day } | null }` → `{ id, birthday }`; 404 for an inactive or unknown user.

## Support calendar (CA)

| Rule | Enforcement |
|---|---|
| CA-1 One shared connection per organisation (`eureka.calendar_connection`, key `support`): provider (`google` or `dev`), the calendar id (`primary` or an address such as `support@company.com`), the Google account that authorised it, and the refresh token as AES-256-GCM ciphertext under `CALENDAR_TOKEN_KEY` (64 hex; dev mode derives a key from the session secret). The key is never in the database; the worker never reads the table. | guard trigger (server-set `connected_by`, times), RLS `has_perm('calendar:block')` |
| CA-2 `calendar:block` is granted to Sales leads (`lead` team, `manager` / `assoc_director` hierarchy) and to interview coordinators (org). Any holder may connect or disconnect (the connection is shared) and sees its status; nobody else sees that a connection exists. | catalog, RLS, `RequirePermission` |
| CA-3 Connecting is a top-level Google sign-in (OAuth 2.0 code flow with `access_type=offline`, `prompt=consent`, scopes `openid email calendar.events calendar.freebusy`; the scopes Google granted are stored with the connection) started at `GET /calendar/support/connect?calendarId=`; a signed, 10-minute state cookie bound to the caller's user id is checked at `GET /calendar/support/callback` (403 `calendar_state_expired` / `calendar_state_mismatch`); the browser returns to the app. The Google OAuth client needs the redirect URI `<PUBLIC_BASE_URL>/api/v1/calendar/support/callback`. | `CalendarService.signState / readState`, `GoogleCalendarProvider` |
| CA-4 **Block**: `POST /interviews/:id/calendar-block` creates a busy event on the connected calendar for the interview's slot (summary "Interview: round – candidate", description with candidate, client, position, round, type, meeting link, recruiter) and records one active `calendar_block` per interview. The interview must be visible (404), `calendar:block` must cover its actor snapshot (403), the interview must be `scheduled` (422 `interview_not_scheduled`), not already blocked (409 `already_blocked`), and a connection must exist (422 `calendar_not_connected`). If the database refuses the row after the event was created, the event is removed again. | API scope check (`activityVisible`), RLS insert policy (`has_perm` + interview readable), partial unique index |
| CA-5 **Release**: `POST /interviews/:id/calendar-block/release` removes the event (an event already gone counts as removed; a connection replaced since the block cannot reach it: the record is still released, audited `reachable: false`) and marks the row `released` (`released_by/at` server-set; nothing else about a block ever changes). 404 `no_active_block`. | guard trigger |
| CA-6 `GET /interviews/:id/calendar-block` (readers of the interview) → `{ block, canBlock, connected }`; the drawer shows the block to every reader and the buttons to `calendar:block` holders. Audit: `calendar.connected { provider }`, `calendar.disconnected`, `calendar.blocked`, `calendar.released { reachable }`; account and calendar addresses are redacted. | |
| CA-7 **Free/busy (read-only scheduling aid)**: `GET /calendar/support/busy?from=&to=` (instants, `to` after `from`, at most 31 days; 422 otherwise) for holders of `calendar:block` **or** `interview:create` (403 otherwise) → `{ connected, available, busy: [{ startsAt, endsAt }] }`. Intervals only: no titles, attendees, account or calendar address leave the server (rule 5); nothing is cached, nothing is audited (a read). `available` is false while the connection lacks a free/busy scope (`calendar.freebusy`, or `calendar`, `calendar.readonly`, `calendar.events.freebusy`): `calendar.events` alone does not cover Google's `freebusy.query`, so a connection made before migration 0090 (`scopes = ''`) needs a reconnect, which the card offers; blocking keeps working meanwhile. The connection row reaches the read through `authz.calendar_freebusy_connection()` (definer; the table's policies stay `calendar:block` only). The Schedule and Edit dialogs query the day holding the chosen slot once the slot and duration are set and show "Support calendar is busy 10:00–11:00" / "Support calendar is free for this slot" under the slot (the interview's own block is not counted); the drawer's Support calendar section shows the same for the interview's slot. The check never blocks a save. | API permission check (`can`), `BusyQuery`, definer function, `DevCalendarProvider.freeBusy` in tests |

### Configuration

| Variable | Meaning |
|---|---|
| `CALENDAR_MODE` | `dev` (default; in-memory calendar, refused in production), `google`, `disabled` (hides the feature) |
| `CALENDAR_TOKEN_KEY` | 64 hex characters; required with `google` (AES-256-GCM key for the stored refresh token). Keep it with the other API secrets; rotating it needs a reconnect. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | the existing OAuth client (add the callback redirect URI) |

Terraform: `calendar_mode` in `infra/live/<env>/env.hcl` (`google` on staging since 2026-10-15) sets `CALENDAR_MODE`
and injects the generated `CALENDAR_TOKEN_KEY` (`/eureka/<env>/app/calendar_token_key`); the Google OAuth client needs the
callback redirect URI added by hand (infra/README.md "Google OAuth client").

### Endpoints

- `GET /api/v1/calendar/support` → `{ mode, connected, freeBusy, calendarId, accountEmail, connectedAt, connectedBy }` (`freeBusy`: the connection can answer CA-7; false → reconnect)
- `GET /api/v1/calendar/support/connect?calendarId=primary` → 302 to Google (dev: straight to the callback)
- `GET /api/v1/calendar/support/callback?code&state` → 302 to the app
- `POST /api/v1/calendar/support/disconnect` → the status
- `GET /api/v1/calendar/support/busy?from=&to=` (`calendar:block` or `interview:create`) → `{ connected, available, busy: [{ startsAt, endsAt }] }`
- `GET /api/v1/calendar/support/dev/events` (dev provider, never in production): the fake calendar's events
- `GET|POST /api/v1/interviews/:id/calendar-block`, `POST .../calendar-block/release` → `{ block, canBlock, connected }`

## Assumptions and open product questions

- **"Interview coordinators"** are a role, not a hand-picked list: grant `interview_coordinator` to the support staff. If the
  coordinators should instead be a per-team list, that is a new admin setting.
- **Candidate email in the coordinators' email** is a deliberate exception to the no-contact-details rule (owner request).
  The candidate's phone is not included (it is masked for most roles); say so if it should be.
- **"Offshore team"**: no structural flag was added. HR enters birthdays for whoever should be in the digest (the screen can be
  filtered by role and location); the digest covers every active staff member with a birthday on file. If only certain
  locations should be in the digest, add a location filter to `authz.emit_birthdays`.
- **Digest recipients:** the CEO only. HR could be added to the resolver's role list in one line.
- **Calendar ownership:** one shared connection, made by whoever can sign in as (or write to) the support calendar. Per-lead
  connections (each lead's own Google account) would need the lead's account to have write access to the support calendar
  and a token per user; not built.
- **Contracts** are append-only; a correction means a second contract. Edit / void can follow if needed. Rates are not part
  of the contract record (they stay on the placement under `rate:read`).
- **Reminders** for a blocked slot (e.g. the slot moved after the block) are not built: a rescheduled interview keeps its old
  block until someone releases and re-blocks; the rescheduled alert tells the coordinators.
