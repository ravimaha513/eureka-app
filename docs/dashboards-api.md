# Dashboards API

`GET /api/v1/dashboard` serves the manager, lead and location dashboards (HANDOFF task 4,
implementation plan Phase 2, design B7). Code: `apps/api/src/modules/dashboard`; page:
`apps/web/src/dashboard`; tests: `apps/api/test/dashboard.api.int.test.ts`,
`apps/web/src/dashboard/Dashboard.test.tsx`.

## Access

- Requires `report:read` (403 otherwise). Holders: Recruiter (own), Lead (team), Manager and
  Associate Director (hierarchy), Offshore Manager, CEO, HR, Accounts and BU Head (org), Location
  Incharge and Location Ops Admin (location). No new permission was added.
- The web nav shows Dashboard to `report:read` holders only (it used to also list `performance:read`;
  every holder of that also holds `report:read`). The default landing page is unchanged.

## Scope rule

Every number is a count of rows the caller could list themselves:

1. Each metric uses the read permission of its list endpoint and the **same predicate**
   (`activityPredicate` / `scopePredicate`), and runs in `DbService.withUser` as `eureka_app`, so
   RLS applies underneath. There is no definer function and no materialized view (design B4.5,
   B7).
2. The result is narrowed to the caller's `report:read` scope, using ownership only (never the
   Open-to-all-teams rule). For every current role this changes nothing for activity rows; it
   limits **Candidates added** to candidates the caller owns through report scope, so a Recruiter
   counts only their own candidates, not the team's or other teams' open ones.
3. A metric whose read permission the caller lacks is **absent** (not zero) from `metrics`,
   `totals` and `groups`; the same holds for the needs-attention lists. HR, for example, gets
   placements and candidates only.

Org-scoped callers get a 60-second statement timeout for the request (design B4.8 N9); everyone
else keeps the 5-second default.

## Request

| Query | Meaning |
|---|---|
| `from`, `to` | Period `[from, to)`, date or ISO date-time with offset. Default: the 7 days ending now. `from < to`, at most 366 days; otherwise 422. |
| `groupBy` | `recruiter`, `team` or `location`. Default from the broadest `report:read` grant: own/team → recruiter, hierarchy → team, location/org → location. |

Unknown parameters are rejected (422).

## Metrics

| Key | Counts | Grouped by (recruiter / team / location) |
|---|---|---|
| `submissions` | `submission.submitted_at` in the period | actor snapshot columns |
| `interviewsScheduled` | `interview.starts_at` in the period, `call_status` not cancelled, rescheduled or no_invite | actor snapshot; location is where the candidate interviews |
| `interviewsCleared` | `cleared` and `cleared_at` in the period (the interview itself may be earlier) | as above |
| `placementsCreated` | `placement.created_at` in the period | placement snapshots |
| `placementsJoined` | `placement.joined_at` in the period, whatever the current status | placement snapshots |
| `candidatesAdded` | `candidate.created_at` in the period | candidate's recruiter, team, location |

Activity is attributed with the snapshots taken when it happened (FR-ORG-04), so a recruiter's
past work stays with their old team. A `null` group id means unassigned / no team / no location.

## Needs attention

Current state, independent of the period. Each list returns its exact `total` and the oldest
`NEEDS_ATTENTION_LIMIT` (25) rows.

| Kind | Rule | Read permission |
|---|---|---|
| `submissionStale` | status `submitted` … `interview_completed` and no status change (`coalesce(status_changed_at, submitted_at)`) for `staleSubmissionDays` | `submission:read` |
| `interviewFeedbackMissing` | ended more than `feedbackGraceHours` ago and less than `feedbackLookbackDays` ago, not cancelled/rescheduled/no_invite, and no coach, location or client feedback (the candidate's own feedback does not count) | `interview:read` |
| `placementStalled` | before joining (`confirmed` … `ready`) and either no status change for `placementStallDays` (`reason: no_progress`) or `tentative_start` before today (`reason: start_date_passed`) | `placement:read` |

Each item: `id`, `candidate {id, name}` (name `null` when the candidate itself is not readable),
`recruiter {id, name}`, `since`, `ageDays`, `status`, and `detail` (client and job title; round and
client; tentative start and reason). No rates, phones or emails.

### Thresholds (OD-05 is open)

OD-05 (bench, unresponsive and target thresholds) is waiting on Sales leadership, so these are
conservative placeholders in `apps/api/src/modules/dashboard/dashboard.config.ts`
(`DASHBOARD_THRESHOLDS`). They flag only clearly overdue work. The API returns the values in use,
and the page quotes them above each list.

| Constant | Default |
|---|---|
| `staleSubmissionDays` | 7 |
| `feedbackGraceHours` | 24 |
| `feedbackLookbackDays` | 30 |
| `placementStallDays` | 5 |

"Today" for `start_date_passed` is the database session's `current_date` (UTC on RDS).

## Indexes (migration 0027)

Period columns (`submission.submitted_at`, `interview.starts_at`, `interview.cleared_at` where
cleared, `candidate.created_at`, `placement.joined_at`; `placement (created_at, id)` exists) and
partial indexes for the open rows the needs-attention lists read. The expressions and WHERE
clauses match the service's SQL; change both together.

## Tests

- Hand-calculated totals for every role with `report:read` against a small fixed data set
  (recruiter own, lead team, manager teams, AD/OM/CEO all, location admins their location, HR /
  Accounts / BU Head without submission and interview access).
- Differential: for every fixture user, the totals equal the counts from the list endpoints
  (`/submissions`, `/interviews`, `/placements`, `/candidates`) over the same period.
- RLS only: the same counts with no application predicate, as `eureka_app`.
- Needs-attention rules, ordering, scope and omission per role.
