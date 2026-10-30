# Submissions: list filters and summary

Module: `apps/api/src/modules/submissions`. Visibility (actor snapshot or owned
candidate), rate field policy and the state machine are described in
`docs/placements-api.md`; this file covers the list filters and the summary.

## `GET /api/v1/submissions` (`submission:read`)

Query: `status`, `candidateId`, `recruiterId`, `from`, `to` (submitted_at, `to`
exclusive), `search`, `interviewed`, `cursor`, `limit` (1–200, default 50).

- `search`: job title or client name contains the text (case-insensitive, `%`/`_` literal).
- `interviewed=true|false`: the submission got an interview — its status is
  `interview_requested`, `interview_scheduled`, `interview_completed` or `selected`,
  or a visible interview exists whose `call_status` is not `cancelled` / `no_invite`.
  A submission later rejected after an interview still counts.

Each item adds `interviewCount` (visible interviews, cancelled / no-invite excluded)
and `lastInterviewAt` (latest `starts_at`, or null).

## `GET /api/v1/submissions/summary` (`submission:read`)

Same filters minus `status`, `interviewed`, `cursor`, `limit`. Returns
`{ total, interviewed, byStatus: { <status>: n } }` (every status present, 0 when none)
for the caller's visible submissions. Used by the candidate profile's Submissions tab.
