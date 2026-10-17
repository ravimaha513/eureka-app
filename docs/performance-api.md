# Recruiter performance API

The Performance page (Eureka App 4 gap L2): submissions, interviews and placements per person with
their ratios, the rows behind each count, candidates active on end-client projects, recruiter
targets per period with a "below target" notification, and designation changes and team moves by
managers and associate directors. Code: `apps/api/src/modules/performance`,
`apps/api/src/worker/jobs/performance-below-target.ts`; page: `apps/web/src/performance`;
migrations `0110_performance_targets.sql`, `0111_designation_change.sql`,
`0112_performance_below_target.sql`; tests: `apps/api/test/performance.db.int.test.ts`,
`apps/api/test/performance.api.int.test.ts`, `apps/web/src/performance/Performance.test.tsx`.

## Access and visibility

| Role | `performance:read` | `performance.target:manage` | `designation:change` | `team:move_member` |
|---|---|---|---|---|
| Recruiter | own | — | — | — |
| Lead | team (the lead and the team's recruiters) | — | — | — |
| Manager | hierarchy (leads and recruiters below) | hierarchy | hierarchy | hierarchy |
| Associate Director | hierarchy (managers, leads, recruiters below) | hierarchy | hierarchy | hierarchy |
| CEO | org | — | — | — |
| Location Incharge | location | — | — | — |

- `performance.target:manage` is new (catalog, 0110). "Offshore manager" in the spec is the
  Associate Director (decision of 2026-10-16); no new role.
- **People a grant covers** are computed in the database by `authz.scope_user_ids(perm)` (0110):
  own: the caller; team: the caller and the members and lead of the caller's teams; hierarchy:
  the caller, everyone below them in the reporting hierarchy, and the members and leads of the
  teams they or anyone below them lead; location: current members of teams at the location and
  users whose primary location it is. Org scope is not expanded (callers test `has_org` first).
- **People listed** (summary, people): active users holding a Sales role below the CEO
  (recruiter, lead, manager, associate director) that `performance:read` covers (everyone for
  org scope), plus anyone with a counted row.

## PF-1 period

`from`, `to`: ISO instants (or dates), default the last 30 days; `from < to`; at most 366 days
(422 otherwise). `tz`: IANA zone for calendar dates (active candidates), default
`America/New_York`. Strict query schemas (unknown keys: 422). 30 report requests per user per
minute (429); a statement timeout is a 503 asking for a shorter period.

## PF-2 counts and drill-down

Every count is a count of rows the caller could list themselves, exactly as the dashboard
(`docs/dashboards-api.md`): the list predicate of the row's read permission (`activityPredicate`)
under RLS, narrowed to the caller's `performance:read` scope over the row's **actor snapshot**
(recruiter, team, location of the row). Attribution is the row's `recruiter_id`.

| Kind | Rows | Read permission |
|---|---|---|
| `submissions` | `submitted_at` in the period | `submission:read` |
| `interviews` | `starts_at` in the period, not cancelled / rescheduled / no invite | `interview:read` |
| `interviewsCleared` | `cleared_at` in the period | `interview:read` |
| `placements` | `created_at` in the period | `placement:read` |
| `joined` | `joined_at` in the period | `placement:read` |

- `GET /api/v1/performance/summary?from&to&tz` returns
  `{ period, kinds, totals: { counts, ratios }, people: [{ user: { id, name, designation, active }, team, counts, ratios }] }`.
- `GET /api/v1/performance/activity?kind&from&to&tz&userId?&offset=0..10000&limit=1..200` returns
  `{ kind, period, total, items: [{ id, at, candidate: { id, name|null }, recruiter, team, client, status, detail }] }`,
  newest first. `detail`: `{ jobTitle }` (submissions), `{ round, cleared }` (interviews),
  `{ vendor, tentativeStart, placementType }` (placements). Names follow person RLS (null when hidden).
  A `userId` outside the caller's scope returns no rows (not an error).

## PF-3 ratios

`submissionToInterview = interviews / submissions`, `interviewToPlacement = placements / interviews`,
`placement = placements / submissions`; rounded to 3 decimals, `null` when the denominator is 0.

## PF-4 targets

One target per person, period kind (`week` from a Monday, `month` from the 1st, `quarter` from
1 Jan / Apr / Jul / Oct) and period start; counts for `submissions`, `interviews`, `placements`
(each 0..100000 or null for "no target", at least one set). Periods are New York calendar days.

- `GET /api/v1/performance/targets?from&through&userId` (dates; targets whose period overlaps)
  returns `{ truncated, items: [{ id, user, periodKind, periodStart, periodEnd (inclusive), targets, actuals, status, setBy, updatedAt, canManage }] }`.
  `actuals` count the person's own rows (as PF-2) in the period; `status`: `met` (every target
  reached), `below` (the period ended short), `inProgress`, `unknown` (a count the caller cannot
  read). RLS: rows of people `performance:read` or `performance.target:manage` covers.
