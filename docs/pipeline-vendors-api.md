# Candidate pipeline, assessments, "not responding" and preferred vendors

Gap list items "Candidate pipeline report", "Notifications: candidate not responding" and "Preferred vendor details"
(Eureka App 4 spec). Migrations `0170_assessments.sql`, `0171_candidate_nonresponse.sql`,
`0172_preferred_vendors.sql`. Code: `apps/api/src/modules/pipeline-report`, `apps/api/src/modules/preferred-vendors`,
`apps/api/src/worker/jobs/candidate-nonresponse.ts`, `apps/web/src/pipelinereport`. Tests:
`apps/api/test/pipeline-vendors.db.int.test.ts`, `apps/api/test/pipeline-vendors.api.int.test.ts`,
`apps/web/src/pipelinereport/PipelineVendors.test.tsx`.

No catalog change: the report uses `report:read` + `candidate:read`, assessments use `submission:read` /
`submission:update`, flags use `candidate:read` / `candidate:update`, and vendors use the existing
`vendor.preferred:create` (recruiter own, lead own) and `vendor.preferred:read` (lead team, manager and associate
director hierarchy, CEO org).

All bodies and queries are strict zod schemas (unknown keys: 422). Errors are RFC 9457 problems with the code in
`detail`. Audit rows carry ids, codes and changed field names only (rule 5).

## Candidate pipeline report

**PV-1 `GET /api/v1/reports/pipeline`** (`report:read`; the service also requires `candidate:read`, so BU Head gets
403). Rate limit 20 requests per user per minute (429); org-wide callers get the 60 s statement timeout (503 when hit).

Rows: one per candidate the caller **owns** under `candidate:read` (never through Open to all teams or the open Hot
List), narrowed to the caller's `report:read` scope, exactly like the dashboard: recruiter own candidates, lead team,
manager and AD hierarchy, location roles their location, CEO / HR / Accounts org. Submissions, interviews,
assessments, placements and checklist items are read under their own RLS, so a count only includes rows the caller
could list.

Query (all optional): `from`, `to` (calendar days, UTC, `to` inclusive, both or neither, at most 366 days),
`technologyId`, `teamId`, `recruiterId`, `locationId`, `marketingStatus`, `stage`, `notResponding=true|false`,
`limit` (1-200, default 50), `offset` (0-10000).

With a period, counts cover the period and only candidates with pipeline activity in it are listed (a submission,
a live interview, a cleared interview, an assessment, the marketing start date, a placement created or joined).
`stage` is always the candidate's current stage over all time.

```json
{
  "period": { "from": "2030-03-01", "to": "2030-03-31" } | null,
  "total": 5,
  "funnel": { "marketing": 4, "submitted": 3, "interviewing": 1, "assessment": 1, "confirmed": 2, "paperwork": 2, "joined": 1 },
  "notResponding": 1,
  "byStage": { "paperwork": 1, "submitted": 1, "not_started": 1, "joined": 1, "marketing": 1 },
  "items": [{
    "candidate": { "id", "name" }, "technology": { "id", "name" }, "team": { "id", "name" },
    "recruiter": { "id", "name" } | null, "location": { "id", "name" },
    "marketingStatus": "active", "marketingStartDate": "2030-03-01" | null,
    "submissions": { "count", "lastAt" }, "interviews": { "count", "cleared", "lastAt" },
    "assessments": { "count", "passed", "lastOn" },
    "placement": { "id", "status", "confirmedAt", "tentativeStart", "joinedAt", "paperwork": { "done", "total" } | null } | null,
    "notResponding": false, "stage": "paperwork"
  }],
  "limit": 50, "offset": 0
}
```

