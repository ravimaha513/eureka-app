# Eureka App 4 spec: what still needs to be built

Gap audit of 2026-10-16 against the customer document "Eureka App 4" (17 pages: sales reports,
interview monitoring, Hot List, placements, employment history, payments, BGC, paperwork,
performance, notifications, sales hierarchy, permission matrix). Each item was checked against the
code (migrations, services, controllers, worker jobs, web pages), not the docs. Paths and line
numbers are as of commit `1b426cb`.

Status: **Built**, **Partial** (see gap), **Missing**. Size: **L** (new module, tables, UI),
**M** (new endpoint or several fields with UI), **S** (a field, a status value, a scope change).

## Decisions already made

- "Offshore manager", "offshore office manager" and "offshore incharge" in the spec are the
  existing **associate director** role (`assoc_director`). No new role, and no departments model.
  (The offshore manager role was removed in migration `0090_remove_offshore_manager.sql`.)
- "Proxy" in the interview reports is the **interview coach** (`interview_coach`).

## Building the big items

The four L items are independent and can be built in parallel. To avoid collisions, give each its
own migration number range: Payments 0100-0109, Performance 0110-0119, Market reports 0120-0129,
Interview reports 0130-0139. All four touch `packages/shared/src/authz/catalog.ts`; Payments and
Performance also touch `apps/api/src/worker/notify-types.ts`; keep those edits additive.

---

## L1. Payments / Incentive dashboard (Missing)

Today the Payments nav entry opens a placeholder (`apps/web/src/App.tsx:194`, `PLANNED.payments`).
Only the `invoice:read` / `invoice:update` permissions exist.

Fields per placement / invoice:

| Field | Notes |
|---|---|
| Candidate name, technology | From the placement |
| Client | Implementation / PV / end client |
| Rate / part | Billing rate and incentive part |
| Vendor company | Vendor / prime vendor |
| Joining date | Project joining date |
| Timesheet status | Date timesheet went to Accounts after client approval |
| Invoice date | Date Accounts raised the invoice |
| Payment terms | Net 15 / 30 / 45 / 60 etc. |
| Expected payment date | Computed: invoice date + terms |
| Payment status | Pending / Received / Delayed |
| Payment received date, amount, hours billed | Entered by Accounts |
| Delay days | Computed: expected date vs received date (or today) |
| Recruiter, TL, manager, associate director | Derived from the placement and hierarchy |

Notifications (existing `notify-types` + worker job pattern):
- First payment received for a placement: recruiter, TL, manager.
- Payment delayed (past expected date, not received): recruiter and TL, to follow up with the vendor.

Access: Accounts edits; sales reads by hierarchy (recruiter own, lead team, manager and AD
hierarchy, CEO org), scoped through RLS like placements. Reuse placement data; do not copy it.

## L2. Recruiter performance (Partial)

The Performance nav entry is a placeholder (`apps/web/src/App.tsx:194`, `PLANNED.performance`).
`apps/api/src/modules/dashboard/dashboard.service.ts:21-51` already counts submissions, interviews,
placements and joins with a date range, grouped by recruiter, team or location.

Missing, all filtered by date:
- List of active candidates on end-client projects (candidate, vendor, joining date, client).
- Submission and interview counts with drill-down to the full rows.
- Ratios: submission→interview, interview→placement, overall placement ratio.
- Recruiter targets (set by manager / AD, per period) and a "recruiter activity below target"
  notification to recruiter, TL and manager.
- Manager and AD can move a recruiter between teams (exists: `admin.service.ts:436`) and change
  designation. The `designation:change` permission exists in the catalog but is never checked;
  today designation changes only through `access:manage`.

Visibility: recruiter own; lead sees recruiters in the team; manager sees leads and recruiters in
the hierarchy; AD sees managers, leads and recruiters; CEO sees all.

## L3. CEO market reports (Missing)

Spec: reports by technology, by batch and by location showing how many candidates are in market and
how many got placed, to plan the next batches. Also team-wise / technology-wise / location-wise
candidate counts, and allocation counts (candidates per team, per lead, per recruiter).

The dashboard only counts activity in a period; there is no point-in-time count. Build:
- Current counts: in market (actively marketed statuses), placed (joined / on project), and a
  per-status breakdown.
- Group by technology, batch, location, team, lead or recruiter; optional "placed between" dates.
- CSV export, audited like the Hot List export.
- Scopes: CEO org; AD and manager hierarchy; lead team; location incharge / location ops admin
  their location.
- UI as a tab on the existing Reports page (`apps/web/src/employees/JoiningsExitsReport.tsx`).

## L4. Interview reports (Missing)

Spec: interview reports by proxy (interview coach), by technology, by candidate and by duration.
There is no coach link on an interview and no duration (`db/migrations/0080_interview_details.sql:7`).

Build:
- Interview coach and duration on the interview, editable under the existing field policy.
- Report: interview count, cleared count, average and total duration, grouped by coach, technology,
  candidate or duration bucket; date-filtered; scoped like interview reads; CSV export.
- Daily interviews report: one row per interview for a day, including the candidate's feedback
  (the auto email about an hour after the interview already collects it as feedback
  `kind='candidate'`, `db/migrations/0021_candidate_feedback.sql:48,97`, but it only shows in the
  per-interview dialog).