- `PUT /api/v1/performance/targets` `{ userId, periodKind, periodStart, submissions?, interviews?, placements? }`
  creates or replaces (same person, kind and start) and returns `{ created, target }`.
  `performance.target:manage`; read before write: 404 unknown user, 403 `self_change`,
  `not_in_scope`, 422 invalid (misaligned start, nothing set, deactivated user `user_inactive`).
- `DELETE /api/v1/performance/targets/:id` returns 204; 404 when not visible, 403 outside the manage scope.
- Writes go through `authz.performance_target_set` / `authz.performance_target_delete` (definer,
  re-check the permission and scope; never the caller's own target). The app holds SELECT only; a
  guard sets `set_by` and the timestamps and keeps the key columns fixed. Audited as
  `performance.target_created|updated|deleted` (ids, kind, start, counts).

## PF-5 active candidates on end-client projects

`GET /api/v1/performance/active-candidates?from&to&tz&userId?` returns
`{ period, total, truncated, items: [{ placementId, assignmentId, candidate, client, vendor, implementationPartner, workMode, joiningDate, endDate, recruiter, team, location }] }`
(at most 500, newest joining first): assignments that were running at some point of the period
(`start_date` on or before its last day, no end or an end on or after its first day), on placements
listed as in PF-2 (`placement:read`, performance scope over the placement's actor snapshot). The
client is the placement's end client.

## PF-6 "recruiter activity below target" notification

Daily job `performance-below-target` (07:15 America/New_York; `authz.emit_performance_below_target`,
0112) checks every target of an active person whose period ended within the last 14 days and emits
one `performance.below_target` event per target when any metric with a target fell short (ledger
`performance-below-target`, key the target id: exactly once). Counting is the person's own rows as
in PF-2, without RLS (definer). Payload: `targetId`, `userId`, `periodKind`, `periodStart`, and
`<metric>Target` / `<metric>Actual` pairs. Recipients: the person, the lead of their current team
(or of the team they lead) and that lead's manager; without a team, the person's own manager.
Email and inbox; the text names the period kind and the counts only. The inbox entry opens
Performance. See `docs/notifications.md`.

## PF-7 people, designations and team moves

- `GET /api/v1/performance/people` returns `{ people: [{ id, name, designation, team, memberOfTeamId, canSetTarget, canChangeDesignation, canMoveTeam }], moveTeams }`
  for the page's actions (never for the caller themself).
- `PUT /api/v1/users/:id/designation` `{ designation: string | null }` (`designation:change`,
  over the users the grant covers) returns `{ id, designation }`. 404 unknown user, 403
  `self_change` / `not_in_scope`, 422 more than 120 characters or control characters.
  `PUT /api/v1/admin/users/:id/designation` is the same for `access:manage` (Users & Access, any
  user). Both run `authz.set_designation` (0111), which re-checks either rule; audited as
  `user.designation_changed` (`designation`, `previous`, `via`). A designation is a label and never
  changes access (N12).
- Team moves use the existing `POST /api/v1/teams/:id/move-member` (`team:move_member`, AD-8).

## PF-8 decisions

- Targets are per person and period, not per team; a lead's or manager's target counts their own rows.
- The below-target alert fires once when the period has ended (no mid-period pace alert); a period
  that ended more than 14 days before the job first sees it is not reported.
- Location Incharge keeps its catalog `performance:read` (location) grant: activity by the location
  snapshot, people by team location or primary location.
