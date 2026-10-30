# Submissions: list filters and summary

Module: `apps/api/src/modules/submissions`. Visibility (actor snapshot or owned
candidate), rate field policy and the state machine are described in
`docs/placements-api.md`; this file covers the list filters and the summary.

## `GET /api/v1/submissions` (`submission:read`)

Query: `status`, `candidateId`, `recruiterId`, `from`, `to` (submitted_at, `to`
exclusive), `search`, `interviewed`, `stage`, `cursor`, `limit` (1–200, default 50).

- `search`: job title or client name contains the text (case-insensitive, `%`/`_` literal).
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
