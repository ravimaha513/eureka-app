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

Invariant (0048): at most one open assignment per person (partial unique index `assignment_open_person`).
`bgc_failed` on a joined placement ends its assignment and benches the candidate only when that assignment was still
open; on a placement whose assignment already ended (project exit) it is recorded (status, reason, outbox) without
moving the candidate or the employee.

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
  (`bgc_failed_last`, open question) when the last assignment ended with `bgc_failed` or any placement of the person
  failed its check after joining, and when the candidate already left the bench.
- `GET /api/v1/reports/joinings-exits?from=YYYY-MM-DD&to=YYYY-MM-DD` (`report:read`; at most two years) →
  `{ from, to, totals: { joinings, firstPlacements, exits, exitsByReason: {completed, terminated, resigned, bgc_failed} },
  byTeam: [{ team, joinings, exits }], items: [{ kind: "joining"|"exit", date, assignmentId, assignmentNo, placementId,
  candidate: {id,name}, client, team, recruiter, location, isFirstPlacement, endReason }], truncated }`. A joining is an
  assignment that started in the period; an exit one that ended in it. Rows are the assignments the caller can read
  (RLS plus the engine's `assignment:read` and `report:read` predicates on the placement's actor snapshot or owned
  candidate), so the counts equal what the role can list; callers with `report:read` but no `assignment:read` (location
  roles) get zeros. Totals and `byTeam` are SQL counts over every matching assignment (no cap); up to 1,000 items in
  the view (`truncated`), newest first. 30 requests per user per minute (429), 60 s timeout (503).
- `POST /api/v1/reports/joinings-exits/export` `{ from, to }` (`report:export`) → CSV (`Event, Date, Candidate, Assignment
  no., Client, Team, Recruiter, Location, First placement, End reason`), additionally limited to the `report:export` scope,
  capped at 50,000 lines (`x-export-truncated`), 60 s timeout, 5 per user per 10 minutes, formula-injection safe, audited
  as `report.export` `{ report: "joinings_exits", from, to, rows, truncated, cap }`. No phone, email, rate or reason text.
- interviews-settings (`docs/interviews-settings-api.md` EM-C1, EM-X1): list and detail items carry
  `contact: { email, phone, masked }` (masked unless `candidate.phone:read` over the candidate), and
  `POST /api/v1/employees/export` exports the filtered list as CSV.

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

History order: the detail sorts by recording time, then effective date, then id. Rows backfilled by 0045 for
assignments that existed before it share one recording time, so they sort by effective date (no row is rewritten).

## Open questions (conservative defaults in place)

- Should recording an exit change the candidate's marketing status (e.g. `terminated`)? Today it is left as it is (bench).
- May HR/Accounts return a benched employee to marketing, or only Sales (who already can, `bench → active`)? Built for
  `assignment:update` holders; refused after a failed background check (re-placing after BGC failure is open). Sales'
  manual `bench → active` (`authz.transition_candidate`) is unchanged and does not apply that BGC check: decide whether it
  should.
- `bgc_failed` reported on a joined placement whose assignment already ended is recorded only (no candidate or employee
  change). Should it be refused instead, or should it also stop a later re-placement?
- End dates: project exits are recorded for today or earlier only (a future end is a planned end date). Is a future-dated
  exit needed?
- Assignment start date stays the day the placement is marked `joined` (open question in HANDOFF, unchanged here).
- Ending-soon window (30 days) and recipients (`hr`, `accounts`); benched/exited recipients (admin teams, BU Head, CEO per
  B6). Should the recruiter, Lead and Manager also be told?
- BU Head holds `employee:read` but not `candidate:read`: names are hidden from them. Should `employee:read` show names?
- HR-owned employee fields from B2.4 (`payroll_entity_id`, `everify_date`, `onboarded_date`) are built in 0150 (below);
  anything needing field encryption (SSN, work-authorization numbers) is not built here.

## 0150: Eureka App 4 gaps (Employees bundle)

Built in migration `0150_employees_gaps.sql`, this module, `packages/shared/src/authz/employment.ts` and the Employees
and Reports screens. Conservative defaults for every ambiguity are listed under "Decisions" below.

