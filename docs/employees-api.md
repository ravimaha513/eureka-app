# Employees, assignments and joinings/exits: API contract (Phase 3, FR-EMP-01..09)

Built in migration `0045_employees.sql`, `apps/api/src/modules/employees`, `packages/shared/src/authz/employment.ts`,
the worker job `assignment-ending-soon` and the web screens Employees and Reports. Design references: AS-08 (one
person, role-specific child records), B2.4 (`assignment`), B2.6 (candidate `placed → bench → active`), B4.4
(employees: `employee:read`, org-scoped roles only), B5 flow 6 (project exit), B6 (project-exit notification), B7
(reports). JSON, RFC 9457 problems with the code in `detail`, CSRF header on writes.

## Model

| Rule | Enforcement |
|---|---|
| EM-1 An employee is the employee child record of a person (`eureka.employee`, key `person_id`), created by the database when the person's first assignment opens (placement marked `joined`). No client creates or edits it. | AFTER INSERT trigger on `eureka.assignment` (`authz.employee_on_assignment_start`); write guard: only `authz_definer` writes, nothing is deleted or truncated (owner and superuser included) |
| EM-2 Status: `on_assignment` (an open assignment), `bench` (none open), `exited` (left the company). `on_assignment → bench` when the assignment ends (project exit, or `bgc_failed` after joining); `bench → exited` by an exit; `bench`/`exited → on_assignment` when a new placement joins. | AFTER UPDATE OF end_date trigger on `eureka.assignment`; `authz.exit_employee` |
| EM-3 Visibility: employees and their history need `employee:read` at org scope (HR, Associate HR, Accounts, Immigration, CEO, BU Head). Assignment details (client, dates, planned end) additionally need the assignment readable (0023/0038 policy: `assignment:read` on the placement and the placement visible), so Immigration sees employees without clients. Names follow the person policy: BU Head (no `candidate:read`) sees `name: null`. | RLS `employee_read`, `employment_event_read` (InitPlan `has_org`), `assignment_plan_read` (EXISTS by key under `assignment_read`) |
| EM-4 Writes need `assignment:update` on the placement's actor snapshot **and** `employee:read` at org scope (HR, Associate HR, Accounts). Read-before-write: 404 when not visible, 403 when visible but not allowed. | API pre-check (`canManageEmployment`), then the definer re-checks (`authz.assignment_for_update`, `authz.employee_for_update`), NULL-safe |
| EM-5 No free text: end and exit reasons are categories; audit and outbox rows hold ids, dates, statuses and categories only. | CHECKs, `employment_event.reason ~ '^[a-z_]{1,40}$'` |
| EM-6 Placements are unchanged: reassignment goes through the normal placement flow (selected submission → placement → `joined`), so the placement state machine, `is_first_placement` and assignment numbering are not duplicated. | — |

Lock order of every employment write matches `authz.transition_placement`: placement row, candidate row, per-person
advisory lock, assignment row, employee row.

## Endpoints

- `GET /api/v1/employees?status=&locationId=&clientId=&endingWithinDays=&search=&cursor=&limit=` (`employee:read`, org
  scope; other callers 403). `locationId` is the candidate's location; `clientId` the current (open) assignment's client;
  `endingWithinDays` (1..365) open assignments with a planned end on or before today + n (overdue included); `search`
  matches the name (1..80 characters). Ordered by `statusSince` desc; cursor `YYYY-MM-DD.<personId>`. Returns
  `{ items: [Employee], nextCursor }`.
- `GET /api/v1/employees/:personId` → `Employee` plus `assignments: [{ id, assignmentNo, placementId, startDate, endDate,
  endReason, plannedEndDate, client: {id,name}, isFirstPlacement }]` (newest first, readable ones only) and
  `history: [{ id, kind, at, actor, assignmentId, fromStatus, toStatus, effectiveOn, previousOn, reason }]` (newest first,
  up to 200; `kind` ∈ `started`, `end_date_set`, `ended`, `exited`, `returned_to_market`).
- `POST /api/v1/assignments/:id/end` `{ endDate, reason: "completed"|"terminated"|"resigned" }` (`assignment:update`) →
  `{ id, endDate, endReason, employeeStatus }`. Project exit: the end date is not in the future and not before the start;
  the candidate moves `placed → bench` (only if still `placed`); the employee goes to the bench (unless another assignment
  is open). `bgc_failed` is set only by the placement flow.
- `PUT /api/v1/assignments/:id/planned-end-date` `{ plannedEndDate }` (`assignment:update`) → `{ id, plannedEndDate,
  previousPlannedEndDate }`. Set, extend or bring forward the planned end of an open assignment (today or later, not before
  the start); a change re-arms the ending-soon notice.
- `POST /api/v1/employees/:personId/exit` `{ exitDate, reason: "resigned"|"terminated"|"other" }` (`assignment:update`) →
  `{ id, status: "exited" }`. Only from `bench`; the date is not before the last assignment's end and not in the future.