- Green highlighting of cleared rows on the interview board
  (`apps/web/src/interviews/InterviewsPage.tsx`).

---

## Medium items (M)

| Area | Gap | Evidence |
|---|---|---|
| Hot List filters | No location, visa, documents, resume, or guest house vs remote filters | Only status, technology, visibility, search: `apps/api/src/modules/candidates/candidates.schemas.ts:6-17` |
| Hot List visibility | Spec: team-assigned candidates visible only to that lead's sales team and the interview prep team; "Open to all teams" to everyone. Today every user sees every row (phones masked). Switch the flag, and narrow `interview_coordinator`'s org-wide candidate read | `HOTLIST_VISIBILITY = "everyone"` at `packages/shared/src/authz/catalog.ts:16`; coordinator `catalog.ts:461` |
| Candidate company links | No E-Verify, offer letter or 1099 company on the candidate; decide edit rights | `company` table exists: `db/migrations/0054_companies_facilities.sql:43` |
| Marketing locations, GH location | Marketing locations missing; `gh_location_id` column exists but no API reads or writes it; no "Remote" value | `db/migrations/0003_domain.sql` |
| Location sales view | Location incharge / ops admin get counts by location, not per candidate (submissions, interviews, cleared calls by candidate) | `catalog.ts:321,352` |
| Sales reports by manager | Dashboard groups by recruiter, team or location only; no manager grouping, no export | `dashboard.service.ts:21` |
| Joinings / exits report | Add payroll company, technology, first vs later assignment, grouping by company; give Immigration `report:read` | `apps/api/src/modules/employees/reports.service.ts:84-135` |
| Employment history search | Add E-Verify date, onboarded date, vendor and pay rate to history; client search matches only current assignments | `employees.service.ts:214` (`la.end_date IS NULL`), `:236-257` |
| Active employee count | Count of employees assigned to a client in a given month | Only a status filter: `employees.schemas.ts:13` |
| Placements report | Filters by vendor, technology, end client, location; export | `placements.schemas.ts:44-55` |
| Candidate pipeline report | Cross-candidate view of marketing start → submissions → interviews → assessments ("gliders") → confirmation → paperwork → joining; no assessment stage today | Per-candidate timeline only: `apps/web/src/sales/CandidateTimeline.tsx` |
| Notifications | No "candidate not responding" (stop / hold marketing warning to the candidate) job | `apps/api/src/worker/notify-types.ts` |
| Preferred vendor details | Recruiters enter preferred vendors, visible only to their superiors. Only the permissions exist | `catalog.ts:110-111`; no table, API or UI |

## Small items (S)

| Area | Gap |
|---|---|
| Marketing status values | Add Active/Remote, Active/All Teams, N/A (all-teams is a separate `visibility` field today; decide whether the status mirrors it) |
| Technology list | Align the seed (`apps/api/src/db/seed-load.ts:60`) with the spec: Java, DE/PY, Python Developer, .Net, DevOps, AI/ML, Networking, Service Now, Business Analyst, Others, Data Science, PY AI, Salesforce Administrator, Python Full Stack |
| Candidate fields | LinkedIn, resume link, number of confirmations, date added to team, documents status summary |
| Eligibility | `eligibility` field (spec: "in person eligibility etc."); `in_person_ok` exists. Needs the field list |
| Document types | Add E-Verify copy and 1099 documents (`packages/shared/src/documents.ts:77-86`) |
| Placement statuses | Add "joining issue" next to `bgc_failed` (`db/migrations/0022_placements.sql:45`) |
| Re-confirmation flag | Explicit "existing consultant re-confirmed" on placement entry; today only inferred from `is_first_placement` |
| BGC form | Employment and address history as 3 / 5 / 7 / 10 year choices (today free 0-50) |
| Employee list | Show lead and recruiter (`apps/web/src/employees/EmployeesPage.tsx:138`) |
| Recruiter entry rights | Recruiters may add submissions, interviews and placements for any Hot List candidate; today `submission:create` / `placement:create` are team-scoped |
| Leaving a project | Let HR / Accounts assign a team when an employee comes off a project (today needs `candidate:assign`, Sales only) |
| Bench alert | Add the POC to the `employee.bench_time` audience (`notify-types.ts:268`) |
| Interview board | Candidate feedback column on the board (covered by L4's daily report if done there) |

## Already built (no work needed)

- Report scoping for lead (team), manager and AD (hierarchy), CEO (org).
- Interview tracking by day, cleared toggle limited to location roles, client filter and client
  history, Otter and recording links with consent, system name and location on the board,
  location feedback after each interview.
- Feedback email to the consultant about an hour after the interview.
- Technical rating by location roles.
- Submission status flow (submitted → under review → interview requested → scheduled → completed →
  selected; rejected from any open step).
- BGC record (company, helped by, education, employment and address years, notes).
- Documents-pending and paperwork-pending reminders; visa expiry alerts.
- Employee comes off a project: HR / Accounts end the assignment; HR, Accounts, Immigration, BU and
  CEO are notified; lead and manager are notified when the candidate is reassigned.
- First-placement flag set by the database.
