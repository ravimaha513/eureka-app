# Coach calendar: API contract

Every Interview Coach's interviews in one grid, and who may see it. Built in migration
`0540_coach_calendar.sql`, `apps/api/src/modules/calendar/coach-calendar.*` and
`apps/web/src/calendar/CoachCalendar*`.

**Who decides:** the CEO alone, meaning a current holder of the system role `ceo`. The database
checks that role itself (`authz.is_ceo()`), so a custom role can't gain this: `coach_calendar:*` is
refused on custom roles, left out when cloning `ceo`, and not offered in the role editor. No access
by default: Interview Leads and Coordinators need a grant like anyone else. **Admins still control
role membership:** whoever an admin makes `ceo` gets this control, and giving someone a role that has
a grant gives them that grant. Use a user grant where that matters.

| Viewer | Sees |
|---|---|
| CEO | every coach, full detail |
| Interview Coach | their own column, full detail (fixed) |
| A role or user with a grant | the coaches the grant covers, at its detail |

Grants add up. A viewer gets the union of their user grant and role grants, at the highest detail,
so a user grant can widen a role grant but not narrow it. Admins can't be given access, by name or
by role; a grant is suspended while its holder is an admin. Deactivating a user deletes their user
grant and archiving a role deletes its grant, so neither comes back on reactivating or restoring.
These two removals show in the log as the deactivation or archive, not as `coach_calendar.revoked`.
Grants carry no version check on purpose: each save states the full grant, and the last one wins.
Details: `full` = candidate name, round,
status; `busy` = times only.

**Coaches** are active holders of the `interview_coach` role, the set the scheduling picker offers;
an Interview Lead has no column. **Source:** `eureka.interview` by `coach_id`; `cancelled`, `rescheduled` and `no_invite` are left
out. A coach's own Google events are layered on once they connect (CC-6 below). **Limit:** this gates the grid only. `interview:read` still shows interviews and their coach
on the Interviews page, on its own scope. A coach can open every interview in their own column: being assigned
grants read (`interview_read`, 0570, IS-15 in `docs/interviews-settings-api.md`).

| Id | Route | Permission | Notes |
|---|---|---|---|
| CC-1 | `GET /api/v1/coach-calendar?from&to` | CEO, coach or a grant, else 403 | Window up to 31 days, else 422. `{ canManage, coaches: [{ id, name, detail }], events: [{ coachId, startsAt, endsAt, interviewId, candidateName, round, callStatus }] }`; the last four are null at `busy` |
| CC-2 | `GET /api/v1/coach-calendar/grants` | `coach_calendar:manage` | `{ items, coaches, roles }`; `roles` leaves out `ceo`, admin and archived roles |
| CC-3 | `GET /api/v1/coach-calendar/people?q=` | `coach_calendar:manage` | Active non-admin people by name, up to 20; id and name only |
| CC-4 | `POST /api/v1/coach-calendar/grants` | `coach_calendar:manage` | `{ granteeRole \| granteeUserId, allCoaches, coachIds?, detail }`. One grant per grantee: granting again replaces it. 422: `invalid_grantee`, `invalid_coaches`, `invalid_detail` |
| CC-5 | `DELETE /api/v1/coach-calendar/grants/:id` | `coach_calendar:manage` | 204, or 404 |

CC-4 and CC-5 are audited (`coach_calendar.granted`, `coach_calendar.revoked`) with ids and settings
only, so past access can be rebuilt from the log. A grant also adds `coach_calendar:read` to the capabilities `GET /api/v1/me` returns, which
opens the sidebar entry; the API re-checks on every read.

## Coaches' Google Calendars (CC-6..CC-8, migration 0550)

A coach connects their own Google account from the calendar screen; who may then see them is still
the grants above. **Never stored:** events are read live from Google on each request. The only thing
kept is the refresh token, AES-256-GCM under `CALENDAR_TOKEN_KEY`, in
`eureka.coach_google_connection`, which `eureka_app` cannot read directly.

| Id | Route | Who | Notes |
|---|---|---|---|
| CC-6 | `GET /api/v1/coach-calendar/google?from&to` | CEO, coach or a grant, else 403 | Up to 31 days; 60 calls a minute per user, else 429; waits at most 20 seconds, and coaches still pending show as `unavailable`. `{ enabled, me: { canConnect, connected, accountEmail }, coaches: [{ coachId, status }], events: [{ coachId, startsAt, endsAt, title }], allDay: [{ coachId, startDate, endDate, title }] }`. `endDate` is exclusive. `status`: `connected`, `not_connected`, `reconnect`, `unavailable`. One coach failing never fails the rest |
| CC-7 | `GET /api/v1/coach-calendar/google/connect`, then `.../callback` | Holders of `interview_coach` only, else 403 at connect | Browser navigation to Google and back to `/coach-calendar?google=connected\|cancelled\|wrong_account\|scope_missing\|failed` |
| CC-8 | `DELETE /api/v1/coach-calendar/google/connection` | Self | 204, also when nothing was connected. Revokes at Google, best effort, except when that account also holds the support calendar: Google revokes per account and OAuth client, so it would end that for everyone |

- **Whose account:** the Google email must be verified and equal the coach's Eureka login (checked in
  `authz.coach_google_connect`). A refused token is dropped, not revoked, for the reason in CC-8.
- **Google scope:** `calendar.events.readonly` plus `openid email`. Read-only. Google lets that scope
  read all the account's calendars; Eureka's code only ever asks for the primary one.
- **Fields asked of Google:** title, times, status, visibility and the coach's own response.
  Locations, descriptions, meeting links and other attendees are not requested.
- **What shows:** private and confidential events show without a title. Declined, cancelled,
  working-location and birthday entries do not show.
- **Titles:** `detail = full` viewers only. Busy-only viewers get times.
- **Duplicates:** the screen hides a Google event at exactly a coach's interview time for that coach.
  At any other time, an overlap with an interview shows that interview as double-booked.
- **Removal:** disconnecting, losing the coach role through `authz.revoke_role`, and deactivation all
  delete the row. Only disconnecting also revokes at Google, because the database cannot decrypt the
  token; the others stop Eureka's use of it but leave the grant in the person's Google account until
  it is removed there. A role that simply expires by date keeps the row, unused.

CC-7 and CC-8 are audited (`coach_calendar.google_connected`, `.google_disconnected`) with the
provider only. Reads are not audited.

**Setup:** enable the Google Calendar API on the OAuth client's Google Cloud project (without it every
read fails: coaches connect fine but show "Google events unavailable", and the API log has `events read
failed: Error 403 accessNotConfigured`). Add `<PUBLIC_BASE_URL>/api/v1/coach-calendar/google/callback` to the OAuth client's
authorised redirect URIs, and `calendar.events.readonly` to the consent screen. That scope is
sensitive: an **Internal** consent screen needs no Google review, an External one does.