| Rule | Enforcement |
|---|---|
| EM-10 Employment facts per assignment (design B2.4): payroll company (one of the group's own companies, `eureka.company`, AS-09), E-Verify date, onboarded date and the employee's hourly pay rate, in `eureka.assignment_employment` (kept apart from `eureka.assignment` like `assignment_plan`). Readable wherever the assignment is; the app has no column privilege on `pay_rate`. | RLS `assignment_employment_read` (EXISTS by key under `assignment_read`), column grants, write guard (definer only, server stamps `updated_by`/`updated_at`, no delete/truncate) |
| EM-11 Writes as every employment write (EM-4: `assignment:update` on the actor snapshot and `employee:read` at org scope: HR, Associate HR, Accounts), on open or ended assignments (history corrections). The pay rate also needs `rate:read` over the placement's actor snapshot (Accounts; the placement rate rule PL-6). | `authz.set_assignment_employment` (re-checks through `authz.assignment_for_update`, NULL-safe, refuses unknown keys), API pre-check |
| EM-12 Pay rates are read only through `authz.assignment_pay_rates(person)`: `employee:read` at org scope, the assignment visible and `rate:read` over the actor snapshot (Accounts, CEO). Never on the list, in exports, audit or outbox rows. | definer read, field policy in the API |
| EM-13 Payroll company names reach employee and report readers (who hold no `company:read`) through `authz.payroll_companies()` (id, name, status only). | definer read |
| EM-14 Leaving a project: HR, Associate HR and Accounts put a benched employee's candidate (candidate `bench` or `active`) in a Sales team without `candidate:assign`. The recruiter is cleared (the new lead assigns one); `candidate.assigned` is recorded for the new lead and manager (FR-NTF-10). | `authz.assign_employee_team` (re-checks through `authz.employee_for_update`); the candidate column guard lets definer code change `team_id` only under `authz.employment_team_context`, a transaction-scoped marker only this function writes |
| EM-15 Immigration holds `report:read` (org). It has `employee:read`/`assignment:read` but no placement scope, so its joinings/exits and active-employee rows come from `authz.employment_movements` (ids, dates, reason categories, payroll company: facts its employment history already shows); client and recruiter stay `null`. It cannot export (no `report:export`). Its Dashboard shows the candidate metric only. | definer read, `ReportsService.source()` |

Endpoints (additions):

- `GET /api/v1/employees?...&clientId=&clientMatch=any|current&vendorId=&payrollCompanyId=`: `clientId` now matches any
  readable assignment of the employee (current or past) unless `clientMatch=current` (the old behaviour); `vendorId`
  (placement vendor) and `payrollCompanyId` also match any readable assignment. Items add `lead` (the candidate's team's
  lead) and `recruiter` (the candidate's recruiter), and `assignment` adds `vendor`, `payrollCompany`, `everifyDate`,
  `onboardedDate`. The CSV export adds `Lead, Recruiter, Vendor, Payroll company, E-Verify date, Onboarded date`.
- `GET /api/v1/employees/:id`: each of `assignments` adds `vendor`, `payrollCompany`, `everifyDate`, `onboardedDate`, and
  `payRate` (number or null) only when the caller may see it (EM-12; the key is absent otherwise). `actions` adds
  `assignTeam` and `editEmployment`.
- `GET /api/v1/employees/payroll-companies` (`employee:read`, org) → `{ items: [{ id, name, status }] }`.
- `GET /api/v1/employees/teams` (`assignment:update`, and `employee:read` at org) → `{ items: [{ id, name, lead: {id,name}, location }] }`.
- `PATCH /api/v1/assignments/:id/employment` `{ payrollCompanyId?: uuid|null, everifyDate?: date|null, onboardedDate?: date|null,
  payRate?: number|null }` (at least one; `assignment:update`) → `{ id, changed: [field], payrollCompany, everifyDate,
  onboardedDate, payRate? }`. A new company must be active. Audit `assignment.employment_updated` `{ fields, payrollCompanyId? }`.
- `POST /api/v1/employees/:id/assign-team` `{ teamId }` (`assignment:update`) → `{ id, candidateId, team: {id,name}, recruiter: null }`.
  Audit `employee.team_assigned` `{ candidateId, fromTeamId, toTeamId }`.
- `GET /api/v1/reports/joinings-exits`: items add `isFirstAssignment` (assignment no. 1 vs a later one), `technology` (the
  candidate's), `payrollCompany`; `client` may be `null` (EM-15). `totals` adds `firstAssignments` and `laterAssignments`
  (joinings); `byCompany: [{ company, joinings, firstAssignments, laterAssignments, exits }]` (payroll company, `null` = not set).
  The CSV adds `Assignment` (First/Later), `Technology`, `Payroll company`.
- `GET /api/v1/reports/active-employees?month=YYYY-MM&clientId=` (`report:read`) → `{ month, from, to, total, byClient:
  [{ client, count }], byCompany: [{ company, count }] }`: distinct employees with an assignment running on any day of the
  month (started on or before its last day, not ended before its first), over the same rows as joinings/exits (scope,
  rate limit and timeout shared). For EM-15 callers a client filter matches nothing.

New error codes (`detail`, 422): `invalid_field`, `invalid_company`, `invalid_date`, `invalid_rate`, `invalid_team`.

Document types (0150): `everify` "E-Verify copy" and `form_1099` "Form 1099", both restricted (case results and tax forms
carry SSN/TIN), so only HR, Accounts and Immigration open or upload them.

### Decisions (0150, conservative defaults)

- "Payroll company" is one of the group's own companies (0054 `eureka.company`); no separate legal-entity list.
- E-Verify date, onboarded date and pay rate are per assignment (design B2.4), not per employee.
- Pay rate is the employee's hourly pay, gated like billing rates (`rate:read`): Accounts and the CEO see it, HR does not.
- "First vs later assignment" is the person's assignment number (1 vs > 1), alongside the existing `isFirstPlacement`.
- Client search over past assignments is the default; `clientMatch=current` keeps the old filter.
- Team assignment after a project clears the recruiter and is allowed while the employee is benched (candidate on bench or
  back in marketing); HR cannot pick a recruiter.
- Immigration's report omits clients and recruiters rather than widening its placement scope.
