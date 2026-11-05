# Submissions: list filters and summary

Module: `apps/api/src/modules/submissions`. Visibility (actor snapshot or owned
candidate), rate field policy and the state machine are described in
`docs/placements-api.md`; this file covers the list filters and the summary.

## `GET /api/v1/submissions` (`submission:read`)

Query: `status`, `candidateId`, `recruiterId`, `from`, `to` (submitted_at, `to`
exclusive), `candidate`, `batchId`, `search`, `interviewed`, `stage`, `cursor`, `limit` (1–200, default 50).

- `search`: job title or client name contains the text (case-insensitive, `%`/`_` literal).
- `candidate`: candidate name contains the text (same matching; only names the caller can read). `batchId`: the candidate's training batch. Both apply to `/summary` too.
- `interviewed=true|false`: the submission got an interview — its status is
  `interview_requested`, `interview_scheduled`, `interview_completed` or `selected`,
  or a visible interview exists whose `call_status` is not `cancelled` / `no_invite`.
  A submission later rejected after an interview still counts.
- `stage=screening|l1|l2|l3|final|other|placed`: reached that funnel stage (a live
  interview of that stage), or `placed` (a placement not backed out / failed BGC /
  joining issue).

**Stages** come from the free-text round (`interviewStageSql` in `pipeline.ts`):
"final" anywhere → final; "screen" → screening; a number after L / level / round /
R / tech(nical), or "2nd round" → l1, l2, l3 (3 and up); anything else (manager,
client, HR) → other. The round picker suggests L1/L2/L3 so new rounds classify exactly.

Each item adds `interviewCount` (visible interviews, cancelled / no-invite excluded)
and `lastInterviewAt` (latest `starts_at`, or null), `interviews` (every visible
interview in time order: `{ stage, round, result, callStatus, startsAt }`, cancelled
included) and `placementStatus` (latest placement from this submission, or null).

## `GET /api/v1/submissions/summary` (`submission:read`)

Same filters minus `status`, `interviewed`, `stage`, `cursor`, `limit`. Returns
`{ total, interviewed, byStatus: { <status>: n }, funnel }` for the caller's visible
submissions (every status present, 0 when none). `funnel` =
`{ submitted, interviewed, selected, placed, stages: { <stage>: { held, cleared } } }`:
distinct submissions with a live interview of each stage, and with a cleared one.
Used by the funnel on the Submissions page and the candidate profile's Submissions tab.

## Editing details: `PATCH /api/v1/submissions/:id` (`submission.details:update`)

Lead and above correct what was logged: lead on their team's submissions, manager and
associate director on their hierarchy's, CEO on any. Recruiters keep `submission:update`
for status changes only; status is never edited here (`PATCH /:id/status`).

Body (at least one key; only the keys sent change, `null` clears an optional field):
`{ jobTitle?, clientId?, vendorId?: uuid|null, rate?: number|null, jobId?: uuid|null, submittedAt?: ISO date-time }`.
Returns `{ changed: string[], submission }` (`changed` empty when every value matched).

- 404 not visible; 403 without `submission.details:update` on the actor snapshot, or
  `field_not_permitted` when `rate` is sent without `rate:read` there.
- 409 `submission_placed`: a placement in progress (not backed out / BGC failed) holds the
  client, vendor and rate; correct the placement instead.
- 409 `client_locked`: the client can't change once any interview exists (interviews carry it).
- 422 `invalid_job_title` (1–160), `invalid_rate` (0–1000, two decimals),
  `invalid_submitted_at` (not in the future), `client_not_found`, `vendor_not_found`, and the
  job rules of create (`job_not_found`, `job_client_mismatch`, `job_not_open`; re-checked when
  the job or client changes).
- Enforced again by `authz.edit_submission` (migration 0440). `details_edited_at/by` are
  server-managed; items add `detailsEdited: { at, byName } | null` and `actions.editDetails`,
  `actions.editRate`. Audit `submission.edited` keeps the field names only.

UI: the submission drawer's **Details** section has its own **Edit details** button
(separate from **Next steps**, which moves the status) opening the Edit submission details dialog.

## Concurrency and retries (migration 0507; audit R-10 / R-14)

- **`rowVersion`**: every submission item (list, detail, `PATCH` responses) carries it.
  `eureka.submission.row_version` is server-managed: 1 on insert (the insert guard refuses
  anything else), +1 on every update (status transition, detail edit, any other path).
- **Optional `If-Match: "<rowVersion>"`** on `PATCH /:id` and `PATCH /:id/status`. No header:
  as before (last write wins). Header present and not the current version (or not a version
  at all): **412 `stale`**, nothing changes. Checked after 404/403 and before the 422s; a
  write that lands between the check and the definer's row lock is also 412.
  `PATCH /:id/status` returns `{ id, status, rejectionReason, rowVersion }`; `PATCH /:id`
  returns the new version in `submission.rowVersion` (unchanged when `changed` is empty).
- **`POST /api/v1/submissions`** returns `{ id, duplicateWarning, rowVersion: 1 }` and takes an
  optional **`Idempotency-Key`** (`platform/idempotency.ts`; printable ASCII, 1-200): a retry
  with the same body returns the first response without creating anything; the same key with
  another body is 409 `idempotency_key_reused`; a malformed key is 400 `invalid_idempotency_key`.
  Keys are per user and kept 24 h. The candidate visibility check (404) runs before the key.
- **Duplicate warning under concurrency**: the 90-day check (`authz.recent_submission_exists`,
  per candidate and client) runs under a transaction advisory lock on that pair, so parallel
  submissions of the same candidate to the same client (any of its jobs) are serialised: the
  first gets `duplicateWarning: false`, every later one `true`.