- `POST /api/v1/employees/:personId/return-to-market` `{}` (`assignment:update`) → `{ id, candidateStatus: "active" }`.
  Reassignment, first step: a benched employee's candidate moves `bench → active` so Sales can place them again. Refused
  after a failed background check (`bgc_failed_last`, open question) and when the candidate already left the bench.
- `GET /api/v1/reports/joinings-exits?from=YYYY-MM-DD&to=YYYY-MM-DD` (`report:read`; at most two years) →
  `{ from, to, totals: { joinings, firstPlacements, exits, exitsByReason: {completed, terminated, resigned, bgc_failed} },
  byTeam: [{ team, joinings, exits }], items: [{ kind: "joining"|"exit", date, assignmentId, assignmentNo, placementId,
  candidate: {id,name}, client, team, recruiter, location, isFirstPlacement, endReason }], truncated }`. A joining is an
  assignment that started in the period; an exit one that ended in it. Rows are the assignments the caller can read
  (RLS plus the engine's `assignment:read` and `report:read` predicates on the placement's actor snapshot or owned
  candidate), so the counts equal what the role can list; callers with `report:read` but no `assignment:read` (location
  roles) get zeros. Up to 1,000 items in the view (totals cover all).
- `POST /api/v1/reports/joinings-exits/export` `{ from, to }` (`report:export`) → CSV (`Event, Date, Candidate, Assignment
  no., Client, Team, Recruiter, Location, First placement, End reason`), additionally limited to the `report:export` scope,
  capped at 50,000 lines (`x-export-truncated`), 60 s timeout, 5 per user per 10 minutes, formula-injection safe, audited
  as `report.export` `{ report: "joinings_exits", from, to, rows, truncated, cap }`. No phone, email, rate or reason text.

`Employee` = `{ id (person id), candidate: {id, name|null}, status, employeeSince, statusSince, exitedOn, exitReason,
location, team, assignment: { id, assignmentNo, placementId, startDate, endDate, endReason, plannedEndDate, client } | null,
actions: { endAssignment, setEndDate, exit, returnToMarket } }`. `actions` are hints from the engine; the server checks again.

Error codes (`detail`): `assignment_closed`, `invalid_end_date`, `invalid_reason`, `invalid_transition`, `unchanged`,
`bgc_failed_last`, `candidate_not_on_bench` (422); 404 not visible; 403 not permitted; 429 export rate limit; 503 report
timeout.

Audit actions: `assignment.ended` `{ endDate, reason, employeeFrom, employeeTo }`, `assignment.planned_end` `{ from, to }`,
`employee.exited` `{ from, to, exitDate, reason }`, `employee.returned_to_market` `{ candidateId }`, and
`candidate.transition` `{ from, to, via: "employment" }` when the candidate moved.

## Outbox events (delivered by `outbox-delivery`, migration 0046)

Delivered by the notification jobs (`docs/notifications.md`). Recipients and channels come from the notification
registry, not from the payload: `notify` is only checked against the type's audience (a mismatch fails the event).

| type | aggregate | When | payload |
|---|---|---|---|
| `employee.benched` | `employee` / person id | An assignment ended (project exit or `bgc_failed` after joining) and the employee has no other open assignment (design B6 "project-exit") | `{ personId, candidateId, assignmentId, placementId, endDate: "YYYY-MM-DD", endReason: "completed"\|"terminated"\|"resigned"\|"bgc_failed", notify: ["hr","accounts","immigration","bu_head","ceo"] }` |
| `employee.exited` | `employee` / person id | `bench → exited` | `{ personId, candidateId, lastAssignmentId, exitDate, exitReason: "resigned"\|"terminated"\|"other", notify: ["hr","accounts","immigration","bu_head","ceo"] }` |
| `assignment.ending_soon` | `assignment` / assignment id | Daily job `assignment-ending-soon` (05:00 America/New_York): open assignment with a planned end within 30 days (`authz.assignment_ending_soon_scan(days)`, worker only, 1..90); once per planned end date, re-armed when the date changes | `{ assignmentId, placementId, personId, candidateId, plannedEndDate, daysLeft, notify: ["hr","accounts"] }` |

## Open questions (conservative defaults in place)

- Should recording an exit change the candidate's marketing status (e.g. `terminated`)? Today it is left as it is (bench).
- May HR/Accounts return a benched employee to marketing, or only Sales (who already can, `bench → active`)? Built for
  `assignment:update` holders; refused after a failed background check (re-placing after BGC failure is open).
- End dates: project exits are recorded for today or earlier only (a future end is a planned end date). Is a future-dated
  exit needed?
- Assignment start date stays the day the placement is marked `joined` (open question in HANDOFF, unchanged here).
- Ending-soon window (30 days) and recipients (`hr`, `accounts`); benched/exited recipients (admin teams, BU Head, CEO per
  B6). Should the recruiter, Lead and Manager also be told?
- BU Head holds `employee:read` but not `candidate:read`: names are hidden from them. Should `employee:read` show names?
- HR-owned employee fields from B2.4 (`payroll_entity_id`, `everify_date`, `onboarded_date`) and anything needing field
  encryption (SSN, work-authorization numbers) are not built here: they wait for the onboarding checklist and the field
  encryption work.
