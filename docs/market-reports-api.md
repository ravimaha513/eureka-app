# Market reports API (CEO market reports, gap L3)

Point-in-time candidate counts for planning the next batches: how many candidates are in market and how
many are placed, by technology, batch or location, plus allocation counts (candidates per team, lead or
recruiter). Built in migration `0120_market_reports.sql`; UI: Reports page, **Market** tab
(`apps/web/src/employees/MarketReport.tsx`).

The dashboard (`docs/dashboards-api.md`) counts activity in a period; this report counts the candidates as
they are now.

## Access

| Permission | Who (scope) |
|---|---|
| `report.market:read` (new) | CEO (org), Associate Director and Manager (hierarchy), Lead (team), Location Incharge and Location Ops Admin (their location) |
| `report:export` (existing) | additionally needed for the CSV: CEO (org), Associate Director and Manager (hierarchy), Lead (team) |

Recruiters, HR, Associate HR, Accounts, BU Head, Immigration, Interview Coach, Interview Coordinator,
Documents Team and Org Admin hold no `report.market:read`: 403. Location roles see the
tab but hold no `report:export`, so they cannot export.

## Scope rule

A candidate is counted when the caller **owns** it under `report.market:read`: recruiter, team or location of
the candidate in the caller's grant (the engine's `ownsCandidate`), never through the Open-to-all-teams rule.
The CSV further requires ownership under `report:export`. Both are applied in the database by
`authz.market_report(group, placed_from, placed_to, export)`:

- `SECURITY INVOKER` (runs as `eureka_app` under the `candidate_read`, `placement_read` and `batch_read`
  policies), pinned `search_path`, `EXECUTE` for `eureka_app` only (not PUBLIC, not the worker).
- Scope arrays (`authz.has_org`, `recruiter_ids`, `team_ids`, `location_ids`) are computed once per call in a
  materialized CTE (rule 3), and the query text is constant (`EXECUTE ... USING`).
- Returns counts and group labels only: no names, phones, emails or rates.

## Definitions

| Count | Meaning |
|---|---|
| Candidates | every candidate in scope, any status |
| In market | `active`, `full_of_interviews` (the actively marketed set, `IN_MARKET_STATUSES` = `MARKETABLE_STATUSES`) |
| Placed (on project) | status `placed` (joined, on a project) |
| Per status | one count per marketing status (`CANDIDATE_STATUSES` order) |
| Placed in period | candidates with a placement whose `joined_at` falls on a day between `placedFrom` and `placedTo` inclusive, in America/New_York; either bound may be open; `null` when no window was asked for |

Groups use the candidate's current values: `technology`, `batch` (`candidate.batch_id`; label = batch name, else
"technology · location · Mon YYYY"), `location`, `team`, `lead` (the lead of the candidate's team) and
`recruiter`. Candidates without a value (no batch, no recruiter) form one group with `id: null`, listed last.
Groups are sorted by candidates, then name.

## MR-1 `GET /api/v1/reports/market`

Query (strict): `groupBy` (`technology` default, `batch`, `location`, `team`, `lead`, `recruiter`),
`placedFrom`, `placedTo` (`YYYY-MM-DD`, from ≤ to, at most five years). 422 otherwise.

```json
{
  "asOf": "2026-10-17T12:00:00.000Z",
  "groupBy": "technology",
  "placedBetween": { "from": "2026-09-01", "to": "2026-09-30", "timeZone": "America/New_York" },
  "inMarketStatuses": ["active", "full_of_interviews"],
  "placedStatuses": ["placed"],
  "statuses": ["in_training", "active", "on_hold", "stopped", "full_of_interviews", "confirmation", "placed", "bench", "terminated"],
  "totals": { "candidates": 120, "inMarket": 64, "placed": 30, "placedInPeriod": 6, "byStatus": { "active": 50, "...": 0 } },
  "groups": [{ "id": "…", "name": "Java", "candidates": 80, "inMarket": 40, "placed": 22, "placedInPeriod": 4, "byStatus": { } }]
}
```

`placedBetween` is `null` and every `placedInPeriod` is `null` without a window. 30 requests per user per
minute (429); 60 s statement timeout (503).

## MR-2 `POST /api/v1/reports/market/export`

Body: the same fields as MR-1 (JSON). POST so it is CSRF-protected and audited, like the Hot List export.
Needs `report.market:read` and `report:export`. Returns `text/csv` (`market-by-<group>-<date>.csv`, BOM, CRLF,
formula cells neutralised): one line per group plus a `Total` line; columns group, Candidates, In market,
Placed (on project), Placed `<from>` to `<to>` (with a window), then one column per status. Headers
`x-export-rows` (groups) and `x-export-truncated` (always `false`: groups are bounded).
Rate limit: 5 exports per user per 10 minutes (shared constants with the Hot List export).

Audit (`audit_event`, same transaction): action `report.export`, entity type `candidate`, changes
`{ report: "market", groupBy, placedFrom, placedTo, rows, candidates, truncated }`. No candidate data.

## Index (migration 0120)

`placement_candidate_joined ON placement (candidate_id, joined_at) WHERE joined_at IS NOT NULL` for the
placed-between probe.

## Tests

- `apps/api/test/market-reports.api.int.test.ts`: access matrix from the catalog, a per-role differential against
  the TypeScript engine over every fixture candidate, groupings (technology, batch, lead, recruiter), New York day
  bounds, open windows, export content and audit, export 403 for location roles, rate limit, function ACL and
  `search_path`, NULL-safe argument checks, scope arrays once per call, and RLS still limiting a forged grant.
- `packages/shared/src/marketReport.test.ts`: hand-written grant expectations and status sets.
- `apps/web/src/employees/MarketReport.test.tsx`: tab visibility, table and totals, regrouping, placed-between,
  validation, export and rate-limit message.

## Decisions (conservative defaults; confirm with Ravi)

- New permission `report.market:read` rather than reusing `report:read` (which also reaches recruiters, HR,
  Accounts and BU Head, who the spec does not list).
- No separate offshore manager grant: the spec's "offshore manager" is the Associate Director (the
  `offshore_manager` role was removed in 0090).
- Location roles view but do not export (they hold no `report:export`; granting it would also open the Hot List
  and joinings/exits exports to them).
- "Placed" counts the current `placed` status; "placed between" counts candidates by placement `joined_at`
  (the moment the placement was marked joined) on New York calendar days, so location roles (no `assignment:read`)
  get the same numbers as Sales.