**PV-2 stages** (furthest reached, in this order of precedence): `joined` (latest placement joined), `paperwork`
(latest placement in paperwork, background check or ready), `confirmed` (latest placement confirmed), `assessment`
(any assessment not cancelled), `interviewing` (any interview not cancelled, rescheduled or without invite),
`submitted` (any submission), `marketing` (marketing start date set, or status active, on hold, full of interviews,
confirmation or bench), `not_started`. Backed-out and BGC-failed placements are ignored. The latest placement is the
newest of the others. `paperwork.done/total` counts required checklist items verified or waived.

Funnel: candidates with marketing started (stage not `not_started`), with submissions / interviews / assessments in
the period (or ever), with a placement (confirmed), with a placement in paperwork or later, joined. `byStage` counts
the current stages of the listed set.

Screen: **Candidate Pipeline** (sidebar, Insights): period, technology, location, stage and "not responding only"
filters, funnel tiles, one row per candidate, paging.

## Assessments ("gliders")

Online assessments a vendor or client sends for a submission (Glider, HackerRank, Codility, a vendor portal, other).
Table `eureka.assessment`: `platform`, `status` (`assigned`, `completed`, `passed`, `failed`, `expired`,
`cancelled`), `assignedOn`, optional `dueOn`, `completedOn` (required for completed, passed, failed), `score` 0-100.
No free text. The candidate is a server snapshot of the submission's candidate. Never deleted: cancel instead.

| Route | Permission | Notes |
|---|---|---|
| **PV-3** `GET /api/v1/submissions/:id/assessments` | `submission:read` | 404 unless the submission is listable by the caller (actor snapshot or owned candidate). `{ items, actions: { create, update } }` |
| `POST /api/v1/submissions/:id/assessments` | `submission:update` | 404 as above; 403 unless `submission:update` covers the submission's actor snapshot (the rule submission status changes follow); 422 `submission_closed` on a rejected or withdrawn submission, `completed_on_required`, `invalid_assessment`, `limit_reached` (20 per submission). 201 with the assessment |
| **PV-4** `PATCH /api/v1/assessments/:id` | `submission:update` | Full replacement of the editable fields. `If-Match: "<rowVersion>"` (428 without, 412 stale). Same 404/403 |

RLS: an assessment is readable wherever its submission is. Writes only through `authz.assessment_create` and
`authz.assessment_update` (definer; they repeat the 404/403 checks in the database); a guard trigger refuses every
other writer, stamps the server-managed columns and keeps submission, candidate and creator immutable.

Screen: **Assessments** section in the submission drawer (list, Record assessment, Edit).

## Candidate not responding

**PV-5 `GET /api/v1/candidates/:id/non-response`** (`candidate:read`; 404 unless the candidate is readable, Open to
all teams included): `{ current: Flag | null, history: Flag[] (last 10 resolved), actions: { flag, resolve } }`, with
`Flag = { id, reason, status, resolution, flaggedAt, flaggedBy, resolvedAt, holdReachedAt, candidateWarnedAt,
candidateHoldNoticeAt }`.

**PV-6** `POST /api/v1/candidates/:id/non-response` `{ reason }` and `POST /api/v1/candidates/:id/non-response/resolve`
`{ resolution }` (`candidate:update`). Only Sales who **own** the candidate under `candidate:update` (its recruiter,
the lead of its team, the manager and AD above): 404 when not readable, 403 otherwise (also in the database). Reasons:
`no_reply_calls`, `no_reply_messages`, `missed_interview`, `missed_assessment`, `other`. Resolutions: `responded`,
`flagged_in_error`. 409 `already_flagged` (one open flag per candidate), 422 `not_flagged`,
`candidate_not_marketed` (placed, terminated or stopped candidates). 201 `{ id }`.

**PV-7 What happens** (migration 0171, worker jobs in `docs/notifications.md`):

1. Flagging emits `candidate.not_responding` (stage `warning`) to the candidate's recruiter and team lead (inbox +
   email), and queues the **warning email to the candidate** (personal email): "Please reply to your recruiter within
   N days. If we do not hear from you, your marketing will be put on hold."
