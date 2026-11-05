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
out. Not personal calendars: coaches have no Google connection, so other meetings and leave do not
show. **Limit:** this gates the grid only. `interview:read` still shows interviews and their coach
on the Interviews page, on its own scope.

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