2. A flag still open `NONRESPONSE_HOLD_DAYS` (default 3) New York days later reaches the **hold stage** once (daily
   job `candidate-nonresponse`, 07:40 New York): a second `candidate.not_responding` (stage `hold`: "decide whether
   to put marketing on hold or stop it") and the candidate's **final notice**.
3. Marketing status is never changed automatically: Sales put the candidate on hold or stop marketing with the
   existing status change.

**PV-8 Candidate emails**: sent by the worker job `candidate-nonresponse-mail` (every tick, one run key per flag and
stage) with the candidate-facing transport of the interview feedback emails (`FEEDBACK_MAIL_MODE`,
`FEEDBACK_FROM_EMAIL`); without it no candidate email is sent (the staff notices still are). Fixed text, no recruiter,
client or reason. The address is read inside the send transaction under a row lock on the flag, so a flag resolved
meanwhile is never mailed; each stage is mailed at most once, only within 14 days of the stage, and never for placed,
terminated or stopped candidates or candidates without a personal email.

Screen: **Responsiveness** card on the candidate profile (flag with a reason, "Candidate responded", "Flagged in
error", earlier flags); "Not responding" badge and filter on the pipeline screen.

## Preferred vendors

Table `eureka.preferred_vendor`: `vendorName` (1-200), optional `vendorId` (the vendor list), `contactName`,
`contactEmail`, `contactPhone` (E.164), `technologyId`, `clients` (500), `notes` (2000), `archived`, row version. The
owner is the creating user.

**Visibility (RLS)**: the owner, and holders of `vendor.preferred:read` over the owner: org
(CEO); team (a lead: the current members of the teams they lead or belong to); hierarchy (manager, AD: users below
them in the reporting line and the current members of the teams in their subtree). A recruiter who moves teams is seen
by the new lead. Recruiters never see each other's entries.

| Route | Permission | Notes |
|---|---|---|
| **PV-9** `GET /api/v1/preferred-vendors?q=&ownerId=&technologyId=&archived=&limit=&offset=` | either vendor permission (403 otherwise) | `{ items, total, owners, actions: { create } }`; each item has `owner`, `actions: { edit, archive }` (owner only). `q` matches vendor name, contact name or clients |
| `GET /api/v1/preferred-vendors/:id` | either | 404 when not visible |
| **PV-10** `POST /api/v1/preferred-vendors` | `vendor.preferred:create` | 201; 409 `vendor_exists` (same name, case-insensitive, among the owner's active entries); 422 `limit_reached` (500 active per owner) |
| **PV-11** `PATCH /api/v1/preferred-vendors/:id` | `vendor.preferred:create` | Full replacement; `If-Match` (428/412); 404 not visible, 403 not the owner; 422 `vendor_archived` |
| **PV-12** `DELETE /api/v1/preferred-vendors/:id` | `vendor.preferred:create` | Archives (204); owner only. Archived entries stay readable with `archived=true` |

Writes only through `authz.preferred_vendor_create` / `_update` / `_archive` (definer, same checks); a guard trigger
refuses every other writer. Contact details and notes never reach `audit_event` (the API audits ids and field names).

Screen: **Preferred Vendors** (sidebar, Workspace): search, recruiter filter (for superiors), archived toggle, Add /
Edit dialog, Archive.

## Decisions and open questions

- The pipeline lists only candidates the caller owns (like every report), not Open-to-all-teams candidates of other teams.
- Assessments are recorded by whoever may change the submission's status (the actor's hierarchy), not by the
  candidate's owner when another team submitted it.
- "Recruiter / TL" for the not-responding notice: the candidate's current recruiter and its team's lead (no manager).
- Hold delay `NONRESPONSE_HOLD_DAYS` (worker, default 3, 1-60) is a placeholder until Sales leadership decide (OD-05).
- The candidate email wording above is a draft for Sales to approve.
- Superiors read preferred vendors; they do not edit them. Managers and ADs cannot add entries (catalog unchanged).
