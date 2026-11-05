# Name search performance: baseline and R-13 result

Measurements for R-13 (findings G-04, A-05, B-06; E-09 interviews is out of scope here). Before = the
schema at 6db3a53 with no trigram index; after = migration `0479_name_search_trgm.sql` (pg_trgm + GIN
trigram indexes `person_name_trgm`, `applicant_name_trgm` on `(first_name || ' ' || last_name)`).
The SQL text the services send is the same before and after (it is now written by `nameSearch()` in
`apps/api/src/platform/sql.ts`; the only textual change is an explicit `ESCAPE '\'` on the candidate
list, which is PostgreSQL's default), so the comparison isolates the index.

## Environment

- **Database:** local PostgreSQL 16.15 (Ubuntu build) on 127.0.0.1:55433, data on tmpfs, `fsync=off`,
  `shared_buffers=512MB`, `work_mem=4MB`, `jit=off`. Every buffer is a cache hit (no disk I/O), so the
  numbers are CPU-bound lower bounds, not production latencies.
- **Hardware:** container with 4 vCPU and 15 GB RAM. The cluster was shared with other agents' test
  runs while measuring, so timings carry noise: repeated runs of an unchanged query moved by up to
  ±30 %. Read differences smaller than that as "no change".
- **Data:** `pnpm --filter @eureka/api db:seed-load` (default volume): 50,000 persons / candidates in
  30 teams (167 users), 58,624 submissions, 16,421 interviews, 858 placements. Scratch additions for
  this measurement only: a `ceo` user (`perf-ceo@eureka.example`, org scope for every list); 5 persons
  (plus 1 in lead-01's team) renamed `Zebrowski` (the "find one person" search); 50,000 applicants and
  10,000 employee rows (the load seed creates none; inserted with triggers off), then `VACUUM ANALYZE`.
  The seed draws names from 40 first × 28 last names, so the data has only 280 distinct full names
  (about 180 people each): common-name terms are far less selective than in real data.
- **Users:** org scope = `perf-ceo` (candidate, Hot List, submission, placement, employee read at org);
  team scope = `load-lead-01` (`salesLine("team")`); employees and applicants as `load-hr-01` (org).
- **Terms:** `Aarav Agarwal` (one full name, ~180 rows), `Kumar` (one surname, ~1,800 rows), `an`
  (2 characters, matches most names), `Zebrowski` (5–6 rows), `zzqx` (no match).

## Method

A script booted the real API (`createApp`, `AUTH_MODE=dev`) against the scratch database, signed in as
each user and called the list endpoint with the search term (`GET /api/v1/candidates?search=`,
`?sort=name`, `/hotlist?search=`, `/submissions?candidate=`, `/placements?candidate=`,
`/employees?search=`, `/applicants?search=`; `limit=50`). It recorded the exact SQL and parameters
the service sent, then ran `EXPLAIN (ANALYZE, BUFFERS)` on that SQL five times in a rolled-back
transaction as the API runs it: `SET LOCAL ROLE eureka_app` with `eureka.user_id` set to the caller.
For the Hot List page and export, which run their query by `EXECUTE ... USING` inside
`authz.hotlist_page` / `authz.hotlist_export`, the inner query (from `db/functions/authz/*.sql`) was
EXPLAINed as `authz_definer` with the same bound values. `hotlist_page` rows were taken with the
`everyone` (open) Hot List policy, which is the only policy that routes to it; with the default `team`
policy the Hot List uses the candidate-list SQL measured above. `hotlist_export` (always the definer
function) was EXPLAINed directly with the API's parameters (cap 50,001) rather than called, because the
export endpoint is rate limited. "Exec" is the median EXPLAIN ANALYZE execution time of five runs;
"HTTP" is the median of five `app.inject` round trips after one warm-up call (in-process, includes
auth, the Hot List audit row and serialisation).

## Results

| Query (user) | Term | Rows | Exec before (ms) | Exec after (ms) | After/before | Index used after | HTTP before (ms) | HTTP after (ms) |
|---|---|--:|--:|--:|--:|---|--:|--:|
| hotlist_export/org | `Aarav Agarwal` | 146 | 26.1 | 15.3 | 0.59 | yes (person_name_trgm) | – | – |
| hotlist_export/org | `Kumar` | 1469 | 42.1 | 30.6 | 0.73 | yes (person_name_trgm) | – | – |
| hotlist_export/org | `an` | 10144 | 110.6 | 101.0 | 0.91 | no | – | – |
| hotlist_export/org | `Zebrowski` | 5 | 19.5 | 11.5 | 0.59 | yes (person_name_trgm) | – | – |
| hotlist_export/org | `zzqx` | 0 | 19.5 | 11.6 | 0.60 | yes (person_name_trgm) | – | – |
| hotlist_export/team | `Aarav Agarwal` | 47 | 24.9 | 13.5 | 0.54 | yes (person_name_trgm) | – | – |
| hotlist_export/team | `Kumar` | 48 | 30.4 | 19.5 | 0.64 | yes (person_name_trgm) | – | – |
| hotlist_export/team | `an` | 47 | 65.6 | 48.6 | 0.74 | no | – | – |
| hotlist_export/team | `Zebrowski` | 1 | 20.6 | 12.2 | 0.59 | yes (person_name_trgm) | – | – |
| hotlist_export/team | `zzqx` | 0 | 19.6 | 12.5 | 0.64 | yes (person_name_trgm) | – | – |
| candidates/org | `Aarav Agarwal` | 50 | 139.8 | 112.6 | 0.81 | no | 139.7 | 120.9 |
| candidates/org | `Kumar` | 50 | 233.0 | 158.3 | 0.68 | no | 183.1 | 152.9 |
| candidates/org | `an` | 50 | 3.9 | 3.2 | 0.81 | no | 35.2 | 21.7 |
| candidates/org | `Zebrowski` | 6 | 116.1 | 116.3 | 1.00 | no | 139.9 | 107.0 |
| candidates/org | `zzqx` | 0 | 259.5 | 242.6 | 0.93 | no | 270.0 | 262.9 |
| candidates-sort-name/org | `Aarav Agarwal` | 50 | 119.0 | 118.1 | 0.99 | no | 152.3 | 143.6 |
| candidates-sort-name/org | `Kumar` | 50 | 162.1 | 149.6 | 0.92 | no | 194.6 | 151.1 |
| candidates-sort-name/org | `an` | 50 | 176.3 | 195.0 | 1.11 | no | 181.4 | 153.1 |
| candidates-sort-name/org | `Zebrowski` | 6 | 114.4 | 108.0 | 0.94 | no | 116.9 | 111.7 |
| candidates-sort-name/org | `zzqx` | 0 | 98.7 | 104.3 | 1.06 | no | 117.2 | 108.6 |
| submissions/org | `Aarav Agarwal` | 50 | 135.6 | 133.5 | 0.98 | no | 135.0 | 129.8 |
| submissions/org | `Kumar` | 50 | 246.2 | 222.0 | 0.90 | no | 200.4 | 181.3 |
| submissions/org | `an` | 50 | 13.8 | 8.6 | 0.62 | no | 27.3 | 21.4 |
| submissions/org | `Zebrowski` | 8 | 152.6 | 106.1 | 0.70 | no | 142.2 | 126.0 |
| submissions/org | `zzqx` | 0 | 543.9 | 466.5 | 0.86 | no | 480.1 | 468.3 |
| placements/org | `Aarav Agarwal` | 3 | 14.3 | 9.4 | 0.66 | no | 33.7 | 32.8 |
| placements/org | `Kumar` | 31 | 10.2 | 10.1 | 0.99 | no | 36.9 | 31.1 |
| placements/org | `an` | 50 | 4.4 | 4.5 | 1.02 | no | 31.6 | 31.7 |
| placements/org | `Zebrowski` | 0 | 9.6 | 14.3 | 1.49 | no | 31.3 | 33.7 |
| placements/org | `zzqx` | 0 | 9.9 | 10.8 | 1.09 | no | 38.5 | 41.1 |
| candidates/team | `Aarav Agarwal` | 50 | 49.3 | 56.4 | 1.14 | no | 66.9 | 77.0 |
| candidates/team | `Kumar` | 50 | 52.2 | 54.0 | 1.03 | no | 65.9 | 73.6 |
| candidates/team | `an` | 50 | 14.3 | 20.1 | 1.41 | no | 31.3 | 35.4 |
| candidates/team | `Zebrowski` | 1 | 40.0 | 42.5 | 1.06 | no | 59.4 | 61.7 |
| candidates/team | `zzqx` | 0 | 38.5 | 48.9 | 1.27 | no | 63.7 | 78.0 |
| candidates-sort-name/team | `Aarav Agarwal` | 50 | 50.4 | 51.0 | 1.01 | no | 72.3 | 97.5 |
| candidates-sort-name/team | `Kumar` | 50 | 45.1 | 46.3 | 1.03 | no | 63.1 | 76.1 |
| candidates-sort-name/team | `an` | 50 | 56.3 | 56.9 | 1.01 | no | 75.2 | 81.2 |
| candidates-sort-name/team | `Zebrowski` | 1 | 46.1 | 42.0 | 0.91 | no | 63.2 | 55.4 |
| candidates-sort-name/team | `zzqx` | 0 | 46.6 | 46.6 | 1.00 | no | 64.8 | 73.5 |
| submissions/team | `Aarav Agarwal` | 50 | 100.5 | 129.5 | 1.29 | no | 113.8 | 109.4 |
| submissions/team | `Kumar` | 50 | 94.6 | 97.7 | 1.03 | no | 107.5 | 124.5 |
| submissions/team | `an` | 50 | 93.7 | 101.2 | 1.08 | no | 104.8 | 132.8 |
| submissions/team | `Zebrowski` | 2 | 87.6 | 119.6 | 1.36 | no | 96.7 | 131.8 |
| submissions/team | `zzqx` | 0 | 82.3 | 113.1 | 1.37 | no | 101.2 | 107.4 |
| placements/team | `Aarav Agarwal` | 1 | 28.5 | 30.4 | 1.07 | no | 44.4 | 63.4 |
| placements/team | `Kumar` | 3 | 28.1 | 27.6 | 0.98 | no | 44.3 | 63.6 |
| placements/team | `an` | 2 | 31.0 | 30.0 | 0.97 | no | 45.7 | 46.7 |
| placements/team | `Zebrowski` | 0 | 27.3 | 28.8 | 1.05 | no | 56.6 | 45.7 |
| placements/team | `zzqx` | 0 | 27.0 | 28.4 | 1.05 | no | 45.4 | 54.1 |
| employees/org(hr) | `Aarav Agarwal` | 39 | 69.4 | 69.5 | 1.00 | no | 69.9 | 79.3 |
| employees/org(hr) | `Kumar` | 50 | 118.6 | 116.6 | 0.98 | no | 96.9 | 101.0 |
| employees/org(hr) | `an` | 50 | 114.4 | 97.7 | 0.85 | no | 107.4 | 102.0 |
| employees/org(hr) | `Zebrowski` | 6 | 50.9 | 58.2 | 1.14 | no | 58.8 | 101.2 |
| employees/org(hr) | `zzqx` | 0 | 54.9 | 47.7 | 0.87 | no | 59.7 | 65.6 |
| applicants/org(hr) | `Aarav Agarwal` | 50 | 15.8 | 16.1 | 1.02 | no | 23.4 | 24.3 |
| applicants/org(hr) | `Kumar` | 50 | 3.9 | 3.9 | 0.99 | no | 9.3 | 13.8 |
| applicants/org(hr) | `an` | 50 | 1.9 | 1.2 | 0.63 | no | 8.5 | 6.8 |
| applicants/org(hr) | `Zebrowski` | 11 | 15.3 | 13.2 | 0.86 | no | 21.8 | 23.2 |
| applicants/org(hr) | `zzqx` | 0 | 30.1 | 33.7 | 1.12 | no | 49.9 | 45.4 |
| hotlist_page/org | `Aarav Agarwal` | 50 | 19.7 | 10.1 | 0.51 | yes (person_name_trgm) | 31.1 | 24.5 |
| hotlist_page/org | `Kumar` | 50 | 23.6 | 17.4 | 0.74 | yes (person_name_trgm) | 39.6 | 29.2 |
| hotlist_page/org | `an` | 50 | 60.4 | 57.6 | 0.95 | no | 72.5 | 63.7 |
| hotlist_page/org | `Zebrowski` | 5 | 15.0 | 12.2 | 0.81 | yes (person_name_trgm) | 39.3 | 27.8 |
| hotlist_page/org | `zzqx` | 0 | 17.1 | 8.4 | 0.49 | yes (person_name_trgm) | 30.5 | 19.1 |
| hotlist_page/team | `Aarav Agarwal` | 50 | 25.7 | 10.6 | 0.41 | yes (person_name_trgm) | 29.5 | 22.4 |
| hotlist_page/team | `Kumar` | 50 | 41.5 | 20.2 | 0.49 | yes (person_name_trgm) | 35.8 | 36.0 |
| hotlist_page/team | `an` | 50 | 66.7 | 61.9 | 0.93 | no | 58.9 | 61.5 |
| hotlist_page/team | `Zebrowski` | 5 | 21.7 | 8.0 | 0.37 | yes (person_name_trgm) | 28.5 | 19.1 |
| hotlist_page/team | `zzqx` | 0 | 25.9 | 7.8 | 0.30 | yes (person_name_trgm) | 28.9 | 17.8 |

Rows = rows returned after the change (page of 50, or the export's full set); identical before.

## Findings

1. **Definer paths use the index.** `authz.hotlist_page` (open Hot List) and `authz.hotlist_export`
   now plan a `Bitmap Index Scan on person_name_trgm` for every term of 3+ characters. Execution time
   fell to 0.30–0.81× of before (team-scope page: 21.7 → 8.0 ms for `Zebrowski`, 25.9 → 7.8 ms for a
   miss; export: 19.5 → 11.5 ms). After the change the search itself costs well under 1 ms in those plans;
   what remains is mostly the `s` CTE that resolves the caller's scope (about 7–8 ms, see plans).
2. **eureka_app paths cannot use the index (main finding).** The candidate list (and the Hot List
   under the default `team` policy, which uses the same SQL), submissions, placements, employees and
   applicants run as `eureka_app` under RLS. The `person_read` / applicant read policies are
   security quals, and the planner may only make a user qual an index condition ahead of them if its
   operator is `LEAKPROOF`. `~~*` (ILIKE) is not, and only a superuser can mark a function leakproof
   (rule 7 rules that out). So these plans are unchanged: the before/after differences in those rows
   are within the ±30 % noise and no plan contains `person_name_trgm` /
   `applicant_name_trgm`. `apps/api/test/name-search.db.int.test.ts` pins this behaviour: it checks
   that the index is used as `authz_definer` and is not used as `eureka_app`.
3. **Where the app-path time goes.** On the org-scope candidate list the cost is not the ILIKE. It is
   a walk of all 50,000 visible candidates in `candidate_pkey` order (for `ORDER BY c.id LIMIT 51`),
   and for each one a `person_pkey` probe whose `person_read` RLS check runs a correlated
   `EXISTS (candidate ...)` sub-plan again (`loops=50000`, about 350k buffer hits, 116–260 ms for rare
   or missing names). Submissions (org) behave the same way: 466–544 ms for a miss. Frequent terms
   (`an`) are fast because the LIMIT fills early. Team scope is cheaper (40–130 ms) because the scope
   predicate narrows the walk.
4. **Short terms.** `an` (2 characters) has no complete trigram, so the definer paths fall back to the
   sequential scan they used before (0.93–0.95×). No minimum length was added (it would be an API
   change).
5. **Cost of the change.** The index builds in about 0.12 s per table at this volume, inside the
   migration transaction: `CREATE INDEX` without `CONCURRENTLY`, which blocks writes to
   person/applicant while it runs. Sizes: `person_name_trgm` 1.4 MB (heap 4.5 MB),
   `applicant_name_trgm` 1.4 MB (heap 6.2 MB). GIN `fastupdate` is on (the default), so each name
   write adds one pending-list entry. Applying the migration as a non-superuser database owner was
   checked: a fresh `CREATEROLE CREATEDB` role owning the database applied 0479 through
   `src/db/migrate.ts`, and the extension landed in `public`, owned by that role. The schema is pinned
   because earlier migrations leave the migrator session's `search_path` on `eureka`: an unpinned
   `CREATE EXTENSION` put pg_trgm in `eureka`.

### Follow-up (not done here: needs a security decision)

To make the eureka_app lists index-backed, the name match has to run where RLS does not wrap it. One
option is a `SECURITY DEFINER` function, e.g. `authz.candidate_name_matches(pattern) RETURNS uuid[]`,
that applies the caller's `candidate:read` scope itself (as `hotlist_page` does) and is used as
`c.id = ANY ((SELECT authz.candidate_name_matches($n))::uuid[])` (InitPlan, rule 3), with the ILIKE
kept as a recheck. Without that scope check it would reveal whether a name exists outside the caller's
scope (the same kind of oracle as A-01), so it needs `eureka-security-gate` review. Each list
(submission, placement and employee scopes differ) needs its own variant. Finding 3, the per-row
`person_read` EXISTS, is a separate and probably larger win for the org-scope lists: it applies with
or without a search term.

## Captured SQL (as sent by the services)

#### hotlist_export/org

```sql
authz.hotlist_export inner query
```

Parameters (term `Zebrowski`): `[null, null, null, "%Zebrowski%", 50001, null, null, null, null, null, {"priority": null, "teamId": null, "recruiterId": null, "inPerson": null, "ghLocationId": null, "sort": null}]`

#### hotlist_export/team

```sql
authz.hotlist_export inner query
```

Parameters (term `Zebrowski`): `[null, null, null, "%Zebrowski%", 50001, null, null, null, null, null, {"priority": null, "teamId": null, "recruiterId": null, "inPerson": null, "ghLocationId": null, "sort": null}]`

#### candidates/org

```sql
SELECT c.id, p.first_name, p.last_name, p.phone_e164, p.dob_year, t.name AS technology,
           c.team_id, tm.name AS team_name, c.recruiter_id, u.display_name AS recruiter_name,
           c.location_id, l.name AS location_name, c.visibility, c.marketing_status, c.priority,
           c.marketing_start_date::text, c.technical_rating, c.row_version,
           c.batch_id, b.name AS batch_name, b.start_month::text AS batch_month, bt.name AS batch_technology, bl.name AS batch_location,
           c.visa_category, c.documents_status, c.gh_remote, c.gh_location_id, gl.name AS gh_location_name,
           c.team_assigned_at, (c.resume_url IS NOT NULL) AS resume_link,
           lu.display_name AS lead_name, c.in_person_ok
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    LEFT JOIN eureka.team tm ON tm.id = c.team_id
    JOIN eureka.location l ON l.id = c.location_id
    LEFT JOIN eureka.app_user u ON u.id = c.recruiter_id
    LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
    LEFT JOIN eureka.batch b ON b.id = c.batch_id
    LEFT JOIN eureka.technology bt ON bt.id = b.technology_id
    LEFT JOIN eureka.location bl ON bl.id = b.location_id
    LEFT JOIN eureka.location gl ON gl.id = c.gh_location_id WHERE true AND (p.first_name || ' ' || p.last_name) ILIKE $1 ESCAPE '\' ORDER BY c.id LIMIT $2
```

Parameters (term `Zebrowski`): `["%Zebrowski%", 51]`

#### candidates-sort-name/org

```sql
SELECT c.id, p.first_name, p.last_name, p.phone_e164, p.dob_year, t.name AS technology,
           c.team_id, tm.name AS team_name, c.recruiter_id, u.display_name AS recruiter_name,
           c.location_id, l.name AS location_name, c.visibility, c.marketing_status, c.priority,
           c.marketing_start_date::text, c.technical_rating, c.row_version,
           c.batch_id, b.name AS batch_name, b.start_month::text AS batch_month, bt.name AS batch_technology, bl.name AS batch_location,
           c.visa_category, c.documents_status, c.gh_remote, c.gh_location_id, gl.name AS gh_location_name,
           c.team_assigned_at, (c.resume_url IS NOT NULL) AS resume_link,
           lu.display_name AS lead_name, c.in_person_ok
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    LEFT JOIN eureka.team tm ON tm.id = c.team_id
    JOIN eureka.location l ON l.id = c.location_id
    LEFT JOIN eureka.app_user u ON u.id = c.recruiter_id
    LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
    LEFT JOIN eureka.batch b ON b.id = c.batch_id
    LEFT JOIN eureka.technology bt ON bt.id = b.technology_id
    LEFT JOIN eureka.location bl ON bl.id = b.location_id
    LEFT JOIN eureka.location gl ON gl.id = c.gh_location_id WHERE true AND (p.first_name || ' ' || p.last_name) ILIKE $1 ESCAPE '\' ORDER BY lower(p.first_name || ' ' || p.last_name), c.id LIMIT $2
```

Parameters (term `Zebrowski`): `["%Zebrowski%", 51]`

#### submissions/org

```sql
SELECT s.id, s.candidate_id, s.recruiter_id, s.team_id, s.location_id, s.job_title, s.client_id, s.vendor_id,
         s.rate, s.status, s.rejection_reason, s.job_id, s.submitted_at, s.status_changed_at, (extract(epoch from s.submitted_at) * 1000000)::bigint::text AS k,
         s.details_edited_at, eu.display_name AS details_edited_by_name, s.row_version,
         cl.name AS client, ru.display_name AS recruiter_name,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
         c.recruiter_id AS c_recruiter, c.team_id AS c_team, c.location_id AS c_location,
         c.visibility, c.marketing_status,
         iv.n AS interview_count, iv.last_at AS last_interview_at, iv.trail,
         (SELECT pl.status FROM eureka.placement pl WHERE pl.submission_id = s.id
           ORDER BY pl.created_at DESC LIMIT 1) AS placement_status
  FROM eureka.submission s
  JOIN eureka.client cl ON cl.id = s.client_id
  LEFT JOIN eureka.app_user ru ON ru.id = s.recruiter_id
  LEFT JOIN eureka.app_user eu ON eu.id = s.details_edited_by
  LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE i.call_status NOT IN ('cancelled','no_invite'))::int AS n,
           max(i.starts_at) FILTER (WHERE i.call_status NOT IN ('cancelled','no_invite')) AS last_at,
           jsonb_agg(jsonb_build_object('id', i.id, 'stage', CASE WHEN lower(i.round) ~ '\mfinal\M' THEN 'final'
    WHEN lower(i.round) ~ 'screen' THEN 'screening'
    WHEN coalesce(
      substring(lower(i.round) from '(?:\ml|level|round|\mr|tech(?:nical)?)\s*-?\s*(?:round\s*)?([0-9])'),
      substring(lower(i.round) from '([0-9])\s*(?:st|nd|rd|th)?\s*(?:round|level)'))::int = 1 THEN 'l1'
    WHEN coalesce(
      substring(lower(i.round) from '(?:\ml|level|round|\mr|tech(?:nical)?)\s*-?\s*(?:round\s*)?([0-9])'),
      substring(lower(i.round) from '([0-9])\s*(?:st|nd|rd|th)?\s*(?:round|level)'))::int = 2 THEN 'l2'
    WHEN coalesce(
      substring(lower(i.round) from '(?:\ml|level|round|\mr|tech(?:nical)?)\s*-?\s*(?:round\s*)?([0-9])'),
      substring(lower(i.round) from '([0-9])\s*(?:st|nd|rd|th)?\s*(?:round|level)'))::int >= 3 THEN 'l3'
    ELSE 'other' END, 'round', i.round, 'result', i.result,
             'callStatus', i.call_status, 'startsAt', i.starts_at) ORDER BY i.starts_at, i.id) AS trail
    FROM eureka.interview i WHERE i.submission_id = s.id) iv WHERE (true OR true) AND (p.first_name || ' ' || p.last_name) ILIKE $1 ESCAPE '\' ORDER BY s.submitted_at DESC, s.id DESC LIMIT $2
```

Parameters (term `Zebrowski`): `["%Zebrowski%", 51]`

#### placements/org

```sql
SELECT pl.id, pl.submission_id, pl.candidate_id, pl.recruiter_id, pl.team_id, pl.location_id,
         pl.client_id, pl.vendor_id, pl.implementation_partner_id, pl.placement_type, pl.rate, pl.work_mode,
         pl.project_city, pl.project_state, pl.tentative_start::text AS tentative_start,
         pl.actual_start::text AS actual_start, pl.is_first_placement,
         pl.reconfirmed, pl.technology_id, tech.name AS technology_name, pl.joined_at,
         pl.status, pl.status_changed_at, pl.created_at, (extract(epoch from pl.created_at) * 1000000)::bigint::text AS k,
         c.recruiter_id AS cand_recruiter_id, c.team_id AS cand_team_id, c.location_id AS cand_location_id,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
         ru.display_name AS recruiter_name, tm.name AS team_name, l.name AS location_name,
         cl.name AS client_name, v.name AS vendor_name, ip.name AS implementation_partner_name
  FROM eureka.placement pl
  LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  LEFT JOIN eureka.app_user ru ON ru.id = pl.recruiter_id
  LEFT JOIN eureka.team tm ON tm.id = pl.team_id
  LEFT JOIN eureka.location l ON l.id = pl.location_id
  JOIN eureka.client cl ON cl.id = pl.client_id
  LEFT JOIN eureka.vendor v ON v.id = pl.vendor_id
  LEFT JOIN eureka.implementation_partner ip ON ip.id = pl.implementation_partner_id
  LEFT JOIN eureka.technology tech ON tech.id = pl.technology_id WHERE (true OR true) AND (p.first_name || ' ' || p.last_name) ILIKE $1 ESCAPE '\' ORDER BY pl.created_at DESC, pl.id DESC LIMIT $2
```

Parameters (term `Zebrowski`): `["%Zebrowski%", 51]`

#### candidates/team

```sql
SELECT c.id, p.first_name, p.last_name, p.phone_e164, p.dob_year, t.name AS technology,
           c.team_id, tm.name AS team_name, c.recruiter_id, u.display_name AS recruiter_name,
           c.location_id, l.name AS location_name, c.visibility, c.marketing_status, c.priority,
           c.marketing_start_date::text, c.technical_rating, c.row_version,
           c.batch_id, b.name AS batch_name, b.start_month::text AS batch_month, bt.name AS batch_technology, bl.name AS batch_location,
           c.visa_category, c.documents_status, c.gh_remote, c.gh_location_id, gl.name AS gh_location_name,
           c.team_assigned_at, (c.resume_url IS NOT NULL) AS resume_link,
           lu.display_name AS lead_name, c.in_person_ok
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    LEFT JOIN eureka.team tm ON tm.id = c.team_id
    JOIN eureka.location l ON l.id = c.location_id
    LEFT JOIN eureka.app_user u ON u.id = c.recruiter_id
    LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
    LEFT JOIN eureka.batch b ON b.id = c.batch_id
    LEFT JOIN eureka.technology bt ON bt.id = b.technology_id
    LEFT JOIN eureka.location bl ON bl.id = b.location_id
    LEFT JOIN eureka.location gl ON gl.id = c.gh_location_id WHERE (c.recruiter_id = ANY($1::uuid[]) OR c.team_id = ANY($2::uuid[]) OR c.location_id = ANY($3::uuid[]) OR (c.visibility = 'all_teams' AND c.marketing_status = ANY($4::text[]))) AND (p.first_name || ' ' || p.last_name) ILIKE $5 ESCAPE '\' ORDER BY c.id LIMIT $6
```

Parameters (term `Zebrowski`): `[["b92ac765-9af5-4dab-958a-3a6e42edf2b9"], ["f0f1fc79-0671-47af-af2c-59e8b1f3fd1b"], [], ["active", "full_of_interviews"], "%Zebrowski%", 51]`

#### candidates-sort-name/team

```sql
SELECT c.id, p.first_name, p.last_name, p.phone_e164, p.dob_year, t.name AS technology,
           c.team_id, tm.name AS team_name, c.recruiter_id, u.display_name AS recruiter_name,
           c.location_id, l.name AS location_name, c.visibility, c.marketing_status, c.priority,
           c.marketing_start_date::text, c.technical_rating, c.row_version,
           c.batch_id, b.name AS batch_name, b.start_month::text AS batch_month, bt.name AS batch_technology, bl.name AS batch_location,
           c.visa_category, c.documents_status, c.gh_remote, c.gh_location_id, gl.name AS gh_location_name,
           c.team_assigned_at, (c.resume_url IS NOT NULL) AS resume_link,
           lu.display_name AS lead_name, c.in_person_ok
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    LEFT JOIN eureka.team tm ON tm.id = c.team_id
    JOIN eureka.location l ON l.id = c.location_id
    LEFT JOIN eureka.app_user u ON u.id = c.recruiter_id
    LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
    LEFT JOIN eureka.batch b ON b.id = c.batch_id
    LEFT JOIN eureka.technology bt ON bt.id = b.technology_id
    LEFT JOIN eureka.location bl ON bl.id = b.location_id
    LEFT JOIN eureka.location gl ON gl.id = c.gh_location_id WHERE (c.recruiter_id = ANY($1::uuid[]) OR c.team_id = ANY($2::uuid[]) OR c.location_id = ANY($3::uuid[]) OR (c.visibility = 'all_teams' AND c.marketing_status = ANY($4::text[]))) AND (p.first_name || ' ' || p.last_name) ILIKE $5 ESCAPE '\' ORDER BY lower(p.first_name || ' ' || p.last_name), c.id LIMIT $6
```

Parameters (term `Zebrowski`): `[["b92ac765-9af5-4dab-958a-3a6e42edf2b9"], ["f0f1fc79-0671-47af-af2c-59e8b1f3fd1b"], [], ["active", "full_of_interviews"], "%Zebrowski%", 51]`

#### submissions/team

```sql
SELECT s.id, s.candidate_id, s.recruiter_id, s.team_id, s.location_id, s.job_title, s.client_id, s.vendor_id,
         s.rate, s.status, s.rejection_reason, s.job_id, s.submitted_at, s.status_changed_at, (extract(epoch from s.submitted_at) * 1000000)::bigint::text AS k,
         s.details_edited_at, eu.display_name AS details_edited_by_name, s.row_version,
         cl.name AS client, ru.display_name AS recruiter_name,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
         c.recruiter_id AS c_recruiter, c.team_id AS c_team, c.location_id AS c_location,
         c.visibility, c.marketing_status,
         iv.n AS interview_count, iv.last_at AS last_interview_at, iv.trail,
         (SELECT pl.status FROM eureka.placement pl WHERE pl.submission_id = s.id
           ORDER BY pl.created_at DESC LIMIT 1) AS placement_status
  FROM eureka.submission s
  JOIN eureka.client cl ON cl.id = s.client_id
  LEFT JOIN eureka.app_user ru ON ru.id = s.recruiter_id
  LEFT JOIN eureka.app_user eu ON eu.id = s.details_edited_by
  LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE i.call_status NOT IN ('cancelled','no_invite'))::int AS n,
           max(i.starts_at) FILTER (WHERE i.call_status NOT IN ('cancelled','no_invite')) AS last_at,
           jsonb_agg(jsonb_build_object('id', i.id, 'stage', CASE WHEN lower(i.round) ~ '\mfinal\M' THEN 'final'
    WHEN lower(i.round) ~ 'screen' THEN 'screening'
    WHEN coalesce(
      substring(lower(i.round) from '(?:\ml|level|round|\mr|tech(?:nical)?)\s*-?\s*(?:round\s*)?([0-9])'),
      substring(lower(i.round) from '([0-9])\s*(?:st|nd|rd|th)?\s*(?:round|level)'))::int = 1 THEN 'l1'
    WHEN coalesce(
      substring(lower(i.round) from '(?:\ml|level|round|\mr|tech(?:nical)?)\s*-?\s*(?:round\s*)?([0-9])'),
      substring(lower(i.round) from '([0-9])\s*(?:st|nd|rd|th)?\s*(?:round|level)'))::int = 2 THEN 'l2'
    WHEN coalesce(
      substring(lower(i.round) from '(?:\ml|level|round|\mr|tech(?:nical)?)\s*-?\s*(?:round\s*)?([0-9])'),
      substring(lower(i.round) from '([0-9])\s*(?:st|nd|rd|th)?\s*(?:round|level)'))::int >= 3 THEN 'l3'
    ELSE 'other' END, 'round', i.round, 'result', i.result,
             'callStatus', i.call_status, 'startsAt', i.starts_at) ORDER BY i.starts_at, i.id) AS trail
    FROM eureka.interview i WHERE i.submission_id = s.id) iv WHERE ((s.recruiter_id = ANY($1::uuid[]) OR s.team_id = ANY($2::uuid[]) OR s.location_id = ANY($3::uuid[])) OR (c.recruiter_id = ANY($4::uuid[]) OR c.team_id = ANY($5::uuid[]) OR c.location_id = ANY($6::uuid[]))) AND (p.first_name || ' ' || p.last_name) ILIKE $7 ESCAPE '\' ORDER BY s.submitted_at DESC, s.id DESC LIMIT $8
```

Parameters (term `Zebrowski`): `[["b92ac765-9af5-4dab-958a-3a6e42edf2b9"], ["f0f1fc79-0671-47af-af2c-59e8b1f3fd1b"], [], ["b92ac765-9af5-4dab-958a-3a6e42edf2b9"], ["f0f1fc79-0671-47af-af2c-59e8b1f3fd1b"], [], "%Zebrowski%", 51]`

#### placements/team

```sql
SELECT pl.id, pl.submission_id, pl.candidate_id, pl.recruiter_id, pl.team_id, pl.location_id,
         pl.client_id, pl.vendor_id, pl.implementation_partner_id, pl.placement_type, pl.rate, pl.work_mode,
         pl.project_city, pl.project_state, pl.tentative_start::text AS tentative_start,
         pl.actual_start::text AS actual_start, pl.is_first_placement,
         pl.reconfirmed, pl.technology_id, tech.name AS technology_name, pl.joined_at,
         pl.status, pl.status_changed_at, pl.created_at, (extract(epoch from pl.created_at) * 1000000)::bigint::text AS k,
         c.recruiter_id AS cand_recruiter_id, c.team_id AS cand_team_id, c.location_id AS cand_location_id,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
         ru.display_name AS recruiter_name, tm.name AS team_name, l.name AS location_name,
         cl.name AS client_name, v.name AS vendor_name, ip.name AS implementation_partner_name
  FROM eureka.placement pl
  LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  LEFT JOIN eureka.app_user ru ON ru.id = pl.recruiter_id
  LEFT JOIN eureka.team tm ON tm.id = pl.team_id
  LEFT JOIN eureka.location l ON l.id = pl.location_id
  JOIN eureka.client cl ON cl.id = pl.client_id
  LEFT JOIN eureka.vendor v ON v.id = pl.vendor_id
  LEFT JOIN eureka.implementation_partner ip ON ip.id = pl.implementation_partner_id
  LEFT JOIN eureka.technology tech ON tech.id = pl.technology_id WHERE ((pl.recruiter_id = ANY($1::uuid[]) OR pl.team_id = ANY($2::uuid[]) OR pl.location_id = ANY($3::uuid[])) OR (c.recruiter_id = ANY($4::uuid[]) OR c.team_id = ANY($5::uuid[]) OR c.location_id = ANY($6::uuid[]))) AND (p.first_name || ' ' || p.last_name) ILIKE $7 ESCAPE '\' ORDER BY pl.created_at DESC, pl.id DESC LIMIT $8
```

Parameters (term `Zebrowski`): `[["b92ac765-9af5-4dab-958a-3a6e42edf2b9"], ["f0f1fc79-0671-47af-af2c-59e8b1f3fd1b"], [], ["b92ac765-9af5-4dab-958a-3a6e42edf2b9"], ["f0f1fc79-0671-47af-af2c-59e8b1f3fd1b"], [], "%Zebrowski%", 51]`

#### employees/org(hr)

```sql
SELECT e.person_id, e.candidate_id, e.status, e.employee_since::text, e.status_since::text,
         e.exited_on::text, e.exit_reason,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS name,
         c.marketing_status, c.location_id, l.name AS location_name, c.team_id, tm.name AS team_name,
         la.id AS assignment_id, la.assignment_no, la.start_date::text AS start_date, la.end_date::text AS end_date,
         la.end_reason, pp.planned_end_date::text AS planned_end_date,
         pl.id AS placement_id, pl.client_id, cl.name AS client_name,
         pl.recruiter_id, pl.team_id AS pl_team_id, pl.location_id AS pl_location_id,
         c.recruiter_id AS c_recruiter_id, c.visibility, p.personal_email::text AS email, p.phone_e164 AS phone,
         cru.display_name AS c_recruiter_name, tm.lead_id, lu.display_name AS lead_name,
         pl.vendor_id, v.name AS vendor_name, ae.payroll_company_id, pc.name AS payroll_company_name,
         ae.everify_date::text AS everify_date, ae.onboarded_date::text AS onboarded_date
  FROM eureka.employee e
  LEFT JOIN eureka.person p ON p.id = e.person_id
  LEFT JOIN eureka.candidate c ON c.id = e.candidate_id
  LEFT JOIN eureka.location l ON l.id = c.location_id
  LEFT JOIN eureka.team tm ON tm.id = c.team_id
  LEFT JOIN eureka.app_user cru ON cru.id = c.recruiter_id
  LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
  LEFT JOIN LATERAL (
    SELECT a.id, a.assignment_no, a.start_date, a.end_date, a.end_reason, a.placement_id
    FROM eureka.assignment a WHERE a.person_id = e.person_id
    ORDER BY a.assignment_no DESC LIMIT 1) la ON true
  LEFT JOIN eureka.placement pl ON pl.id = la.placement_id
  LEFT JOIN eureka.client cl ON cl.id = pl.client_id
  LEFT JOIN eureka.vendor v ON v.id = pl.vendor_id
  LEFT JOIN eureka.assignment_plan pp ON pp.assignment_id = la.id
  LEFT JOIN eureka.assignment_employment ae ON ae.assignment_id = la.id
  LEFT JOIN authz.payroll_companies() pc ON pc.id = ae.payroll_company_id WHERE true AND (p.first_name || ' ' || p.last_name) ILIKE $1 ESCAPE '\' ORDER BY e.status_since DESC, e.person_id DESC LIMIT $2
```

Parameters (term `Zebrowski`): `["%Zebrowski%", 51]`

#### applicants/org(hr)

```sql
SELECT ap.id, ap.first_name, ap.last_name, ap.email, ap.phone_e164, ap.email_verified_at, ap.created_at,
        (SELECT count(*) FROM eureka.job_application a WHERE a.applicant_id = ap.id)::int AS applications, (extract(epoch from ap.created_at) * 1000000)::bigint::text AS k
      FROM eureka.applicant ap WHERE true AND ((ap.first_name || ' ' || ap.last_name) ILIKE $1 ESCAPE '\' OR ap.email ILIKE $1 ESCAPE '\') ORDER BY ap.created_at DESC, ap.id DESC LIMIT $2
```

Parameters (term `Zebrowski`): `["%Zebrowski%", 51]`

#### hotlist_page/org

```sql
SELECT * FROM authz.hotlist_page($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
```

Parameters (term `Zebrowski`): `[null, null, null, "%Zebrowski%", null, 51, null, null, null, null, null, {"priority": null, "teamId": null, "recruiterId": null, "inPerson": null, "ghLocationId": null, "sort": null}]`

#### hotlist_page/team

```sql
SELECT * FROM authz.hotlist_page($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
```

Parameters (term `Zebrowski`): `[null, null, null, "%Zebrowski%", null, 51, null, null, null, null, null, {"priority": null, "teamId": null, "recruiterId": null, "inPerson": null, "ghLocationId": null, "sort": null}]`

## Raw plans

EXPLAIN (ANALYZE, BUFFERS) output of the last of the five runs, for the rare-name term on each query
(and the 2-character term on the open Hot List), before and after.

#### candidates/org, term `Zebrowski`, before (median exec 116.1 ms)

```text
Limit  (cost=502272.51..502272.51 rows=2 width=410) (actual time=100.035..100.045 rows=6 loops=1)
  Buffers: shared hit=151167
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.878..0.879 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 2 (returns $1)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 3 (returns $2)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 4 (returns $3)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 5 (returns $4)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  InitPlan 24 (returns $23)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  InitPlan 25 (returns $24)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Sort  (cost=502270.69..502270.69 rows=2 width=410) (actual time=100.033..100.040 rows=6 loops=1)
        Sort Key: c.id
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=151167
        ->  Nested Loop Left Join  (cost=0.64..502270.68 rows=2 width=410) (actual time=99.807..100.027 rows=6 loops=1)
              Join Filter: (gl.id = c.gh_location_id)
              Rows Removed by Join Filter: 24
              Buffers: shared hit=151167
              ->  Nested Loop Left Join  (cost=0.64..502269.49 rows=2 width=377) (actual time=99.799..100.014 rows=6 loops=1)
                    Join Filter: (bl.id = b.location_id)
                    Rows Removed by Join Filter: 24
                    Buffers: shared hit=151166
                    ->  Nested Loop Left Join  (cost=0.64..502268.32 rows=2 width=385) (actual time=99.791..100.003 rows=6 loops=1)
                          Join Filter: (bt.id = b.technology_id)
                          Rows Removed by Join Filter: 84
                          Buffers: shared hit=151165
                          ->  Nested Loop Left Join  (cost=0.64..502266.72 rows=2 width=390) (actual time=99.780..99.985 rows=6 loops=1)
                                Join Filter: (b.id = c.batch_id)
                                Buffers: shared hit=151164
                                ->  Nested Loop Left Join  (cost=0.64..502266.70 rows=2 width=322) (actual time=99.775..99.976 rows=6 loops=1)
                                      Join Filter: (lu.id = tm.lead_id)
                                      Rows Removed by Join Filter: 528
                                      Buffers: shared hit=151164
                                      ->  Nested Loop Left Join  (cost=0.64..501991.56 rows=2 width=321) (actual time=99.764..99.856 rows=6 loops=1)
                                            Join Filter: (u.id = c.recruiter_id)
                                            Rows Removed by Join Filter: 644
                                            Buffers: shared hit=150898
                                            ->  Nested Loop  (cost=0.64..501716.42 rows=2 width=304) (actual time=99.531..99.551 rows=6 loops=1)
                                                  Join Filter: (l.id = c.location_id)
                                                  Rows Removed by Join Filter: 18
                                                  Buffers: shared hit=150630
                                                  ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.014..0.016 rows=4 loops=1)
                                                        Buffers: shared hit=1
                                                  ->  Materialize  (cost=0.64..501715.26 rows=2 width=296) (actual time=24.872..24.882 rows=6 loops=4)
                                                        Buffers: shared hit=150629
                                                        ->  Nested Loop Left Join  (cost=0.64..501715.25 rows=2 width=296) (actual time=99.487..99.519 rows=6 loops=1)
                                                              Join Filter: (tm.id = c.team_id)
                                                              Rows Removed by Join Filter: 73
                                                              Buffers: shared hit=150629
                                                              ->  Nested Loop  (cost=0.64..501712.98 rows=2 width=267) (actual time=99.477..99.494 rows=6 loops=1)
                                                                    Join Filter: (t.id = c.technology_id)
                                                                    Rows Removed by Join Filter: 78
                                                                    Buffers: shared hit=150628
                                                                    ->  Seq Scan on technology t  (cost=0.00..1.14 rows=14 width=27) (actual time=0.004..0.006 rows=14 loops=1)
                                                                          Buffers: shared hit=1
                                                                    ->  Materialize  (cost=0.64..501711.42 rows=2 width=272) (actual time=7.102..7.105 rows=6 loops=14)
                                                                          Buffers: shared hit=150627
                                                                          ->  Nested Loop  (cost=0.64..501711.41 rows=2 width=272) (actual time=99.428..99.460 rows=6 loops=1)
                                                                                Buffers: shared hit=150627
                                                                                ->  Seq Scan on person p  (cost=0.00..501694.00 rows=2 width=43) (actual time=98.526..98.548 rows=6 loops=1)
                                                                                      Filter: ((SubPlan 15) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                                                      Rows Removed by Filter: 49994
                                                                                      Buffers: shared hit=150589
                                                                                      SubPlan 15
                                                                                        ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=50000)
                                                                                              Index Cond: (person_id = p.id)
                                                                                              Filter: ($8 OR (recruiter_id = ANY ($9)) OR (team_id = ANY ($10)) OR (location_id = ANY ($11)) OR ($12 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 14))
                                                                                              Buffers: shared hit=150020
                                                                                              InitPlan 8 (returns $8)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.717..0.717 rows=1 loops=1)
                                                                                                      Buffers: shared hit=20
                                                                                              InitPlan 9 (returns $9)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              InitPlan 10 (returns $10)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              InitPlan 11 (returns $11)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              InitPlan 12 (returns $12)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                                              SubPlan 14
                                                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                                      InitPlan 13 (returns $13)
                                                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                                ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.64..8.71 rows=1 width=261) (actual time=0.150..0.150 rows=1 loops=6)
                                                                                      Index Cond: (person_id = p.id)
                                                                                      Filter: ($0 OR (recruiter_id = ANY ($1)) OR (team_id = ANY ($2)) OR (location_id = ANY ($3)) OR ($4 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 7))
                                                                                      Buffers: shared hit=38
                                                                                      SubPlan 7
                                                                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                              InitPlan 6 (returns $5)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                              ->  Materialize  (cost=0.00..1.45 rows=30 width=45) (actual time=0.001..0.003 rows=13 loops=6)
                                                                    Buffers: shared hit=1
                                                                    ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.005..0.007 rows=26 loops=1)
                                                                          Buffers: shared hit=1
                                            ->  Materialize  (cost=0.00..270.52 rows=168 width=33) (actual time=0.001..0.045 rows=108 loops=6)
                                                  Buffers: shared hit=268
                                                  ->  Seq Scan on app_user u  (cost=0.00..269.68 rows=168 width=33) (actual time=0.003..0.219 rows=158 loops=1)
                                                        Buffers: shared hit=268
                                      ->  Materialize  (cost=0.00..270.52 rows=168 width=33) (actual time=0.001..0.015 rows=89 loops=6)
                                            Buffers: shared hit=266
                                            ->  Seq Scan on app_user lu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.003..0.048 rows=133 loops=1)
                                                  Buffers: shared hit=266
                                ->  Seq Scan on batch b  (cost=0.00..0.00 rows=1 width=84) (actual time=0.001..0.001 rows=0 loops=6)
                                      Filter: ($23 OR $24)
                          ->  Materialize  (cost=0.00..1.21 rows=14 width=27) (actual time=0.001..0.002 rows=14 loops=6)
                                Buffers: shared hit=1
                                ->  Seq Scan on technology bt  (cost=0.00..1.14 rows=14 width=27) (actual time=0.002..0.004 rows=14 loops=1)
                                      Buffers: shared hit=1
                    ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=6)
                          Buffers: shared hit=1
                          ->  Seq Scan on location bl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.002..0.003 rows=4 loops=1)
                                Buffers: shared hit=1
              ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.000..0.001 rows=4 loops=6)
                    Buffers: shared hit=1
                    ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=1)
                          Buffers: shared hit=1
Planning:
  Buffers: shared hit=54
Planning Time: 9.500 ms
Execution Time: 100.265 ms
```

#### candidates/org, term `Zebrowski`, after (median exec 116.3 ms)

```text
Limit  (cost=502272.51..502272.51 rows=2 width=410) (actual time=102.776..102.789 rows=6 loops=1)
  Buffers: shared hit=151167
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.825..0.825 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 2 (returns $1)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 3 (returns $2)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 4 (returns $3)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 5 (returns $4)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  InitPlan 24 (returns $23)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  InitPlan 25 (returns $24)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Sort  (cost=502270.69..502270.69 rows=2 width=410) (actual time=102.774..102.785 rows=6 loops=1)
        Sort Key: c.id
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=151167
        ->  Nested Loop Left Join  (cost=0.64..502270.68 rows=2 width=410) (actual time=102.516..102.770 rows=6 loops=1)
              Join Filter: (gl.id = c.gh_location_id)
              Rows Removed by Join Filter: 24
              Buffers: shared hit=151167
              ->  Nested Loop Left Join  (cost=0.64..502269.49 rows=2 width=377) (actual time=102.507..102.756 rows=6 loops=1)
                    Join Filter: (bl.id = b.location_id)
                    Rows Removed by Join Filter: 24
                    Buffers: shared hit=151166
                    ->  Nested Loop Left Join  (cost=0.64..502268.32 rows=2 width=385) (actual time=102.498..102.743 rows=6 loops=1)
                          Join Filter: (bt.id = b.technology_id)
                          Rows Removed by Join Filter: 84
                          Buffers: shared hit=151165
                          ->  Nested Loop Left Join  (cost=0.64..502266.72 rows=2 width=390) (actual time=102.487..102.723 rows=6 loops=1)
                                Join Filter: (b.id = c.batch_id)
                                Buffers: shared hit=151164
                                ->  Nested Loop Left Join  (cost=0.64..502266.70 rows=2 width=322) (actual time=102.482..102.714 rows=6 loops=1)
                                      Join Filter: (lu.id = tm.lead_id)
                                      Rows Removed by Join Filter: 528
                                      Buffers: shared hit=151164
                                      ->  Nested Loop Left Join  (cost=0.64..501991.56 rows=2 width=321) (actual time=102.471..102.592 rows=6 loops=1)
                                            Join Filter: (u.id = c.recruiter_id)
                                            Rows Removed by Join Filter: 644
                                            Buffers: shared hit=150898
                                            ->  Nested Loop  (cost=0.64..501716.42 rows=2 width=304) (actual time=102.188..102.211 rows=6 loops=1)
                                                  Join Filter: (l.id = c.location_id)
                                                  Rows Removed by Join Filter: 18
                                                  Buffers: shared hit=150630
                                                  ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.015..0.017 rows=4 loops=1)
                                                        Buffers: shared hit=1
                                                  ->  Materialize  (cost=0.64..501715.26 rows=2 width=296) (actual time=25.536..25.546 rows=6 loops=4)
                                                        Buffers: shared hit=150629
                                                        ->  Nested Loop Left Join  (cost=0.64..501715.25 rows=2 width=296) (actual time=102.142..102.176 rows=6 loops=1)
                                                              Join Filter: (tm.id = c.team_id)
                                                              Rows Removed by Join Filter: 73
                                                              Buffers: shared hit=150629
                                                              ->  Nested Loop  (cost=0.64..501712.98 rows=2 width=267) (actual time=102.130..102.148 rows=6 loops=1)
                                                                    Join Filter: (t.id = c.technology_id)
                                                                    Rows Removed by Join Filter: 78
                                                                    Buffers: shared hit=150628
                                                                    ->  Seq Scan on technology t  (cost=0.00..1.14 rows=14 width=27) (actual time=0.003..0.005 rows=14 loops=1)
                                                                          Buffers: shared hit=1
                                                                    ->  Materialize  (cost=0.64..501711.42 rows=2 width=272) (actual time=7.291..7.295 rows=6 loops=14)
                                                                          Buffers: shared hit=150627
                                                                          ->  Nested Loop  (cost=0.64..501711.41 rows=2 width=272) (actual time=102.067..102.114 rows=6 loops=1)
                                                                                Buffers: shared hit=150627
                                                                                ->  Seq Scan on person p  (cost=0.00..501694.00 rows=2 width=43) (actual time=101.221..101.254 rows=6 loops=1)
                                                                                      Filter: ((SubPlan 15) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                                                      Rows Removed by Filter: 49994
                                                                                      Buffers: shared hit=150589
                                                                                      SubPlan 15
                                                                                        ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=50000)
                                                                                              Index Cond: (person_id = p.id)
                                                                                              Filter: ($8 OR (recruiter_id = ANY ($9)) OR (team_id = ANY ($10)) OR (location_id = ANY ($11)) OR ($12 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 14))
                                                                                              Buffers: shared hit=150020
                                                                                              InitPlan 8 (returns $8)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.716..0.717 rows=1 loops=1)
                                                                                                      Buffers: shared hit=20
                                                                                              InitPlan 9 (returns $9)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              InitPlan 10 (returns $10)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              InitPlan 11 (returns $11)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              InitPlan 12 (returns $12)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                                              SubPlan 14
                                                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                                      InitPlan 13 (returns $13)
                                                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                                ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.64..8.71 rows=1 width=261) (actual time=0.141..0.141 rows=1 loops=6)
                                                                                      Index Cond: (person_id = p.id)
                                                                                      Filter: ($0 OR (recruiter_id = ANY ($1)) OR (team_id = ANY ($2)) OR (location_id = ANY ($3)) OR ($4 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 7))
                                                                                      Buffers: shared hit=38
                                                                                      SubPlan 7
                                                                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                              InitPlan 6 (returns $5)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                              ->  Materialize  (cost=0.00..1.45 rows=30 width=45) (actual time=0.001..0.003 rows=13 loops=6)
                                                                    Buffers: shared hit=1
                                                                    ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.006..0.009 rows=26 loops=1)
                                                                          Buffers: shared hit=1
                                            ->  Materialize  (cost=0.00..270.52 rows=168 width=33) (actual time=0.001..0.057 rows=108 loops=6)
                                                  Buffers: shared hit=268
                                                  ->  Seq Scan on app_user u  (cost=0.00..269.68 rows=168 width=33) (actual time=0.004..0.292 rows=158 loops=1)
                                                        Buffers: shared hit=268
                                      ->  Materialize  (cost=0.00..270.52 rows=168 width=33) (actual time=0.001..0.015 rows=89 loops=6)
                                            Buffers: shared hit=266
                                            ->  Seq Scan on app_user lu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.002..0.050 rows=133 loops=1)
                                                  Buffers: shared hit=266
                                ->  Seq Scan on batch b  (cost=0.00..0.00 rows=1 width=84) (actual time=0.000..0.000 rows=0 loops=6)
                                      Filter: ($23 OR $24)
                          ->  Materialize  (cost=0.00..1.21 rows=14 width=27) (actual time=0.001..0.002 rows=14 loops=6)
                                Buffers: shared hit=1
                                ->  Seq Scan on technology bt  (cost=0.00..1.14 rows=14 width=27) (actual time=0.002..0.004 rows=14 loops=1)
                                      Buffers: shared hit=1
                    ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=6)
                          Buffers: shared hit=1
                          ->  Seq Scan on location bl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.003..0.004 rows=4 loops=1)
                                Buffers: shared hit=1
              ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.000..0.001 rows=4 loops=6)
                    Buffers: shared hit=1
                    ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=1)
                          Buffers: shared hit=1
Planning:
  Buffers: shared hit=54
Planning Time: 9.058 ms
Execution Time: 102.980 ms
```

#### candidates/team, term `Zebrowski`, before (median exec 40.0 ms)

```text
Limit  (cost=71394.84..71394.85 rows=1 width=410) (actual time=41.079..41.106 rows=1 loops=1)
  Buffers: shared hit=38797
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.670..0.671 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 2 (returns $1)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.959..0.960 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 3 (returns $2)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.200..1.201 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 4 (returns $3)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.887..0.888 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 5 (returns $4)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.491..0.491 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 24 (returns $23)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  InitPlan 25 (returns $24)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Sort  (cost=71393.02..71393.03 rows=1 width=410) (actual time=41.078..41.097 rows=1 loops=1)
        Sort Key: c.id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=38797
        ->  Nested Loop Left Join  (cost=113.53..71393.01 rows=1 width=410) (actual time=10.985..41.085 rows=1 loops=1)
              Join Filter: (gl.id = c.gh_location_id)
              Rows Removed by Join Filter: 4
              Buffers: shared hit=38797
              ->  Nested Loop Left Join  (cost=113.53..71391.91 rows=1 width=377) (actual time=10.977..41.074 rows=1 loops=1)
                    Join Filter: (bl.id = b.location_id)
                    Rows Removed by Join Filter: 4
                    Buffers: shared hit=38796
                    ->  Nested Loop Left Join  (cost=113.53..71390.82 rows=1 width=385) (actual time=10.973..41.068 rows=1 loops=1)
                          Join Filter: (bt.id = b.technology_id)
                          Rows Removed by Join Filter: 14
                          Buffers: shared hit=38795
                          ->  Nested Loop Left Join  (cost=113.53..71389.51 rows=1 width=390) (actual time=10.966..41.060 rows=1 loops=1)
                                Join Filter: (b.id = c.batch_id)
                                Buffers: shared hit=38794
                                ->  Nested Loop Left Join  (cost=113.53..71389.50 rows=1 width=322) (actual time=10.962..41.054 rows=1 loops=1)
                                      Join Filter: (lu.id = tm.lead_id)
                                      Rows Removed by Join Filter: 14
                                      Buffers: shared hit=38794
                                      ->  Nested Loop Left Join  (cost=113.53..71117.72 rows=1 width=321) (actual time=10.956..41.047 rows=1 loops=1)
                                            Join Filter: (u.id = c.recruiter_id)
                                            Rows Removed by Join Filter: 88
                                            Buffers: shared hit=38791
                                            ->  Nested Loop  (cost=113.53..70845.94 rows=1 width=304) (actual time=10.796..40.885 rows=1 loops=1)
                                                  Join Filter: (l.id = c.location_id)
                                                  Buffers: shared hit=38531
                                                  ->  Nested Loop Left Join  (cost=113.53..70844.85 rows=1 width=296) (actual time=10.792..40.879 rows=1 loops=1)
                                                        Join Filter: (tm.id = c.team_id)
                                                        Buffers: shared hit=38530
                                                        ->  Nested Loop  (cost=113.53..70843.17 rows=1 width=267) (actual time=10.788..40.874 rows=1 loops=1)
                                                              Join Filter: (t.id = c.technology_id)
                                                              Rows Removed by Join Filter: 8
                                                              Buffers: shared hit=38529
                                                              ->  Nested Loop  (cost=113.53..70841.86 rows=1 width=272) (actual time=10.776..40.861 rows=1 loops=1)
                                                                    Buffers: shared hit=38528
                                                                    ->  Bitmap Heap Scan on candidate c  (cost=113.24..1721.05 rows=6368 width=261) (actual time=3.197..10.377 rows=6186 loops=1)
                                                                          Recheck Cond: ((recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (gh_location_id IS NOT NULL) OR ((visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))))
                                                                          Filter: (((recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (location_id = ANY ('{}'::uuid[])) OR ((visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[])))) AND ($0 OR (recruiter_id = ANY ($1)) OR (team_id = ANY ($2)) OR (location_id = ANY ($3)) OR ($4 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 7)))
                                                                          Heap Blocks: exact=1151
                                                                          Buffers: shared hit=1288
                                                                          ->  BitmapOr  (cost=112.89..112.89 rows=6621 width=0) (actual time=0.227..0.230 rows=0 loops=1)
                                                                                Buffers: shared hit=13
                                                                                ->  Bitmap Index Scan on candidate_recruiter  (cost=0.00..7.09 rows=374 width=0) (actual time=0.010..0.011 rows=0 loops=1)
                                                                                      Index Cond: (recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[]))
                                                                                      Buffers: shared hit=2
                                                                                ->  Bitmap Index Scan on candidate_team  (cost=0.00..24.45 rows=1622 width=0) (actual time=0.033..0.034 rows=1667 loops=1)
                                                                                      Index Cond: (team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[]))
                                                                                      Buffers: shared hit=3
                                                                                ->  Bitmap Index Scan on candidate_gh_location  (cost=0.00..4.13 rows=1 width=0) (actual time=0.002..0.002 rows=0 loops=1)
                                                                                      Buffers: shared hit=1
                                                                                ->  Bitmap Index Scan on candidate_visibility  (cost=0.00..70.84 rows=4626 width=0) (actual time=0.182..0.182 rows=4672 loops=1)
                                                                                      Index Cond: ((visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[])))
                                                                                      Buffers: shared hit=7
                                                                          SubPlan 7
                                                                            ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                  InitPlan 6 (returns $5)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                  ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                    ->  Index Scan using person_pkey on person p  (cost=0.29..10.85 rows=1 width=43) (actual time=0.005..0.005 rows=0 loops=6186)
                                                                          Index Cond: (id = c.person_id)
                                                                          Filter: ((SubPlan 15) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                                          Rows Removed by Filter: 1
                                                                          Buffers: shared hit=37240
                                                                          SubPlan 15
                                                                            ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=6186)
                                                                                  Index Cond: (person_id = p.id)
                                                                                  Filter: ($8 OR (recruiter_id = ANY ($9)) OR (team_id = ANY ($10)) OR (location_id = ANY ($11)) OR ($12 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 14))
                                                                                  Buffers: shared hit=18682
                                                                                  InitPlan 8 (returns $8)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.409..0.409 rows=1 loops=1)
                                                                                          Buffers: shared hit=20
                                                                                  InitPlan 9 (returns $9)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.889..0.889 rows=1 loops=1)
                                                                                          Buffers: shared hit=40
                                                                                  InitPlan 10 (returns $10)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.254..1.254 rows=1 loops=1)
                                                                                          Buffers: shared hit=24
                                                                                  InitPlan 11 (returns $11)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.404..0.404 rows=1 loops=1)
                                                                                          Buffers: shared hit=20
                                                                                  InitPlan 12 (returns $12)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.424..0.424 rows=1 loops=1)
                                                                                          Buffers: shared hit=20
                                                                                  SubPlan 14
                                                                                    ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                          InitPlan 13 (returns $13)
                                                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                          ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                              ->  Seq Scan on technology t  (cost=0.00..1.14 rows=14 width=27) (actual time=0.006..0.007 rows=9 loops=1)
                                                                    Buffers: shared hit=1
                                                        ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.001..0.001 rows=1 loops=1)
                                                              Buffers: shared hit=1
                                                  ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.003..0.003 rows=1 loops=1)
                                                        Buffers: shared hit=1
                                            ->  Seq Scan on app_user u  (cost=0.00..269.68 rows=168 width=33) (actual time=0.004..0.148 rows=89 loops=1)
                                                  Buffers: shared hit=260
                                      ->  Seq Scan on app_user lu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.001..0.002 rows=15 loops=1)
                                            Buffers: shared hit=3
                                ->  Seq Scan on batch b  (cost=0.00..0.00 rows=1 width=84) (actual time=0.002..0.003 rows=0 loops=1)
                                      Filter: ($23 OR $24)
                          ->  Seq Scan on technology bt  (cost=0.00..1.14 rows=14 width=27) (actual time=0.002..0.003 rows=14 loops=1)
                                Buffers: shared hit=1
                    ->  Seq Scan on location bl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=1)
                          Buffers: shared hit=1
              ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.001..0.002 rows=4 loops=1)
                    Buffers: shared hit=1
Planning:
  Buffers: shared hit=54
Planning Time: 8.515 ms
Execution Time: 41.346 ms
```

#### candidates/team, term `Zebrowski`, after (median exec 42.5 ms)

```text
Limit  (cost=71394.84..71394.85 rows=1 width=410) (actual time=42.139..42.164 rows=1 loops=1)
  Buffers: shared hit=38797
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.761..0.762 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 2 (returns $1)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.205..1.206 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 3 (returns $2)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.180..1.180 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 4 (returns $3)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.811..0.812 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 5 (returns $4)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.470..0.470 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 24 (returns $23)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  InitPlan 25 (returns $24)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Sort  (cost=71393.02..71393.03 rows=1 width=410) (actual time=42.137..42.155 rows=1 loops=1)
        Sort Key: c.id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=38797
        ->  Nested Loop Left Join  (cost=113.53..71393.01 rows=1 width=410) (actual time=10.950..42.141 rows=1 loops=1)
              Join Filter: (gl.id = c.gh_location_id)
              Rows Removed by Join Filter: 4
              Buffers: shared hit=38797
              ->  Nested Loop Left Join  (cost=113.53..71391.91 rows=1 width=377) (actual time=10.941..42.130 rows=1 loops=1)
                    Join Filter: (bl.id = b.location_id)
                    Rows Removed by Join Filter: 4
                    Buffers: shared hit=38796
                    ->  Nested Loop Left Join  (cost=113.53..71390.82 rows=1 width=385) (actual time=10.936..42.123 rows=1 loops=1)
                          Join Filter: (bt.id = b.technology_id)
                          Rows Removed by Join Filter: 14
                          Buffers: shared hit=38795
                          ->  Nested Loop Left Join  (cost=113.53..71389.51 rows=1 width=390) (actual time=10.928..42.114 rows=1 loops=1)
                                Join Filter: (b.id = c.batch_id)
                                Buffers: shared hit=38794
                                ->  Nested Loop Left Join  (cost=113.53..71389.50 rows=1 width=322) (actual time=10.923..42.107 rows=1 loops=1)
                                      Join Filter: (lu.id = tm.lead_id)
                                      Rows Removed by Join Filter: 14
                                      Buffers: shared hit=38794
                                      ->  Nested Loop Left Join  (cost=113.53..71117.72 rows=1 width=321) (actual time=10.916..42.099 rows=1 loops=1)
                                            Join Filter: (u.id = c.recruiter_id)
                                            Rows Removed by Join Filter: 88
                                            Buffers: shared hit=38791
                                            ->  Nested Loop  (cost=113.53..70845.94 rows=1 width=304) (actual time=10.711..41.892 rows=1 loops=1)
                                                  Join Filter: (l.id = c.location_id)
                                                  Buffers: shared hit=38531
                                                  ->  Nested Loop Left Join  (cost=113.53..70844.85 rows=1 width=296) (actual time=10.706..41.886 rows=1 loops=1)
                                                        Join Filter: (tm.id = c.team_id)
                                                        Buffers: shared hit=38530
                                                        ->  Nested Loop  (cost=113.53..70843.17 rows=1 width=267) (actual time=10.701..41.879 rows=1 loops=1)
                                                              Join Filter: (t.id = c.technology_id)
                                                              Rows Removed by Join Filter: 8
                                                              Buffers: shared hit=38529
                                                              ->  Nested Loop  (cost=113.53..70841.86 rows=1 width=272) (actual time=10.687..41.863 rows=1 loops=1)
                                                                    Buffers: shared hit=38528
                                                                    ->  Bitmap Heap Scan on candidate c  (cost=113.24..1721.05 rows=6368 width=261) (actual time=3.526..10.833 rows=6186 loops=1)
                                                                          Recheck Cond: ((recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (gh_location_id IS NOT NULL) OR ((visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))))
                                                                          Filter: (((recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (location_id = ANY ('{}'::uuid[])) OR ((visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[])))) AND ($0 OR (recruiter_id = ANY ($1)) OR (team_id = ANY ($2)) OR (location_id = ANY ($3)) OR ($4 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 7)))
                                                                          Heap Blocks: exact=1151
                                                                          Buffers: shared hit=1288
                                                                          ->  BitmapOr  (cost=112.89..112.89 rows=6621 width=0) (actual time=0.238..0.241 rows=0 loops=1)
                                                                                Buffers: shared hit=13
                                                                                ->  Bitmap Index Scan on candidate_recruiter  (cost=0.00..7.09 rows=374 width=0) (actual time=0.013..0.013 rows=0 loops=1)
                                                                                      Index Cond: (recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[]))
                                                                                      Buffers: shared hit=2
                                                                                ->  Bitmap Index Scan on candidate_team  (cost=0.00..24.45 rows=1622 width=0) (actual time=0.039..0.039 rows=1667 loops=1)
                                                                                      Index Cond: (team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[]))
                                                                                      Buffers: shared hit=3
                                                                                ->  Bitmap Index Scan on candidate_gh_location  (cost=0.00..4.13 rows=1 width=0) (actual time=0.003..0.004 rows=0 loops=1)
                                                                                      Buffers: shared hit=1
                                                                                ->  Bitmap Index Scan on candidate_visibility  (cost=0.00..70.84 rows=4626 width=0) (actual time=0.182..0.182 rows=4672 loops=1)
                                                                                      Index Cond: ((visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[])))
                                                                                      Buffers: shared hit=7
                                                                          SubPlan 7
                                                                            ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                  InitPlan 6 (returns $5)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                  ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                    ->  Index Scan using person_pkey on person p  (cost=0.29..10.85 rows=1 width=43) (actual time=0.005..0.005 rows=0 loops=6186)
                                                                          Index Cond: (id = c.person_id)
                                                                          Filter: ((SubPlan 15) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                                          Rows Removed by Filter: 1
                                                                          Buffers: shared hit=37240
                                                                          SubPlan 15
                                                                            ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=6186)
                                                                                  Index Cond: (person_id = p.id)
                                                                                  Filter: ($8 OR (recruiter_id = ANY ($9)) OR (team_id = ANY ($10)) OR (location_id = ANY ($11)) OR ($12 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 14))
                                                                                  Buffers: shared hit=18682
                                                                                  InitPlan 8 (returns $8)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.428..0.428 rows=1 loops=1)
                                                                                          Buffers: shared hit=20
                                                                                  InitPlan 9 (returns $9)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.831..0.831 rows=1 loops=1)
                                                                                          Buffers: shared hit=40
                                                                                  InitPlan 10 (returns $10)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.210..1.210 rows=1 loops=1)
                                                                                          Buffers: shared hit=24
                                                                                  InitPlan 11 (returns $11)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.493..0.494 rows=1 loops=1)
                                                                                          Buffers: shared hit=20
                                                                                  InitPlan 12 (returns $12)
                                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.497..0.497 rows=1 loops=1)
                                                                                          Buffers: shared hit=20
                                                                                  SubPlan 14
                                                                                    ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                          InitPlan 13 (returns $13)
                                                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                          ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                              ->  Seq Scan on technology t  (cost=0.00..1.14 rows=14 width=27) (actual time=0.009..0.010 rows=9 loops=1)
                                                                    Buffers: shared hit=1
                                                        ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.002..0.003 rows=1 loops=1)
                                                              Buffers: shared hit=1
                                                  ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.002..0.003 rows=1 loops=1)
                                                        Buffers: shared hit=1
                                            ->  Seq Scan on app_user u  (cost=0.00..269.68 rows=168 width=33) (actual time=0.004..0.195 rows=89 loops=1)
                                                  Buffers: shared hit=260
                                      ->  Seq Scan on app_user lu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.002..0.003 rows=15 loops=1)
                                            Buffers: shared hit=3
                                ->  Seq Scan on batch b  (cost=0.00..0.00 rows=1 width=84) (actual time=0.003..0.003 rows=0 loops=1)
                                      Filter: ($23 OR $24)
                          ->  Seq Scan on technology bt  (cost=0.00..1.14 rows=14 width=27) (actual time=0.002..0.003 rows=14 loops=1)
                                Buffers: shared hit=1
                    ->  Seq Scan on location bl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=1)
                          Buffers: shared hit=1
              ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.001..0.002 rows=4 loops=1)
                    Buffers: shared hit=1
Planning:
  Buffers: shared hit=54
Planning Time: 8.855 ms
Execution Time: 42.475 ms
```

#### hotlist_page/org, term `Zebrowski`, before (median exec 15.0 ms)

```text
Nested Loop  (cost=1491.03..1546.27 rows=4 width=334) (actual time=16.382..16.424 rows=5 loops=1)
  Buffers: shared hit=882
  CTE s
    ->  Result  (cost=0.00..2.76 rows=1 width=260) (actual time=8.843..8.844 rows=1 loops=1)
          Buffers: shared hit=261
  ->  Nested Loop Left Join  (cost=1488.27..1542.62 rows=4 width=285) (actual time=16.371..16.408 rows=5 loops=1)
        Buffers: shared hit=882
        ->  Nested Loop Left Join  (cost=1488.00..1522.74 rows=4 width=284) (actual time=16.364..16.392 rows=5 loops=1)
              Buffers: shared hit=867
              ->  Nested Loop Left Join  (cost=1487.73..1493.49 rows=4 width=267) (actual time=16.354..16.370 rows=5 loops=1)
                    Join Filter: (gl.id = c.gh_location_id)
                    Rows Removed by Join Filter: 20
                    Buffers: shared hit=852
                    ->  Nested Loop  (cost=1487.73..1492.20 rows=4 width=275) (actual time=16.347..16.360 rows=5 loops=1)
                          Join Filter: (l.id = c.location_id)
                          Rows Removed by Join Filter: 5
                          Buffers: shared hit=851
                          ->  Nested Loop  (cost=1487.73..1490.95 rows=4 width=267) (actual time=16.339..16.350 rows=5 loops=1)
                                Join Filter: (tm.id = c.team_id)
                                Rows Removed by Join Filter: 49
                                Buffers: shared hit=850
                                ->  Limit  (cost=1487.73..1487.74 rows=4 width=558) (actual time=16.320..16.325 rows=5 loops=1)
                                      Buffers: shared hit=849
                                      InitPlan 4 (returns $3)
                                        ->  CTE Scan on s s_1  (cost=0.00..0.02 rows=1 width=32) (actual time=0.001..0.002 rows=1 loops=1)
                                      InitPlan 5 (returns $4)
                                        ->  CTE Scan on s s_2  (cost=0.00..0.02 rows=1 width=1) (actual time=8.847..8.848 rows=1 loops=1)
                                              Buffers: shared hit=261
                                      ->  Sort  (cost=1487.69..1487.70 rows=4 width=558) (actual time=16.318..16.321 rows=5 loops=1)
                                            Sort Key: (CASE $3 WHEN 'priority'::text THEN c.priority WHEN 'days'::text THEN COALESCE((c.marketing_start_date)::text, '9999-12-31'::text) WHEN 'name'::text THEN lower(((p.first_name || ' '::text) || p.last_name)) ELSE ''::text END), c.id
                                            Sort Method: quicksort  Memory: 26kB
                                            Buffers: shared hit=849
                                            ->  Result  (cost=0.29..1487.65 rows=4 width=558) (actual time=16.288..16.304 rows=5 loops=1)
                                                  One-Time Filter: $4
                                                  Buffers: shared hit=849
                                                  ->  Nested Loop  (cost=0.29..1487.57 rows=4 width=237) (actual time=7.418..7.430 rows=5 loops=1)
                                                        Join Filter: (t.id = c.technology_id)
                                                        Rows Removed by Join Filter: 65
                                                        Buffers: shared hit=588
                                                        ->  Seq Scan on technology t  (cost=0.00..1.14 rows=14 width=27) (actual time=0.003..0.005 rows=14 loops=1)
                                                              Buffers: shared hit=1
                                                        ->  Materialize  (cost=0.29..1485.60 rows=4 width=242) (actual time=0.527..0.529 rows=5 loops=14)
                                                              Buffers: shared hit=587
                                                              ->  Nested Loop  (cost=0.29..1485.58 rows=4 width=242) (actual time=7.373..7.395 rows=5 loops=1)
                                                                    Buffers: shared hit=587
                                                                    ->  Seq Scan on person p  (cost=0.00..1444.00 rows=5 width=41) (actual time=7.332..7.334 rows=6 loops=1)
                                                                          Filter: (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text)
                                                                          Rows Removed by Filter: 49994
                                                                          Buffers: shared hit=569
                                                                    ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.29..8.31 rows=1 width=233) (actual time=0.008..0.008 rows=1 loops=6)
                                                                          Index Cond: (person_id = p.id)
                                                                          Filter: (marketing_status = ANY ('{active,on_hold,full_of_interviews,confirmation,bench,stopped}'::text[]))
                                                                          Rows Removed by Filter: 0
                                                                          Buffers: shared hit=18
                                                  SubPlan 2
                                                    ->  Seq Scan on resume r  (cost=0.00..0.00 rows=1 width=0) (actual time=0.002..0.002 rows=0 loops=5)
                                                          Filter: (is_current AND (candidate_id = c.id))
                                ->  Materialize  (cost=0.00..1.45 rows=30 width=45) (actual time=0.001..0.003 rows=11 loops=5)
                                      Buffers: shared hit=1
                                      ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.005..0.007 rows=26 loops=1)
                                            Buffers: shared hit=1
                          ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.001..0.001 rows=2 loops=5)
                                Buffers: shared hit=1
                                ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.003..0.003 rows=3 loops=1)
                                      Buffers: shared hit=1
                    ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=5)
                          Buffers: shared hit=1
                          ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.002..0.002 rows=4 loops=1)
                                Buffers: shared hit=1
              ->  Index Scan using app_user_pkey on app_user u  (cost=0.27..7.29 rows=1 width=33) (actual time=0.003..0.003 rows=1 loops=5)
                    Index Cond: (id = c.recruiter_id)
                    Buffers: shared hit=15
        ->  Index Scan using app_user_pkey on app_user lu  (cost=0.27..4.96 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=5)
              Index Cond: (id = tm.lead_id)
              Buffers: shared hit=15
  ->  CTE Scan on s  (cost=0.00..0.02 rows=1 width=227) (actual time=0.000..0.000 rows=1 loops=5)
Planning:
  Buffers: shared hit=48
Planning Time: 1.758 ms
Execution Time: 16.587 ms
```

#### hotlist_page/org, term `Zebrowski`, after (median exec 12.2 ms)

```text
Sort  (cost=186.61..186.62 rows=4 width=334) (actual time=7.897..7.904 rows=5 loops=1)
  Sort Key: h.sk, h.id
  Sort Method: quicksort  Memory: 26kB
  Buffers: shared hit=338
  CTE s
    ->  Result  (cost=0.00..2.76 rows=1 width=260) (actual time=7.661..7.662 rows=1 loops=1)
          Buffers: shared hit=261
  ->  Nested Loop  (cost=132.87..183.81 rows=4 width=334) (actual time=7.853..7.887 rows=5 loops=1)
        Buffers: shared hit=338
        ->  CTE Scan on s  (cost=0.00..0.02 rows=1 width=227) (actual time=7.664..7.665 rows=1 loops=1)
              Buffers: shared hit=261
        ->  Nested Loop Left Join  (cost=132.87..182.95 rows=4 width=285) (actual time=0.178..0.208 rows=5 loops=1)
              Buffers: shared hit=77
              ->  Nested Loop Left Join  (cost=132.60..163.06 rows=4 width=284) (actual time=0.171..0.192 rows=5 loops=1)
                    Buffers: shared hit=62
                    ->  Hash Left Join  (cost=132.33..133.82 rows=4 width=267) (actual time=0.165..0.177 rows=5 loops=1)
                          Hash Cond: (h.gh_location_id = gl.id)
                          Buffers: shared hit=47
                          ->  Hash Join  (cost=131.24..132.72 rows=4 width=275) (actual time=0.157..0.168 rows=5 loops=1)
                                Hash Cond: (h.location_id = l.id)
                                Buffers: shared hit=46
                                ->  Hash Join  (cost=130.15..131.60 rows=4 width=267) (actual time=0.143..0.152 rows=5 loops=1)
                                      Hash Cond: (tm.id = h.team_id)
                                      Buffers: shared hit=45
                                      ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.001..0.003 rows=30 loops=1)
                                            Buffers: shared hit=1
                                      ->  Hash  (cost=130.10..130.10 rows=4 width=238) (actual time=0.136..0.139 rows=5 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                            Buffers: shared hit=44
                                            ->  Subquery Scan on h  (cost=130.05..130.10 rows=4 width=238) (actual time=0.129..0.135 rows=5 loops=1)
                                                  Buffers: shared hit=44
                                                  ->  Limit  (cost=130.05..130.06 rows=4 width=558) (actual time=0.126..0.131 rows=5 loops=1)
                                                        Buffers: shared hit=44
                                                        InitPlan 4 (returns $3)
                                                          ->  CTE Scan on s s_1  (cost=0.00..0.02 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=1)
                                                        InitPlan 5 (returns $4)
                                                          ->  CTE Scan on s s_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.002 rows=1 loops=1)
                                                        ->  Sort  (cost=130.01..130.02 rows=4 width=558) (actual time=0.125..0.128 rows=5 loops=1)
                                                              Sort Key: (CASE $3 WHEN 'priority'::text THEN c.priority WHEN 'days'::text THEN COALESCE((c.marketing_start_date)::text, '9999-12-31'::text) WHEN 'name'::text THEN lower(((p.first_name || ' '::text) || p.last_name)) ELSE ''::text END), c.id
                                                              Sort Method: quicksort  Memory: 26kB
                                                              Buffers: shared hit=44
                                                              ->  Result  (cost=69.41..129.97 rows=4 width=558) (actual time=0.089..0.117 rows=5 loops=1)
                                                                    One-Time Filter: $4
                                                                    Buffers: shared hit=44
                                                                    ->  Nested Loop  (cost=69.41..129.89 rows=4 width=237) (actual time=0.074..0.097 rows=5 loops=1)
                                                                          Buffers: shared hit=44
                                                                          ->  Nested Loop  (cost=69.27..129.24 rows=4 width=242) (actual time=0.066..0.086 rows=5 loops=1)
                                                                                Buffers: shared hit=34
                                                                                ->  Bitmap Heap Scan on person p  (cost=68.98..87.67 rows=5 width=41) (actual time=0.045..0.047 rows=6 loops=1)
                                                                                      Recheck Cond: (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text)
                                                                                      Heap Blocks: exact=1
                                                                                      Buffers: shared hit=16
                                                                                      ->  Bitmap Index Scan on person_name_trgm  (cost=0.00..68.98 rows=5 width=0) (actual time=0.036..0.037 rows=6 loops=1)
                                                                                            Index Cond: (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text)
                                                                                            Buffers: shared hit=15
                                                                                ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.29..8.31 rows=1 width=233) (actual time=0.005..0.005 rows=1 loops=6)
                                                                                      Index Cond: (person_id = p.id)
                                                                                      Filter: (marketing_status = ANY ('{active,on_hold,full_of_interviews,confirmation,bench,stopped}'::text[]))
                                                                                      Rows Removed by Filter: 0
                                                                                      Buffers: shared hit=18
                                                                          ->  Index Scan using technology_pkey on technology t  (cost=0.14..0.15 rows=1 width=27) (actual time=0.001..0.001 rows=1 loops=5)
                                                                                Index Cond: (id = c.technology_id)
                                                                                Buffers: shared hit=10
                                                                    SubPlan 2
                                                                      ->  Seq Scan on resume r  (cost=0.00..0.00 rows=1 width=0) (actual time=0.001..0.001 rows=0 loops=5)
                                                                            Filter: (is_current AND (candidate_id = c.id))
                                ->  Hash  (cost=1.04..1.04 rows=4 width=24) (actual time=0.008..0.008 rows=4 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                      Buffers: shared hit=1
                                      ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.005..0.005 rows=4 loops=1)
                                            Buffers: shared hit=1
                          ->  Hash  (cost=1.04..1.04 rows=4 width=24) (actual time=0.003..0.003 rows=4 loops=1)
                                Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                Buffers: shared hit=1
                                ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=1)
                                      Buffers: shared hit=1
                    ->  Index Scan using app_user_pkey on app_user u  (cost=0.27..7.29 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=5)
                          Index Cond: (id = h.recruiter_id)
                          Buffers: shared hit=15
              ->  Index Scan using app_user_pkey on app_user lu  (cost=0.27..4.96 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=5)
                    Index Cond: (id = tm.lead_id)
                    Buffers: shared hit=15
Planning:
  Buffers: shared hit=49
Planning Time: 1.964 ms
Execution Time: 8.075 ms
```

#### hotlist_page/team, term `Zebrowski`, before (median exec 21.7 ms)

```text
Nested Loop  (cost=1491.03..1546.27 rows=4 width=334) (actual time=21.751..21.821 rows=5 loops=1)
  Buffers: shared hit=876
  CTE s
    ->  Result  (cost=0.00..2.76 rows=1 width=260) (actual time=10.652..10.652 rows=1 loops=1)
          Buffers: shared hit=255
  ->  Nested Loop Left Join  (cost=1488.27..1542.62 rows=4 width=285) (actual time=21.690..21.745 rows=5 loops=1)
        Buffers: shared hit=876
        ->  Nested Loop Left Join  (cost=1488.00..1522.74 rows=4 width=284) (actual time=21.682..21.722 rows=5 loops=1)
              Buffers: shared hit=861
              ->  Nested Loop Left Join  (cost=1487.73..1493.49 rows=4 width=267) (actual time=21.668..21.689 rows=5 loops=1)
                    Join Filter: (gl.id = c.gh_location_id)
                    Rows Removed by Join Filter: 20
                    Buffers: shared hit=846
                    ->  Nested Loop  (cost=1487.73..1492.20 rows=4 width=275) (actual time=21.658..21.675 rows=5 loops=1)
                          Join Filter: (l.id = c.location_id)
                          Rows Removed by Join Filter: 5
                          Buffers: shared hit=845
                          ->  Nested Loop  (cost=1487.73..1490.95 rows=4 width=267) (actual time=21.649..21.662 rows=5 loops=1)
                                Join Filter: (tm.id = c.team_id)
                                Rows Removed by Join Filter: 49
                                Buffers: shared hit=844
                                ->  Limit  (cost=1487.73..1487.74 rows=4 width=558) (actual time=21.624..21.630 rows=5 loops=1)
                                      Buffers: shared hit=843
                                      InitPlan 4 (returns $3)
                                        ->  CTE Scan on s s_1  (cost=0.00..0.02 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=1)
                                      InitPlan 5 (returns $4)
                                        ->  CTE Scan on s s_2  (cost=0.00..0.02 rows=1 width=1) (actual time=10.656..10.657 rows=1 loops=1)
                                              Buffers: shared hit=255
                                      ->  Sort  (cost=1487.69..1487.70 rows=4 width=558) (actual time=21.623..21.626 rows=5 loops=1)
                                            Sort Key: (CASE $3 WHEN 'priority'::text THEN c.priority WHEN 'days'::text THEN COALESCE((c.marketing_start_date)::text, '9999-12-31'::text) WHEN 'name'::text THEN lower(((p.first_name || ' '::text) || p.last_name)) ELSE ''::text END), c.id
                                            Sort Method: quicksort  Memory: 26kB
                                            Buffers: shared hit=843
                                            ->  Result  (cost=0.29..1487.65 rows=4 width=558) (actual time=21.581..21.604 rows=5 loops=1)
                                                  One-Time Filter: $4
                                                  Buffers: shared hit=843
                                                  ->  Nested Loop  (cost=0.29..1487.57 rows=4 width=237) (actual time=10.897..10.915 rows=5 loops=1)
                                                        Join Filter: (t.id = c.technology_id)
                                                        Rows Removed by Join Filter: 65
                                                        Buffers: shared hit=588
                                                        ->  Seq Scan on technology t  (cost=0.00..1.14 rows=14 width=27) (actual time=0.003..0.006 rows=14 loops=1)
                                                              Buffers: shared hit=1
                                                        ->  Materialize  (cost=0.29..1485.60 rows=4 width=242) (actual time=0.775..0.778 rows=5 loops=14)
                                                              Buffers: shared hit=587
                                                              ->  Nested Loop  (cost=0.29..1485.58 rows=4 width=242) (actual time=10.845..10.871 rows=5 loops=1)
                                                                    Buffers: shared hit=587
                                                                    ->  Seq Scan on person p  (cost=0.00..1444.00 rows=5 width=41) (actual time=10.789..10.792 rows=6 loops=1)
                                                                          Filter: (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text)
                                                                          Rows Removed by Filter: 49994
                                                                          Buffers: shared hit=569
                                                                    ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.29..8.31 rows=1 width=233) (actual time=0.011..0.011 rows=1 loops=6)
                                                                          Index Cond: (person_id = p.id)
                                                                          Filter: (marketing_status = ANY ('{active,on_hold,full_of_interviews,confirmation,bench,stopped}'::text[]))
                                                                          Rows Removed by Filter: 0
                                                                          Buffers: shared hit=18
                                                  SubPlan 2
                                                    ->  Seq Scan on resume r  (cost=0.00..0.00 rows=1 width=0) (actual time=0.002..0.002 rows=0 loops=5)
                                                          Filter: (is_current AND (candidate_id = c.id))
                                ->  Materialize  (cost=0.00..1.45 rows=30 width=45) (actual time=0.002..0.004 rows=11 loops=5)
                                      Buffers: shared hit=1
                                      ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.006..0.009 rows=26 loops=1)
                                            Buffers: shared hit=1
                          ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.001..0.002 rows=2 loops=5)
                                Buffers: shared hit=1
                                ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.004..0.005 rows=3 loops=1)
                                      Buffers: shared hit=1
                    ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=5)
                          Buffers: shared hit=1
                          ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.001..0.002 rows=4 loops=1)
                                Buffers: shared hit=1
              ->  Index Scan using app_user_pkey on app_user u  (cost=0.27..7.29 rows=1 width=33) (actual time=0.005..0.005 rows=1 loops=5)
                    Index Cond: (id = c.recruiter_id)
                    Buffers: shared hit=15
        ->  Index Scan using app_user_pkey on app_user lu  (cost=0.27..4.96 rows=1 width=33) (actual time=0.003..0.003 rows=1 loops=5)
              Index Cond: (id = tm.lead_id)
              Buffers: shared hit=15
  ->  CTE Scan on s  (cost=0.00..0.02 rows=1 width=227) (actual time=0.000..0.000 rows=1 loops=5)
Planning:
  Buffers: shared hit=48
Planning Time: 2.618 ms
Execution Time: 22.089 ms
```

#### hotlist_page/team, term `Zebrowski`, after (median exec 8.0 ms)

```text
Sort  (cost=186.61..186.62 rows=4 width=334) (actual time=7.928..7.935 rows=5 loops=1)
  Sort Key: h.sk, h.id
  Sort Method: quicksort  Memory: 26kB
  Buffers: shared hit=332
  CTE s
    ->  Result  (cost=0.00..2.76 rows=1 width=260) (actual time=7.671..7.672 rows=1 loops=1)
          Buffers: shared hit=255
  ->  Nested Loop  (cost=132.87..183.81 rows=4 width=334) (actual time=7.876..7.920 rows=5 loops=1)
        Buffers: shared hit=332
        ->  CTE Scan on s  (cost=0.00..0.02 rows=1 width=227) (actual time=7.675..7.675 rows=1 loops=1)
              Buffers: shared hit=255
        ->  Nested Loop Left Join  (cost=132.87..182.95 rows=4 width=285) (actual time=0.179..0.211 rows=5 loops=1)
              Buffers: shared hit=77
              ->  Nested Loop Left Join  (cost=132.60..163.06 rows=4 width=284) (actual time=0.175..0.198 rows=5 loops=1)
                    Buffers: shared hit=62
                    ->  Hash Left Join  (cost=132.33..133.82 rows=4 width=267) (actual time=0.168..0.180 rows=5 loops=1)
                          Hash Cond: (h.gh_location_id = gl.id)
                          Buffers: shared hit=47
                          ->  Hash Join  (cost=131.24..132.72 rows=4 width=275) (actual time=0.160..0.172 rows=5 loops=1)
                                Hash Cond: (h.location_id = l.id)
                                Buffers: shared hit=46
                                ->  Hash Join  (cost=130.15..131.60 rows=4 width=267) (actual time=0.146..0.156 rows=5 loops=1)
                                      Hash Cond: (tm.id = h.team_id)
                                      Buffers: shared hit=45
                                      ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.001..0.003 rows=30 loops=1)
                                            Buffers: shared hit=1
                                      ->  Hash  (cost=130.10..130.10 rows=4 width=238) (actual time=0.138..0.142 rows=5 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                            Buffers: shared hit=44
                                            ->  Subquery Scan on h  (cost=130.05..130.10 rows=4 width=238) (actual time=0.132..0.137 rows=5 loops=1)
                                                  Buffers: shared hit=44
                                                  ->  Limit  (cost=130.05..130.06 rows=4 width=558) (actual time=0.130..0.134 rows=5 loops=1)
                                                        Buffers: shared hit=44
                                                        InitPlan 4 (returns $3)
                                                          ->  CTE Scan on s s_1  (cost=0.00..0.02 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=1)
                                                        InitPlan 5 (returns $4)
                                                          ->  CTE Scan on s s_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.002 rows=1 loops=1)
                                                        ->  Sort  (cost=130.01..130.02 rows=4 width=558) (actual time=0.129..0.131 rows=5 loops=1)
                                                              Sort Key: (CASE $3 WHEN 'priority'::text THEN c.priority WHEN 'days'::text THEN COALESCE((c.marketing_start_date)::text, '9999-12-31'::text) WHEN 'name'::text THEN lower(((p.first_name || ' '::text) || p.last_name)) ELSE ''::text END), c.id
                                                              Sort Method: quicksort  Memory: 26kB
                                                              Buffers: shared hit=44
                                                              ->  Result  (cost=69.41..129.97 rows=4 width=558) (actual time=0.092..0.120 rows=5 loops=1)
                                                                    One-Time Filter: $4
                                                                    Buffers: shared hit=44
                                                                    ->  Nested Loop  (cost=69.41..129.89 rows=4 width=237) (actual time=0.077..0.102 rows=5 loops=1)
                                                                          Buffers: shared hit=44
                                                                          ->  Nested Loop  (cost=69.27..129.24 rows=4 width=242) (actual time=0.068..0.088 rows=5 loops=1)
                                                                                Buffers: shared hit=34
                                                                                ->  Bitmap Heap Scan on person p  (cost=68.98..87.67 rows=5 width=41) (actual time=0.047..0.049 rows=6 loops=1)
                                                                                      Recheck Cond: (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text)
                                                                                      Heap Blocks: exact=1
                                                                                      Buffers: shared hit=16
                                                                                      ->  Bitmap Index Scan on person_name_trgm  (cost=0.00..68.98 rows=5 width=0) (actual time=0.038..0.038 rows=6 loops=1)
                                                                                            Index Cond: (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text)
                                                                                            Buffers: shared hit=15
                                                                                ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.29..8.31 rows=1 width=233) (actual time=0.006..0.006 rows=1 loops=6)
                                                                                      Index Cond: (person_id = p.id)
                                                                                      Filter: (marketing_status = ANY ('{active,on_hold,full_of_interviews,confirmation,bench,stopped}'::text[]))
                                                                                      Rows Removed by Filter: 0
                                                                                      Buffers: shared hit=18
                                                                          ->  Index Scan using technology_pkey on technology t  (cost=0.14..0.15 rows=1 width=27) (actual time=0.001..0.002 rows=1 loops=5)
                                                                                Index Cond: (id = c.technology_id)
                                                                                Buffers: shared hit=10
                                                                    SubPlan 2
                                                                      ->  Seq Scan on resume r  (cost=0.00..0.00 rows=1 width=0) (actual time=0.001..0.001 rows=0 loops=5)
                                                                            Filter: (is_current AND (candidate_id = c.id))
                                ->  Hash  (cost=1.04..1.04 rows=4 width=24) (actual time=0.008..0.009 rows=4 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                      Buffers: shared hit=1
                                      ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.004..0.005 rows=4 loops=1)
                                            Buffers: shared hit=1
                          ->  Hash  (cost=1.04..1.04 rows=4 width=24) (actual time=0.003..0.003 rows=4 loops=1)
                                Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                Buffers: shared hit=1
                                ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.001..0.002 rows=4 loops=1)
                                      Buffers: shared hit=1
                    ->  Index Scan using app_user_pkey on app_user u  (cost=0.27..7.29 rows=1 width=33) (actual time=0.002..0.003 rows=1 loops=5)
                          Index Cond: (id = h.recruiter_id)
                          Buffers: shared hit=15
              ->  Index Scan using app_user_pkey on app_user lu  (cost=0.27..4.96 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=5)
                    Index Cond: (id = tm.lead_id)
                    Buffers: shared hit=15
Planning:
  Buffers: shared hit=49
Planning Time: 1.914 ms
Execution Time: 8.105 ms
```

#### hotlist_page/org, term `an`, before (median exec 60.4 ms)

```text
Nested Loop  (cost=4211.02..4620.75 rows=51 width=334) (actual time=77.874..78.185 rows=51 loops=1)
  Buffers: shared hit=2289
  CTE s
    ->  Result  (cost=0.00..2.76 rows=1 width=260) (actual time=8.388..8.388 rows=1 loops=1)
          Buffers: shared hit=261
  ->  Nested Loop Left Join  (cost=4208.26..4606.76 rows=51 width=285) (actual time=77.861..78.136 rows=51 loops=1)
        Buffers: shared hit=2289
        ->  Nested Loop Left Join  (cost=4207.98..4454.73 rows=51 width=284) (actual time=77.851..78.068 rows=51 loops=1)
              Buffers: shared hit=2217
              ->  Nested Loop Left Join  (cost=4207.71..4227.89 rows=51 width=267) (actual time=77.836..77.978 rows=51 loops=1)
                    Join Filter: (gl.id = c.gh_location_id)
                    Rows Removed by Join Filter: 204
                    Buffers: shared hit=2082
                    ->  Nested Loop  (cost=4207.71..4223.78 rows=51 width=275) (actual time=77.824..77.914 rows=51 loops=1)
                          Buffers: shared hit=2081
                          ->  Nested Loop  (cost=4207.57..4220.89 rows=51 width=267) (actual time=77.811..77.878 rows=51 loops=1)
                                Buffers: shared hit=2073
                                ->  Limit  (cost=4207.42..4207.55 rows=51 width=558) (actual time=77.781..77.794 rows=51 loops=1)
                                      Buffers: shared hit=2025
                                      InitPlan 4 (returns $3)
                                        ->  CTE Scan on s s_1  (cost=0.00..0.02 rows=1 width=32) (actual time=0.002..0.003 rows=1 loops=1)
                                      InitPlan 5 (returns $4)
                                        ->  CTE Scan on s s_2  (cost=0.00..0.02 rows=1 width=1) (actual time=8.391..8.392 rows=1 loops=1)
                                              Buffers: shared hit=261
                                      ->  Sort  (cost=4207.38..4227.70 rows=8126 width=558) (actual time=77.779..77.786 rows=51 loops=1)
                                            Sort Key: (CASE $3 WHEN 'priority'::text THEN c.priority WHEN 'days'::text THEN COALESCE((c.marketing_start_date)::text, '9999-12-31'::text) WHEN 'name'::text THEN lower(((p.first_name || ' '::text) || p.last_name)) ELSE ''::text END), c.id
                                            Sort Method: top-N heapsort  Memory: 46kB
                                            Buffers: shared hit=2025
                                            ->  Result  (cost=1570.32..3936.28 rows=8126 width=558) (actual time=19.914..68.072 rows=10144 loops=1)
                                                  One-Time Filter: $4
                                                  Buffers: shared hit=2025
                                                  ->  Hash Join  (cost=1570.32..3773.76 rows=8126 width=237) (actual time=11.497..52.741 rows=10144 loops=1)
                                                        Hash Cond: (c.technology_id = t.id)
                                                        Buffers: shared hit=1764
                                                        ->  Hash Join  (cost=1569.00..3744.66 rows=8126 width=242) (actual time=11.479..50.400 rows=10144 loops=1)
                                                              Hash Cond: (c.person_id = p.id)
                                                              Buffers: shared hit=1763
                                                              ->  Seq Scan on candidate c  (cost=0.00..2069.00 rows=40630 width=233) (actual time=0.006..25.678 rows=40592 loops=1)
                                                                    Filter: (marketing_status = ANY ('{active,on_hold,full_of_interviews,confirmation,bench,stopped}'::text[]))
                                                                    Rows Removed by Filter: 9408
                                                                    Buffers: shared hit=1194
                                                              ->  Hash  (cost=1444.00..1444.00 rows=10000 width=41) (actual time=11.266..11.267 rows=12501 loops=1)
                                                                    Buckets: 16384  Batches: 1  Memory Usage: 1029kB
                                                                    Buffers: shared hit=569
                                                                    ->  Seq Scan on person p  (cost=0.00..1444.00 rows=10000 width=41) (actual time=0.008..9.173 rows=12501 loops=1)
                                                                          Filter: (((first_name || ' '::text) || last_name) ~~* '%an%'::text)
                                                                          Rows Removed by Filter: 37499
                                                                          Buffers: shared hit=569
                                                        ->  Hash  (cost=1.14..1.14 rows=14 width=27) (actual time=0.010..0.011 rows=14 loops=1)
                                                              Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                                              Buffers: shared hit=1
                                                              ->  Seq Scan on technology t  (cost=0.00..1.14 rows=14 width=27) (actual time=0.004..0.006 rows=14 loops=1)
                                                                    Buffers: shared hit=1
                                                  SubPlan 2
                                                    ->  Seq Scan on resume r  (cost=0.00..0.00 rows=1 width=0) (actual time=0.000..0.000 rows=0 loops=10144)
                                                          Filter: (is_current AND (candidate_id = c.id))
                                ->  Memoize  (cost=0.15..0.40 rows=1 width=45) (actual time=0.001..0.001 rows=1 loops=51)
                                      Cache Key: c.team_id
                                      Cache Mode: logical
                                      Hits: 27  Misses: 24  Evictions: 0  Overflows: 0  Memory Usage: 4kB
                                      Buffers: shared hit=48
                                      ->  Index Scan using team_pkey on team tm  (cost=0.14..0.39 rows=1 width=45) (actual time=0.001..0.001 rows=1 loops=24)
                                            Index Cond: (id = c.team_id)
                                            Buffers: shared hit=48
                          ->  Memoize  (cost=0.14..0.39 rows=1 width=24) (actual time=0.000..0.000 rows=1 loops=51)
                                Cache Key: c.location_id
                                Cache Mode: logical
                                Hits: 47  Misses: 4  Evictions: 0  Overflows: 0  Memory Usage: 1kB
                                Buffers: shared hit=8
                                ->  Index Scan using location_pkey on location l  (cost=0.13..0.38 rows=1 width=24) (actual time=0.002..0.002 rows=1 loops=4)
                                      Index Cond: (id = c.location_id)
                                      Buffers: shared hit=8
                    ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.001..0.001 rows=4 loops=51)
                          Buffers: shared hit=1
                          ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.004..0.005 rows=4 loops=1)
                                Buffers: shared hit=1
              ->  Index Scan using app_user_pkey on app_user u  (cost=0.27..4.45 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=51)
                    Index Cond: (id = c.recruiter_id)
                    Buffers: shared hit=135
        ->  Memoize  (cost=0.28..4.97 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=51)
              Cache Key: tm.lead_id
              Cache Mode: logical
              Hits: 27  Misses: 24  Evictions: 0  Overflows: 0  Memory Usage: 4kB
              Buffers: shared hit=72
              ->  Index Scan using app_user_pkey on app_user lu  (cost=0.27..4.96 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=24)
                    Index Cond: (id = tm.lead_id)
                    Buffers: shared hit=72
  ->  CTE Scan on s  (cost=0.00..0.02 rows=1 width=227) (actual time=0.000..0.000 rows=1 loops=51)
Planning:
  Buffers: shared hit=48
Planning Time: 1.727 ms
Execution Time: 78.378 ms
```

#### hotlist_page/org, term `an`, after (median exec 57.6 ms)

```text
Nested Loop  (cost=4211.02..4620.75 rows=51 width=334) (actual time=57.077..57.369 rows=51 loops=1)
  Buffers: shared hit=2289
  CTE s
    ->  Result  (cost=0.00..2.76 rows=1 width=260) (actual time=8.005..8.006 rows=1 loops=1)
          Buffers: shared hit=261
  ->  Nested Loop Left Join  (cost=4208.26..4606.76 rows=51 width=285) (actual time=57.064..57.326 rows=51 loops=1)
        Buffers: shared hit=2289
        ->  Nested Loop Left Join  (cost=4207.98..4454.73 rows=51 width=284) (actual time=57.057..57.262 rows=51 loops=1)
              Buffers: shared hit=2217
              ->  Nested Loop Left Join  (cost=4207.71..4227.89 rows=51 width=267) (actual time=57.046..57.181 rows=51 loops=1)
                    Join Filter: (gl.id = c.gh_location_id)
                    Rows Removed by Join Filter: 204
                    Buffers: shared hit=2082
                    ->  Nested Loop  (cost=4207.71..4223.78 rows=51 width=275) (actual time=57.036..57.140 rows=51 loops=1)
                          Buffers: shared hit=2081
                          ->  Nested Loop  (cost=4207.57..4220.89 rows=51 width=267) (actual time=57.023..57.103 rows=51 loops=1)
                                Buffers: shared hit=2073
                                ->  Limit  (cost=4207.42..4207.55 rows=51 width=558) (actual time=56.991..57.018 rows=51 loops=1)
                                      Buffers: shared hit=2025
                                      InitPlan 4 (returns $3)
                                        ->  CTE Scan on s s_1  (cost=0.00..0.02 rows=1 width=32) (actual time=0.003..0.004 rows=1 loops=1)
                                      InitPlan 5 (returns $4)
                                        ->  CTE Scan on s s_2  (cost=0.00..0.02 rows=1 width=1) (actual time=8.010..8.011 rows=1 loops=1)
                                              Buffers: shared hit=261
                                      ->  Sort  (cost=4207.38..4227.70 rows=8126 width=558) (actual time=56.988..56.995 rows=51 loops=1)
                                            Sort Key: (CASE $3 WHEN 'priority'::text THEN c.priority WHEN 'days'::text THEN COALESCE((c.marketing_start_date)::text, '9999-12-31'::text) WHEN 'name'::text THEN lower(((p.first_name || ' '::text) || p.last_name)) ELSE ''::text END), c.id
                                            Sort Method: top-N heapsort  Memory: 46kB
                                            Buffers: shared hit=2025
                                            ->  Result  (cost=1570.32..3936.28 rows=8126 width=558) (actual time=19.271..51.372 rows=10144 loops=1)
                                                  One-Time Filter: $4
                                                  Buffers: shared hit=2025
                                                  ->  Hash Join  (cost=1570.32..3773.76 rows=8126 width=237) (actual time=11.228..37.950 rows=10144 loops=1)
                                                        Hash Cond: (c.technology_id = t.id)
                                                        Buffers: shared hit=1764
                                                        ->  Hash Join  (cost=1569.00..3744.66 rows=8126 width=242) (actual time=11.210..35.948 rows=10144 loops=1)
                                                              Hash Cond: (c.person_id = p.id)
                                                              Buffers: shared hit=1763
                                                              ->  Seq Scan on candidate c  (cost=0.00..2069.00 rows=40630 width=233) (actual time=0.006..14.469 rows=40592 loops=1)
                                                                    Filter: (marketing_status = ANY ('{active,on_hold,full_of_interviews,confirmation,bench,stopped}'::text[]))
                                                                    Rows Removed by Filter: 9408
                                                                    Buffers: shared hit=1194
                                                              ->  Hash  (cost=1444.00..1444.00 rows=10000 width=41) (actual time=10.995..10.996 rows=12501 loops=1)
                                                                    Buckets: 16384  Batches: 1  Memory Usage: 1029kB
                                                                    Buffers: shared hit=569
                                                                    ->  Seq Scan on person p  (cost=0.00..1444.00 rows=10000 width=41) (actual time=0.009..9.006 rows=12501 loops=1)
                                                                          Filter: (((first_name || ' '::text) || last_name) ~~* '%an%'::text)
                                                                          Rows Removed by Filter: 37499
                                                                          Buffers: shared hit=569
                                                        ->  Hash  (cost=1.14..1.14 rows=14 width=27) (actual time=0.011..0.011 rows=14 loops=1)
                                                              Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                                              Buffers: shared hit=1
                                                              ->  Seq Scan on technology t  (cost=0.00..1.14 rows=14 width=27) (actual time=0.005..0.007 rows=14 loops=1)
                                                                    Buffers: shared hit=1
                                                  SubPlan 2
                                                    ->  Seq Scan on resume r  (cost=0.00..0.00 rows=1 width=0) (actual time=0.000..0.000 rows=0 loops=10144)
                                                          Filter: (is_current AND (candidate_id = c.id))
                                ->  Memoize  (cost=0.15..0.40 rows=1 width=45) (actual time=0.001..0.001 rows=1 loops=51)
                                      Cache Key: c.team_id
                                      Cache Mode: logical
                                      Hits: 27  Misses: 24  Evictions: 0  Overflows: 0  Memory Usage: 4kB
                                      Buffers: shared hit=48
                                      ->  Index Scan using team_pkey on team tm  (cost=0.14..0.39 rows=1 width=45) (actual time=0.001..0.001 rows=1 loops=24)
                                            Index Cond: (id = c.team_id)
                                            Buffers: shared hit=48
                          ->  Memoize  (cost=0.14..0.39 rows=1 width=24) (actual time=0.000..0.000 rows=1 loops=51)
                                Cache Key: c.location_id
                                Cache Mode: logical
                                Hits: 47  Misses: 4  Evictions: 0  Overflows: 0  Memory Usage: 1kB
                                Buffers: shared hit=8
                                ->  Index Scan using location_pkey on location l  (cost=0.13..0.38 rows=1 width=24) (actual time=0.002..0.002 rows=1 loops=4)
                                      Index Cond: (id = c.location_id)
                                      Buffers: shared hit=8
                    ->  Materialize  (cost=0.00..1.06 rows=4 width=24) (actual time=0.000..0.000 rows=4 loops=51)
                          Buffers: shared hit=1
                          ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.003..0.004 rows=4 loops=1)
                                Buffers: shared hit=1
              ->  Index Scan using app_user_pkey on app_user u  (cost=0.27..4.45 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=51)
                    Index Cond: (id = c.recruiter_id)
                    Buffers: shared hit=135
        ->  Memoize  (cost=0.28..4.97 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=51)
              Cache Key: tm.lead_id
              Cache Mode: logical
              Hits: 27  Misses: 24  Evictions: 0  Overflows: 0  Memory Usage: 4kB
              Buffers: shared hit=72
              ->  Index Scan using app_user_pkey on app_user lu  (cost=0.27..4.96 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=24)
                    Index Cond: (id = tm.lead_id)
                    Buffers: shared hit=72
  ->  CTE Scan on s  (cost=0.00..0.02 rows=1 width=227) (actual time=0.000..0.000 rows=1 loops=51)
Planning:
  Buffers: shared hit=49
Planning Time: 1.829 ms
Execution Time: 57.618 ms
```

#### hotlist_export/org, term `Zebrowski`, before (median exec 19.5 ms)

```text
Sort  (cost=1508.68..1508.69 rows=1 width=283) (actual time=19.204..19.211 rows=5 loops=1)
  Sort Key: h.sk, h.id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=1037
  CTE s
    ->  Result  (cost=0.00..4.26 rows=1 width=358) (actual time=11.840..11.841 rows=1 loops=1)
          Buffers: shared hit=412
  ->  Nested Loop Left Join  (cost=1490.12..1504.41 rows=1 width=283) (actual time=19.160..19.196 rows=5 loops=1)
        Buffers: shared hit=1037
        ->  Nested Loop Left Join  (cost=1489.85..1499.38 rows=1 width=236) (actual time=19.139..19.163 rows=5 loops=1)
              Buffers: shared hit=1022
              ->  Hash Join  (cost=1489.58..1491.00 rows=1 width=235) (actual time=19.130..19.143 rows=5 loops=1)
                    Hash Cond: (tm.id = h.team_id)
                    Buffers: shared hit=1007
                    ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.007..0.009 rows=30 loops=1)
                          Buffers: shared hit=1
                    ->  Hash  (cost=1489.57..1489.57 rows=1 width=222) (actual time=19.115..19.120 rows=5 loops=1)
                          Buckets: 1024  Batches: 1  Memory Usage: 9kB
                          Buffers: shared hit=1006
                          ->  Hash Right Join  (cost=1488.50..1489.57 rows=1 width=222) (actual time=19.107..19.115 rows=5 loops=1)
                                Hash Cond: (gl.id = h.gh_location_id)
                                Buffers: shared hit=1006
                                ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.002..0.002 rows=4 loops=1)
                                      Buffers: shared hit=1
                                ->  Hash  (cost=1488.49..1488.49 rows=1 width=230) (actual time=19.100..19.104 rows=5 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                      Buffers: shared hit=1005
                                      ->  Hash Join  (cost=1487.42..1488.49 rows=1 width=230) (actual time=19.093..19.100 rows=5 loops=1)
                                            Hash Cond: (l.id = h.location_id)
                                            Buffers: shared hit=1005
                                            ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.003..0.004 rows=4 loops=1)
                                                  Buffers: shared hit=1
                                            ->  Hash  (cost=1487.41..1487.41 rows=1 width=238) (actual time=19.082..19.086 rows=5 loops=1)
                                                  Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                                  Buffers: shared hit=1004
                                                  ->  Subquery Scan on h  (cost=1487.33..1487.41 rows=1 width=238) (actual time=19.071..19.078 rows=5 loops=1)
                                                        Buffers: shared hit=1004
                                                        ->  Limit  (cost=1487.33..1487.40 rows=1 width=558) (actual time=19.070..19.075 rows=5 loops=1)
                                                              Buffers: shared hit=1004
                                                              ->  Result  (cost=1487.33..1487.40 rows=1 width=558) (actual time=19.068..19.072 rows=5 loops=1)
                                                                    Buffers: shared hit=1004
                                                                    ->  Sort  (cost=1487.33..1487.34 rows=1 width=687) (actual time=19.063..19.065 rows=5 loops=1)
                                                                          Sort Key: c.id
                                                                          Sort Method: quicksort  Memory: 26kB
                                                                          Buffers: shared hit=1004
                                                                          ->  Nested Loop  (cost=0.29..1487.32 rows=1 width=687) (actual time=19.019..19.053 rows=5 loops=1)
                                                                                Join Filter: (t.id = c.technology_id)
                                                                                Rows Removed by Join Filter: 34
                                                                                Buffers: shared hit=1004
                                                                                ->  Nested Loop  (cost=0.29..1486.01 rows=1 width=340) (actual time=19.006..19.034 rows=5 loops=1)
                                                                                      Join Filter: (COALESCE((s.eo OR (c.recruiter_id = ANY (s.er)) OR (c.team_id = ANY (s.et)) OR (c.location_id = ANY (s.el))), false) AND COALESCE((s.open OR s.ho OR (c.recruiter_id = ANY (s.hr)) OR (c.team_id = ANY (s.ht)) OR (c.location_id = ANY (s.hl)) OR (s.hat AND (c.visibility = 'all_teams'::text) AND (c.marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (c.id = ANY (s.hsh))), false))
                                                                                      Buffers: shared hit=999
                                                                                      ->  CTE Scan on s  (cost=0.00..0.02 rows=1 width=358) (actual time=11.843..11.845 rows=1 loops=1)
                                                                                            Buffers: shared hit=412
                                                                                      ->  Nested Loop  (cost=0.29..1485.58 rows=4 width=210) (actual time=7.156..7.180 rows=5 loops=1)
                                                                                            Buffers: shared hit=587
                                                                                            ->  Seq Scan on person p  (cost=0.00..1444.00 rows=5 width=41) (actual time=7.121..7.123 rows=6 loops=1)
                                                                                                  Filter: (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text)
                                                                                                  Rows Removed by Filter: 49994
                                                                                                  Buffers: shared hit=569
                                                                                            ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.29..8.31 rows=1 width=201) (actual time=0.008..0.008 rows=1 loops=6)
                                                                                                  Index Cond: (person_id = p.id)
                                                                                                  Filter: (marketing_status = ANY ('{active,on_hold,full_of_interviews,confirmation,bench,stopped}'::text[]))
                                                                                                  Rows Removed by Filter: 0
                                                                                                  Buffers: shared hit=18
                                                                                ->  Seq Scan on technology t  (cost=0.00..1.14 rows=14 width=27) (actual time=0.001..0.002 rows=8 loops=5)
                                                                                      Buffers: shared hit=5
              ->  Index Scan using app_user_pkey on app_user u  (cost=0.27..8.29 rows=1 width=33) (actual time=0.003..0.003 rows=1 loops=5)
                    Index Cond: (id = h.recruiter_id)
                    Buffers: shared hit=15
        ->  Index Scan using app_user_pkey on app_user lu  (cost=0.27..4.96 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=5)
              Index Cond: (id = tm.lead_id)
              Buffers: shared hit=15
Planning:
  Buffers: shared hit=38
Planning Time: 1.465 ms
Execution Time: 19.384 ms
```

#### hotlist_export/org, term `Zebrowski`, after (median exec 11.5 ms)

```text
Sort  (cost=151.19..151.19 rows=1 width=283) (actual time=11.366..11.375 rows=5 loops=1)
  Sort Key: h.sk, h.id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=489
  CTE s
    ->  Result  (cost=0.00..4.26 rows=1 width=358) (actual time=11.089..11.089 rows=1 loops=1)
          Buffers: shared hit=412
  ->  Nested Loop Left Join  (cost=132.62..146.92 rows=1 width=283) (actual time=11.321..11.360 rows=5 loops=1)
        Buffers: shared hit=489
        ->  Nested Loop Left Join  (cost=132.35..141.89 rows=1 width=236) (actual time=11.259..11.284 rows=5 loops=1)
              Buffers: shared hit=474
              ->  Hash Join  (cost=132.08..133.51 rows=1 width=235) (actual time=11.253..11.267 rows=5 loops=1)
                    Hash Cond: (tm.id = h.team_id)
                    Buffers: shared hit=459
                    ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.002..0.004 rows=30 loops=1)
                          Buffers: shared hit=1
                    ->  Hash  (cost=132.07..132.07 rows=1 width=222) (actual time=11.245..11.250 rows=5 loops=1)
                          Buckets: 1024  Batches: 1  Memory Usage: 9kB
                          Buffers: shared hit=458
                          ->  Hash Right Join  (cost=131.01..132.07 rows=1 width=222) (actual time=11.237..11.246 rows=5 loops=1)
                                Hash Cond: (gl.id = h.gh_location_id)
                                Buffers: shared hit=458
                                ->  Seq Scan on location gl  (cost=0.00..1.04 rows=4 width=24) (actual time=0.003..0.003 rows=4 loops=1)
                                      Buffers: shared hit=1
                                ->  Hash  (cost=130.99..130.99 rows=1 width=230) (actual time=11.229..11.234 rows=5 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                      Buffers: shared hit=457
                                      ->  Hash Join  (cost=129.93..130.99 rows=1 width=230) (actual time=11.222..11.230 rows=5 loops=1)
                                            Hash Cond: (l.id = h.location_id)
                                            Buffers: shared hit=457
                                            ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.002..0.003 rows=4 loops=1)
                                                  Buffers: shared hit=1
                                            ->  Hash  (cost=129.92..129.92 rows=1 width=238) (actual time=11.215..11.218 rows=5 loops=1)
                                                  Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                                  Buffers: shared hit=456
                                                  ->  Subquery Scan on h  (cost=129.84..129.92 rows=1 width=238) (actual time=11.205..11.212 rows=5 loops=1)
                                                        Buffers: shared hit=456
                                                        ->  Limit  (cost=129.84..129.91 rows=1 width=558) (actual time=11.204..11.209 rows=5 loops=1)
                                                              Buffers: shared hit=456
                                                              ->  Result  (cost=129.84..129.91 rows=1 width=558) (actual time=11.203..11.207 rows=5 loops=1)
                                                                    Buffers: shared hit=456
                                                                    ->  Sort  (cost=129.84..129.84 rows=1 width=687) (actual time=11.198..11.200 rows=5 loops=1)
                                                                          Sort Key: c.id
                                                                          Sort Method: quicksort  Memory: 26kB
                                                                          Buffers: shared hit=456
                                                                          ->  Nested Loop  (cost=69.41..129.83 rows=1 width=687) (actual time=11.164..11.190 rows=5 loops=1)
                                                                                Buffers: shared hit=456
                                                                                ->  Nested Loop  (cost=69.27..129.67 rows=1 width=340) (actual time=11.154..11.176 rows=5 loops=1)
                                                                                      Join Filter: (COALESCE((s.eo OR (c.recruiter_id = ANY (s.er)) OR (c.team_id = ANY (s.et)) OR (c.location_id = ANY (s.el))), false) AND COALESCE((s.open OR s.ho OR (c.recruiter_id = ANY (s.hr)) OR (c.team_id = ANY (s.ht)) OR (c.location_id = ANY (s.hl)) OR (s.hat AND (c.visibility = 'all_teams'::text) AND (c.marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (c.id = ANY (s.hsh))), false))
                                                                                      Buffers: shared hit=446
                                                                                      ->  CTE Scan on s  (cost=0.00..0.02 rows=1 width=358) (actual time=11.091..11.092 rows=1 loops=1)
                                                                                            Buffers: shared hit=412
                                                                                      ->  Nested Loop  (cost=69.27..129.24 rows=4 width=210) (actual time=0.056..0.075 rows=5 loops=1)
                                                                                            Buffers: shared hit=34
                                                                                            ->  Bitmap Heap Scan on person p  (cost=68.98..87.67 rows=5 width=41) (actual time=0.038..0.040 rows=6 loops=1)
                                                                                                  Recheck Cond: (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text)
                                                                                                  Heap Blocks: exact=1
                                                                                                  Buffers: shared hit=16
                                                                                                  ->  Bitmap Index Scan on person_name_trgm  (cost=0.00..68.98 rows=5 width=0) (actual time=0.032..0.032 rows=6 loops=1)
                                                                                                        Index Cond: (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text)
                                                                                                        Buffers: shared hit=15
                                                                                            ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.29..8.31 rows=1 width=201) (actual time=0.005..0.005 rows=1 loops=6)
                                                                                                  Index Cond: (person_id = p.id)
                                                                                                  Filter: (marketing_status = ANY ('{active,on_hold,full_of_interviews,confirmation,bench,stopped}'::text[]))
                                                                                                  Rows Removed by Filter: 0
                                                                                                  Buffers: shared hit=18
                                                                                ->  Index Scan using technology_pkey on technology t  (cost=0.14..0.15 rows=1 width=27) (actual time=0.001..0.001 rows=1 loops=5)
                                                                                      Index Cond: (id = c.technology_id)
                                                                                      Buffers: shared hit=10
              ->  Index Scan using app_user_pkey on app_user u  (cost=0.27..8.29 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=5)
                    Index Cond: (id = h.recruiter_id)
                    Buffers: shared hit=15
        ->  Index Scan using app_user_pkey on app_user lu  (cost=0.27..4.96 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=5)
              Index Cond: (id = tm.lead_id)
              Buffers: shared hit=15
Planning:
  Buffers: shared hit=39
Planning Time: 0.986 ms
Execution Time: 11.511 ms
```

#### submissions/org, term `Zebrowski`, before (median exec 152.6 ms)

```text
Limit  (cost=502288.05..502441.02 rows=2 width=474) (actual time=135.281..135.679 rows=8 loops=1)
  Buffers: shared hit=151487
  InitPlan 8 (returns $7)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.427..0.427 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 10 (returns $9)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 11 (returns $10)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 14 (returns $13)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.945..0.946 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 15 (returns $14)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 16 (returns $15)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 17 (returns $16)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 18 (returns $17)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Result  (cost=502285.71..502438.68 rows=2 width=474) (actual time=135.280..135.673 rows=8 loops=1)
        Buffers: shared hit=151487
        ->  Sort  (cost=502285.71..502285.72 rows=2 width=442) (actual time=135.130..135.144 rows=8 loops=1)
              Sort Key: s.submitted_at DESC, s.id DESC
              Sort Method: quicksort  Memory: 29kB
              Buffers: shared hit=151247
              ->  Nested Loop  (cost=11.24..502285.70 rows=2 width=442) (actual time=134.333..135.123 rows=8 loops=1)
                    Buffers: shared hit=151247
                    ->  Nested Loop Left Join  (cost=1.41..502265.96 rows=2 width=362) (actual time=134.263..134.496 rows=8 loops=1)
                          Join Filter: (eu.id = s.details_edited_by)
                          Rows Removed by Join Filter: 1344
                          Buffers: shared hit=151210
                          ->  Nested Loop Left Join  (cost=1.41..501990.82 rows=2 width=361) (actual time=134.142..134.277 rows=8 loops=1)
                                Join Filter: (ru.id = s.recruiter_id)
                                Rows Removed by Join Filter: 756
                                Buffers: shared hit=150942
                                ->  Nested Loop  (cost=1.41..501715.68 rows=2 width=344) (actual time=133.903..133.983 rows=8 loops=1)
                                      Join Filter: (cl.id = s.client_id)
                                      Rows Removed by Join Filter: 184
                                      Buffers: shared hit=150674
                                      ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (actual time=0.018..0.021 rows=24 loops=1)
                                            Buffers: shared hit=1
                                      ->  Materialize  (cost=1.41..501713.72 rows=2 width=328) (actual time=5.577..5.581 rows=8 loops=24)
                                            Buffers: shared hit=150673
                                            ->  Nested Loop  (cost=1.41..501713.71 rows=2 width=328) (actual time=133.853..133.913 rows=8 loops=1)
                                                  Buffers: shared hit=150673
                                                  ->  Nested Loop  (cost=0.64..501711.41 rows=2 width=106) (actual time=133.392..133.435 rows=6 loops=1)
                                                        Buffers: shared hit=150627
                                                        ->  Seq Scan on person p  (cost=0.00..501694.00 rows=2 width=28) (actual time=132.419..132.450 rows=6 loops=1)
                                                              Filter: ((SubPlan 28) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                              Rows Removed by Filter: 49994
                                                              Buffers: shared hit=150589
                                                              SubPlan 28
                                                                ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=50000)
                                                                      Index Cond: (person_id = p.id)
                                                                      Filter: ($21 OR (recruiter_id = ANY ($22)) OR (team_id = ANY ($23)) OR (location_id = ANY ($24)) OR ($25 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 27))
                                                                      Buffers: shared hit=150020
                                                                      InitPlan 21 (returns $21)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.938..0.938 rows=1 loops=1)
                                                                              Buffers: shared hit=20
                                                                      InitPlan 22 (returns $22)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      InitPlan 23 (returns $23)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      InitPlan 24 (returns $24)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      InitPlan 25 (returns $25)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                      SubPlan 27
                                                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                              InitPlan 26 (returns $26)
                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                        ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.64..8.71 rows=1 width=94) (actual time=0.162..0.162 rows=1 loops=6)
                                                              Index Cond: (person_id = p.id)
                                                              Filter: ($13 OR (recruiter_id = ANY ($14)) OR (team_id = ANY ($15)) OR (location_id = ANY ($16)) OR ($17 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 20))
                                                              Buffers: shared hit=38
                                                              SubPlan 20
                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                      InitPlan 19 (returns $18)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                  ->  Index Scan using submission_dup on submission s  (cost=0.77..1.13 rows=2 width=238) (actual time=0.076..0.078 rows=1 loops=6)
                                                        Index Cond: (candidate_id = c.id)
                                                        Filter: ($7 OR (recruiter_id = ANY ($8)) OR (team_id = ANY ($9)) OR (location_id = ANY ($10)) OR (hashed SubPlan 13))
                                                        Buffers: shared hit=46
                                                        SubPlan 13
                                                          ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                InitPlan 12 (returns $11)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                ->  Materialize  (cost=0.00..270.52 rows=168 width=33) (actual time=0.001..0.031 rows=96 loops=8)
                                      Buffers: shared hit=268
                                      ->  Seq Scan on app_user ru  (cost=0.00..269.68 rows=168 width=33) (actual time=0.005..0.190 rows=158 loops=1)
                                            Buffers: shared hit=268
                          ->  Materialize  (cost=0.00..270.52 rows=168 width=33) (actual time=0.000..0.018 rows=168 loops=8)
                                Buffers: shared hit=268
                                ->  Seq Scan on app_user eu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.002..0.065 rows=168 loops=1)
                                      Buffers: shared hit=268
                    ->  Aggregate  (cost=9.83..9.85 rows=1 width=44) (actual time=0.071..0.071 rows=1 loops=8)
                          Buffers: shared hit=37
                          InitPlan 37 (returns $37)
                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.451..0.451 rows=1 loops=1)
                                  Buffers: shared hit=20
                          InitPlan 38 (returns $38)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          InitPlan 39 (returns $39)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          InitPlan 40 (returns $40)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          ->  Sort  (cost=8.71..8.71 rows=1 width=46) (actual time=0.064..0.064 rows=0 loops=8)
                                Sort Key: i.starts_at, i.id
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=37
                                ->  Index Scan using interview_submission on interview i  (cost=0.64..8.70 rows=1 width=46) (actual time=0.061..0.061 rows=0 loops=8)
                                      Index Cond: (submission_id = s.id)
                                      Filter: ($37 OR (recruiter_id = ANY ($38)) OR (team_id = ANY ($39)) OR (location_id = ANY ($40)) OR (hashed SubPlan 42))
                                      Buffers: shared hit=37
                                      SubPlan 42
                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                              InitPlan 41 (returns $41)
                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
        SubPlan 7
          ->  Limit  (cost=76.45..76.45 rows=1 width=18) (actual time=0.064..0.065 rows=0 loops=8)
                Buffers: shared hit=240
                InitPlan 1 (returns $1)
                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                InitPlan 2 (returns $2)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                InitPlan 3 (returns $3)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                InitPlan 4 (returns $4)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                ->  Sort  (cost=75.41..75.41 rows=1 width=18) (actual time=0.064..0.064 rows=0 loops=8)
                      Sort Key: pl.created_at DESC
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=240
                      ->  Seq Scan on placement pl  (cost=0.35..75.40 rows=1 width=18) (actual time=0.063..0.063 rows=0 loops=8)
                            Filter: ((submission_id = s.id) AND ($1 OR (recruiter_id = ANY ($2)) OR (team_id = ANY ($3)) OR (location_id = ANY ($4)) OR (hashed SubPlan 6)))
                            Rows Removed by Filter: 858
                            Buffers: shared hit=240
                            SubPlan 6
                              ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                    InitPlan 5 (returns $5)
                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                    ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
Planning:
  Buffers: shared hit=61
Planning Time: 4.381 ms
Execution Time: 136.335 ms
```

#### submissions/org, term `Zebrowski`, after (median exec 106.1 ms)

```text
Limit  (cost=502288.05..502441.02 rows=2 width=474) (actual time=110.171..110.526 rows=8 loops=1)
  Buffers: shared hit=151487
  InitPlan 8 (returns $7)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.422..0.423 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 10 (returns $9)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 11 (returns $10)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 14 (returns $13)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.788..0.789 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 15 (returns $14)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 16 (returns $15)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 17 (returns $16)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 18 (returns $17)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Result  (cost=502285.71..502438.68 rows=2 width=474) (actual time=110.169..110.520 rows=8 loops=1)
        Buffers: shared hit=151487
        ->  Sort  (cost=502285.71..502285.72 rows=2 width=442) (actual time=110.050..110.061 rows=8 loops=1)
              Sort Key: s.submitted_at DESC, s.id DESC
              Sort Method: quicksort  Memory: 29kB
              Buffers: shared hit=151247
              ->  Nested Loop  (cost=11.24..502285.70 rows=2 width=442) (actual time=109.185..110.043 rows=8 loops=1)
                    Buffers: shared hit=151247
                    ->  Nested Loop Left Join  (cost=1.41..502265.96 rows=2 width=362) (actual time=109.154..109.371 rows=8 loops=1)
                          Join Filter: (eu.id = s.details_edited_by)
                          Rows Removed by Join Filter: 1344
                          Buffers: shared hit=151210
                          ->  Nested Loop Left Join  (cost=1.41..501990.82 rows=2 width=361) (actual time=109.060..109.179 rows=8 loops=1)
                                Join Filter: (ru.id = s.recruiter_id)
                                Rows Removed by Join Filter: 756
                                Buffers: shared hit=150942
                                ->  Nested Loop  (cost=1.41..501715.68 rows=2 width=344) (actual time=108.836..108.902 rows=8 loops=1)
                                      Join Filter: (cl.id = s.client_id)
                                      Rows Removed by Join Filter: 184
                                      Buffers: shared hit=150674
                                      ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (actual time=0.010..0.013 rows=24 loops=1)
                                            Buffers: shared hit=1
                                      ->  Materialize  (cost=1.41..501713.72 rows=2 width=328) (actual time=4.533..4.536 rows=8 loops=24)
                                            Buffers: shared hit=150673
                                            ->  Nested Loop  (cost=1.41..501713.71 rows=2 width=328) (actual time=108.794..108.842 rows=8 loops=1)
                                                  Buffers: shared hit=150673
                                                  ->  Nested Loop  (cost=0.64..501711.41 rows=2 width=106) (actual time=108.342..108.375 rows=6 loops=1)
                                                        Buffers: shared hit=150627
                                                        ->  Seq Scan on person p  (cost=0.00..501694.00 rows=2 width=28) (actual time=107.530..107.551 rows=6 loops=1)
                                                              Filter: ((SubPlan 28) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                              Rows Removed by Filter: 49994
                                                              Buffers: shared hit=150589
                                                              SubPlan 28
                                                                ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=50000)
                                                                      Index Cond: (person_id = p.id)
                                                                      Filter: ($21 OR (recruiter_id = ANY ($22)) OR (team_id = ANY ($23)) OR (location_id = ANY ($24)) OR ($25 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 27))
                                                                      Buffers: shared hit=150020
                                                                      InitPlan 21 (returns $21)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.611..0.612 rows=1 loops=1)
                                                                              Buffers: shared hit=20
                                                                      InitPlan 22 (returns $22)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      InitPlan 23 (returns $23)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      InitPlan 24 (returns $24)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      InitPlan 25 (returns $25)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                      SubPlan 27
                                                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                              InitPlan 26 (returns $26)
                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                        ->  Index Scan using candidate_person_id_key on candidate c  (cost=0.64..8.71 rows=1 width=94) (actual time=0.135..0.135 rows=1 loops=6)
                                                              Index Cond: (person_id = p.id)
                                                              Filter: ($13 OR (recruiter_id = ANY ($14)) OR (team_id = ANY ($15)) OR (location_id = ANY ($16)) OR ($17 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 20))
                                                              Buffers: shared hit=38
                                                              SubPlan 20
                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                      InitPlan 19 (returns $18)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                  ->  Index Scan using submission_dup on submission s  (cost=0.77..1.13 rows=2 width=238) (actual time=0.075..0.076 rows=1 loops=6)
                                                        Index Cond: (candidate_id = c.id)
                                                        Filter: ($7 OR (recruiter_id = ANY ($8)) OR (team_id = ANY ($9)) OR (location_id = ANY ($10)) OR (hashed SubPlan 13))
                                                        Buffers: shared hit=46
                                                        SubPlan 13
                                                          ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                InitPlan 12 (returns $11)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                ->  Materialize  (cost=0.00..270.52 rows=168 width=33) (actual time=0.001..0.029 rows=96 loops=8)
                                      Buffers: shared hit=268
                                      ->  Seq Scan on app_user ru  (cost=0.00..269.68 rows=168 width=33) (actual time=0.005..0.175 rows=158 loops=1)
                                            Buffers: shared hit=268
                          ->  Materialize  (cost=0.00..270.52 rows=168 width=33) (actual time=0.000..0.015 rows=168 loops=8)
                                Buffers: shared hit=268
                                ->  Seq Scan on app_user eu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.002..0.046 rows=168 loops=1)
                                      Buffers: shared hit=268
                    ->  Aggregate  (cost=9.83..9.85 rows=1 width=44) (actual time=0.081..0.081 rows=1 loops=8)
                          Buffers: shared hit=37
                          InitPlan 37 (returns $37)
                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.538..0.539 rows=1 loops=1)
                                  Buffers: shared hit=20
                          InitPlan 38 (returns $38)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          InitPlan 39 (returns $39)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          InitPlan 40 (returns $40)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          ->  Sort  (cost=8.71..8.71 rows=1 width=46) (actual time=0.074..0.074 rows=0 loops=8)
                                Sort Key: i.starts_at, i.id
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=37
                                ->  Index Scan using interview_submission on interview i  (cost=0.64..8.70 rows=1 width=46) (actual time=0.072..0.072 rows=0 loops=8)
                                      Index Cond: (submission_id = s.id)
                                      Filter: ($37 OR (recruiter_id = ANY ($38)) OR (team_id = ANY ($39)) OR (location_id = ANY ($40)) OR (hashed SubPlan 42))
                                      Buffers: shared hit=37
                                      SubPlan 42
                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                              InitPlan 41 (returns $41)
                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
        SubPlan 7
          ->  Limit  (cost=76.45..76.45 rows=1 width=18) (actual time=0.056..0.056 rows=0 loops=8)
                Buffers: shared hit=240
                InitPlan 1 (returns $1)
                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                InitPlan 2 (returns $2)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                InitPlan 3 (returns $3)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                InitPlan 4 (returns $4)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                ->  Sort  (cost=75.41..75.41 rows=1 width=18) (actual time=0.056..0.056 rows=0 loops=8)
                      Sort Key: pl.created_at DESC
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=240
                      ->  Seq Scan on placement pl  (cost=0.35..75.40 rows=1 width=18) (actual time=0.055..0.055 rows=0 loops=8)
                            Filter: ((submission_id = s.id) AND ($1 OR (recruiter_id = ANY ($2)) OR (team_id = ANY ($3)) OR (location_id = ANY ($4)) OR (hashed SubPlan 6)))
                            Rows Removed by Filter: 858
                            Buffers: shared hit=240
                            SubPlan 6
                              ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                    InitPlan 5 (returns $5)
                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                    ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
Planning:
  Buffers: shared hit=61
Planning Time: 3.589 ms
Execution Time: 110.833 ms
```

#### submissions/team, term `Zebrowski`, before (median exec 87.6 ms)

```text
Limit  (cost=57699.76..57776.25 rows=1 width=474) (actual time=80.143..80.231 rows=2 loops=1)
  Buffers: shared hit=17667
  InitPlan 8 (returns $7)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.764..0.765 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.029..1.030 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 10 (returns $9)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.169..1.169 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 11 (returns $10)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.424..0.425 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 14 (returns $13)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.665..0.666 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 15 (returns $14)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.983..0.984 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 16 (returns $15)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.121..1.121 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 17 (returns $16)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.439..0.440 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 18 (returns $17)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.443..0.444 rows=1 loops=1)
          Buffers: shared hit=20
  ->  Result  (cost=57697.42..57773.91 rows=1 width=474) (actual time=80.142..80.221 rows=2 loops=1)
        Buffers: shared hit=17667
        ->  Sort  (cost=57697.42..57697.43 rows=1 width=442) (actual time=79.979..80.004 rows=2 loops=1)
              Sort Key: s.submitted_at DESC, s.id DESC
              Sort Method: quicksort  Memory: 26kB
              Buffers: shared hit=17607
              ->  Nested Loop  (cost=4574.55..57697.41 rows=1 width=442) (actual time=50.487..79.988 rows=2 loops=1)
                    Buffers: shared hit=17607
                    ->  Nested Loop Left Join  (cost=4564.72..57687.54 rows=1 width=362) (actual time=50.449..79.932 rows=2 loops=1)
                          Join Filter: (eu.id = s.details_edited_by)
                          Rows Removed by Join Filter: 336
                          Buffers: shared hit=17603
                          ->  Nested Loop Left Join  (cost=4564.72..57415.76 rows=1 width=361) (actual time=50.245..79.661 rows=2 loops=1)
                                Buffers: shared hit=17067
                                ->  Nested Loop  (cost=4564.45..57415.45 rows=1 width=344) (actual time=50.235..79.645 rows=2 loops=1)
                                      Join Filter: (cl.id = s.client_id)
                                      Rows Removed by Join Filter: 38
                                      Buffers: shared hit=17061
                                      ->  Nested Loop  (cost=4564.45..57413.91 rows=1 width=328) (actual time=50.222..79.624 rows=2 loops=1)
                                            Buffers: shared hit=17059
                                            ->  Hash Join  (cost=4564.16..10097.82 rows=4554 width=316) (actual time=43.431..68.321 rows=1966 loops=1)
                                                  Hash Cond: (s.candidate_id = c.id)
                                                  Join Filter: ((s.recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (s.team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (s.location_id = ANY ('{}'::uuid[])) OR (c.recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (c.team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (c.location_id = ANY ('{}'::uuid[])))
                                                  Buffers: shared hit=5179
                                                  ->  Seq Scan on submission s  (cost=0.35..5381.55 rows=58083 width=238) (actual time=20.726..44.629 rows=1966 loops=1)
                                                        Filter: ($7 OR (recruiter_id = ANY ($8)) OR (team_id = ANY ($9)) OR (location_id = ANY ($10)) OR (hashed SubPlan 13))
                                                        Rows Removed by Filter: 56658
                                                        Buffers: shared hit=3835
                                                        SubPlan 13
                                                          ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (actual time=16.943..17.030 rows=1667 loops=1)
                                                                Buffers: shared hit=1281
                                                                InitPlan 12 (returns $11)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=16.930..16.930 rows=1 loops=1)
                                                                        Buffers: shared hit=1281
                                                                ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.001..0.001 rows=1 loops=1)
                                                  ->  Hash  (cost=3944.35..3944.35 rows=49556 width=94) (actual time=22.602..22.608 rows=6186 loops=1)
                                                        Buckets: 65536  Batches: 1  Memory Usage: 1286kB
                                                        Buffers: shared hit=1344
                                                        ->  Seq Scan on candidate c  (cost=0.35..3944.35 rows=49556 width=94) (actual time=2.791..20.630 rows=6186 loops=1)
                                                              Filter: ($13 OR (recruiter_id = ANY ($14)) OR (team_id = ANY ($15)) OR (location_id = ANY ($16)) OR ($17 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 20))
                                                              Rows Removed by Filter: 43814
                                                              Buffers: shared hit=1344
                                                              SubPlan 20
                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (actual time=0.942..0.945 rows=0 loops=1)
                                                                      Buffers: shared hit=26
                                                                      InitPlan 19 (returns $18)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.935..0.936 rows=1 loops=1)
                                                                              Buffers: shared hit=26
                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.000..0.001 rows=1 loops=1)
                                            ->  Index Scan using person_pkey on person p  (cost=0.29..10.39 rows=1 width=28) (actual time=0.006..0.006 rows=0 loops=1966)
                                                  Index Cond: (id = c.person_id)
                                                  Filter: ((SubPlan 28) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                  Rows Removed by Filter: 1
                                                  Buffers: shared hit=11880
                                                  SubPlan 28
                                                    ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.003..0.003 rows=1 loops=1966)
                                                          Index Cond: (person_id = p.id)
                                                          Filter: ($21 OR (recruiter_id = ANY ($22)) OR (team_id = ANY ($23)) OR (location_id = ANY ($24)) OR ($25 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 27))
                                                          Buffers: shared hit=5982
                                                          InitPlan 21 (returns $21)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.705..0.706 rows=1 loops=1)
                                                                  Buffers: shared hit=20
                                                          InitPlan 22 (returns $22)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.013..1.014 rows=1 loops=1)
                                                                  Buffers: shared hit=40
                                                          InitPlan 23 (returns $23)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.078..1.079 rows=1 loops=1)
                                                                  Buffers: shared hit=24
                                                          InitPlan 24 (returns $24)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                          InitPlan 25 (returns $25)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                          SubPlan 27
                                                            ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                  InitPlan 26 (returns $26)
                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                  ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                      ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (actual time=0.004..0.004 rows=20 loops=2)
                                            Buffers: shared hit=2
                                ->  Index Scan using app_user_pkey on app_user ru  (cost=0.27..0.31 rows=1 width=33) (actual time=0.004..0.005 rows=1 loops=2)
                                      Index Cond: (id = s.recruiter_id)
                                      Buffers: shared hit=6
                          ->  Seq Scan on app_user eu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.002..0.122 rows=168 loops=2)
                                Buffers: shared hit=536
                    ->  Aggregate  (cost=9.83..9.85 rows=1 width=44) (actual time=0.016..0.018 rows=1 loops=2)
                          Buffers: shared hit=4
                          InitPlan 37 (returns $37)
                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                          InitPlan 38 (returns $38)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          InitPlan 39 (returns $39)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          InitPlan 40 (returns $40)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          ->  Sort  (cost=8.71..8.71 rows=1 width=46) (actual time=0.014..0.015 rows=0 loops=2)
                                Sort Key: i.starts_at, i.id
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=4
                                ->  Index Scan using interview_submission on interview i  (cost=0.64..8.70 rows=1 width=46) (actual time=0.007..0.008 rows=0 loops=2)
                                      Index Cond: (submission_id = s.id)
                                      Filter: ($37 OR (recruiter_id = ANY ($38)) OR (team_id = ANY ($39)) OR (location_id = ANY ($40)) OR (hashed SubPlan 42))
                                      Buffers: shared hit=4
                                      SubPlan 42
                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                              InitPlan 41 (returns $41)
                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
        SubPlan 7
          ->  Limit  (cost=76.45..76.45 rows=1 width=18) (actual time=0.100..0.101 rows=0 loops=2)
                Buffers: shared hit=60
                InitPlan 1 (returns $1)
                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                InitPlan 2 (returns $2)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                InitPlan 3 (returns $3)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                InitPlan 4 (returns $4)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                ->  Sort  (cost=75.41..75.41 rows=1 width=18) (actual time=0.099..0.099 rows=0 loops=2)
                      Sort Key: pl.created_at DESC
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=60
                      ->  Seq Scan on placement pl  (cost=0.35..75.40 rows=1 width=18) (actual time=0.092..0.093 rows=0 loops=2)
                            Filter: ((submission_id = s.id) AND ($1 OR (recruiter_id = ANY ($2)) OR (team_id = ANY ($3)) OR (location_id = ANY ($4)) OR (hashed SubPlan 6)))
                            Rows Removed by Filter: 858
                            Buffers: shared hit=60
                            SubPlan 6
                              ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                    InitPlan 5 (returns $5)
                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                    ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
Planning:
  Buffers: shared hit=61
Planning Time: 3.842 ms
Execution Time: 80.581 ms
```

#### submissions/team, term `Zebrowski`, after (median exec 119.6 ms)

```text
Limit  (cost=57699.76..57776.25 rows=1 width=474) (actual time=100.119..100.210 rows=2 loops=1)
  Buffers: shared hit=17667
  InitPlan 8 (returns $7)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.698..0.698 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.091..1.092 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 10 (returns $9)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.376..1.377 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 11 (returns $10)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.441..0.442 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 14 (returns $13)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.816..0.816 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 15 (returns $14)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.412..1.413 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 16 (returns $15)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.302..1.303 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 17 (returns $16)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.591..0.592 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 18 (returns $17)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.808..0.809 rows=1 loops=1)
          Buffers: shared hit=20
  ->  Result  (cost=57697.42..57773.91 rows=1 width=474) (actual time=100.118..100.200 rows=2 loops=1)
        Buffers: shared hit=17667
        ->  Sort  (cost=57697.42..57697.43 rows=1 width=442) (actual time=99.949..99.976 rows=2 loops=1)
              Sort Key: s.submitted_at DESC, s.id DESC
              Sort Method: quicksort  Memory: 26kB
              Buffers: shared hit=17607
              ->  Nested Loop  (cost=4574.55..57697.41 rows=1 width=442) (actual time=68.382..99.958 rows=2 loops=1)
                    Buffers: shared hit=17607
                    ->  Nested Loop Left Join  (cost=4564.72..57687.54 rows=1 width=362) (actual time=68.337..99.887 rows=2 loops=1)
                          Join Filter: (eu.id = s.details_edited_by)
                          Rows Removed by Join Filter: 336
                          Buffers: shared hit=17603
                          ->  Nested Loop Left Join  (cost=4564.72..57415.76 rows=1 width=361) (actual time=68.123..99.574 rows=2 loops=1)
                                Buffers: shared hit=17067
                                ->  Nested Loop  (cost=4564.45..57415.45 rows=1 width=344) (actual time=68.112..99.559 rows=2 loops=1)
                                      Join Filter: (cl.id = s.client_id)
                                      Rows Removed by Join Filter: 38
                                      Buffers: shared hit=17061
                                      ->  Nested Loop  (cost=4564.45..57413.91 rows=1 width=328) (actual time=68.098..99.538 rows=2 loops=1)
                                            Buffers: shared hit=17059
                                            ->  Hash Join  (cost=4564.16..10097.82 rows=4554 width=316) (actual time=54.065..80.547 rows=1966 loops=1)
                                                  Hash Cond: (s.candidate_id = c.id)
                                                  Join Filter: ((s.recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (s.team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (s.location_id = ANY ('{}'::uuid[])) OR (c.recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (c.team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (c.location_id = ANY ('{}'::uuid[])))
                                                  Buffers: shared hit=5179
                                                  ->  Seq Scan on submission s  (cost=0.35..5381.55 rows=58083 width=238) (actual time=25.679..50.791 rows=1966 loops=1)
                                                        Filter: ($7 OR (recruiter_id = ANY ($8)) OR (team_id = ANY ($9)) OR (location_id = ANY ($10)) OR (hashed SubPlan 13))
                                                        Rows Removed by Filter: 56658
                                                        Buffers: shared hit=3835
                                                        SubPlan 13
                                                          ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (actual time=21.655..21.754 rows=1667 loops=1)
                                                                Buffers: shared hit=1281
                                                                InitPlan 12 (returns $11)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=21.642..21.642 rows=1 loops=1)
                                                                        Buffers: shared hit=1281
                                                                ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.000..0.001 rows=1 loops=1)
                                                  ->  Hash  (cost=3944.35..3944.35 rows=49556 width=94) (actual time=28.308..28.312 rows=6186 loops=1)
                                                        Buckets: 65536  Batches: 1  Memory Usage: 1286kB
                                                        Buffers: shared hit=1344
                                                        ->  Seq Scan on candidate c  (cost=0.35..3944.35 rows=49556 width=94) (actual time=3.554..25.798 rows=6186 loops=1)
                                                              Filter: ($13 OR (recruiter_id = ANY ($14)) OR (team_id = ANY ($15)) OR (location_id = ANY ($16)) OR ($17 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 20))
                                                              Rows Removed by Filter: 43814
                                                              Buffers: shared hit=1344
                                                              SubPlan 20
                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (actual time=1.413..1.414 rows=0 loops=1)
                                                                      Buffers: shared hit=26
                                                                      InitPlan 19 (returns $18)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.406..1.406 rows=1 loops=1)
                                                                              Buffers: shared hit=26
                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.000..0.001 rows=1 loops=1)
                                            ->  Index Scan using person_pkey on person p  (cost=0.29..10.39 rows=1 width=28) (actual time=0.009..0.009 rows=0 loops=1966)
                                                  Index Cond: (id = c.person_id)
                                                  Filter: ((SubPlan 28) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                  Rows Removed by Filter: 1
                                                  Buffers: shared hit=11880
                                                  SubPlan 28
                                                    ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.006..0.006 rows=1 loops=1966)
                                                          Index Cond: (person_id = p.id)
                                                          Filter: ($21 OR (recruiter_id = ANY ($22)) OR (team_id = ANY ($23)) OR (location_id = ANY ($24)) OR ($25 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 27))
                                                          Buffers: shared hit=5982
                                                          InitPlan 21 (returns $21)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=3.812..3.814 rows=1 loops=1)
                                                                  Buffers: shared hit=20
                                                          InitPlan 22 (returns $22)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.346..1.347 rows=1 loops=1)
                                                                  Buffers: shared hit=40
                                                          InitPlan 23 (returns $23)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=2.885..2.886 rows=1 loops=1)
                                                                  Buffers: shared hit=24
                                                          InitPlan 24 (returns $24)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                          InitPlan 25 (returns $25)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                          SubPlan 27
                                                            ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                  InitPlan 26 (returns $26)
                                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                  ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                      ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (actual time=0.004..0.005 rows=20 loops=2)
                                            Buffers: shared hit=2
                                ->  Index Scan using app_user_pkey on app_user ru  (cost=0.27..0.31 rows=1 width=33) (actual time=0.005..0.005 rows=1 loops=2)
                                      Index Cond: (id = s.recruiter_id)
                                      Buffers: shared hit=6
                          ->  Seq Scan on app_user eu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.003..0.142 rows=168 loops=2)
                                Buffers: shared hit=536
                    ->  Aggregate  (cost=9.83..9.85 rows=1 width=44) (actual time=0.020..0.023 rows=1 loops=2)
                          Buffers: shared hit=4
                          InitPlan 37 (returns $37)
                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                          InitPlan 38 (returns $38)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          InitPlan 39 (returns $39)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          InitPlan 40 (returns $40)
                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                          ->  Sort  (cost=8.71..8.71 rows=1 width=46) (actual time=0.016..0.018 rows=0 loops=2)
                                Sort Key: i.starts_at, i.id
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=4
                                ->  Index Scan using interview_submission on interview i  (cost=0.64..8.70 rows=1 width=46) (actual time=0.007..0.008 rows=0 loops=2)
                                      Index Cond: (submission_id = s.id)
                                      Filter: ($37 OR (recruiter_id = ANY ($38)) OR (team_id = ANY ($39)) OR (location_id = ANY ($40)) OR (hashed SubPlan 42))
                                      Buffers: shared hit=4
                                      SubPlan 42
                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                              InitPlan 41 (returns $41)
                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
        SubPlan 7
          ->  Limit  (cost=76.45..76.45 rows=1 width=18) (actual time=0.104..0.105 rows=0 loops=2)
                Buffers: shared hit=60
                InitPlan 1 (returns $1)
                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                InitPlan 2 (returns $2)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                InitPlan 3 (returns $3)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                InitPlan 4 (returns $4)
                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                ->  Sort  (cost=75.41..75.41 rows=1 width=18) (actual time=0.103..0.104 rows=0 loops=2)
                      Sort Key: pl.created_at DESC
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=60
                      ->  Seq Scan on placement pl  (cost=0.35..75.40 rows=1 width=18) (actual time=0.095..0.095 rows=0 loops=2)
                            Filter: ((submission_id = s.id) AND ($1 OR (recruiter_id = ANY ($2)) OR (team_id = ANY ($3)) OR (location_id = ANY ($4)) OR (hashed SubPlan 6)))
                            Rows Removed by Filter: 858
                            Buffers: shared hit=60
                            SubPlan 6
                              ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                    InitPlan 5 (returns $5)
                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                    ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
Planning:
  Buffers: shared hit=61
Planning Time: 4.302 ms
Execution Time: 100.590 ms
```

#### placements/org, term `Zebrowski`, before (median exec 9.6 ms)

```text
Limit  (cost=4.17..13038.78 rows=1 width=511) (actual time=8.654..8.669 rows=0 loops=1)
  Buffers: shared hit=7907
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.677..0.677 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 2 (returns $1)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 3 (returns $2)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 4 (returns $3)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 7 (returns $6)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.443..0.443 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 8 (returns $7)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 10 (returns $9)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 11 (returns $10)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Nested Loop Left Join  (cost=1.83..13036.44 rows=1 width=511) (actual time=8.652..8.663 rows=0 loops=1)
        Join Filter: (tech.id = pl.technology_id)
        Buffers: shared hit=7907
        ->  Nested Loop Left Join  (cost=1.83..13035.09 rows=1 width=408) (actual time=8.651..8.661 rows=0 loops=1)
              Join Filter: (ip.id = pl.implementation_partner_id)
              Buffers: shared hit=7907
              ->  Nested Loop Left Join  (cost=1.83..13035.08 rows=1 width=376) (actual time=8.650..8.660 rows=0 loops=1)
                    Join Filter: (v.id = pl.vendor_id)
                    Buffers: shared hit=7907
                    ->  Nested Loop  (cost=1.83..13033.90 rows=1 width=359) (actual time=8.650..8.659 rows=0 loops=1)
                          Join Filter: (cl.id = pl.client_id)
                          Buffers: shared hit=7907
                          ->  Nested Loop Left Join  (cost=1.83..13032.36 rows=1 width=343) (actual time=8.650..8.658 rows=0 loops=1)
                                Join Filter: (l.id = pl.location_id)
                                Buffers: shared hit=7907
                                ->  Nested Loop Left Join  (cost=1.83..13031.27 rows=1 width=335) (actual time=8.649..8.657 rows=0 loops=1)
                                      Join Filter: (tm.id = pl.team_id)
                                      Buffers: shared hit=7907
                                      ->  Nested Loop Left Join  (cost=1.83..13029.60 rows=1 width=322) (actual time=8.648..8.655 rows=0 loops=1)
                                            Buffers: shared hit=7907
                                            ->  Nested Loop  (cost=1.56..13028.00 rows=1 width=305) (actual time=8.648..8.654 rows=0 loops=1)
                                                  Buffers: shared hit=7907
                                                  ->  Nested Loop  (cost=1.27..4274.13 rows=842 width=293) (actual time=1.153..3.717 rows=858 loops=1)
                                                        Buffers: shared hit=2739
                                                        ->  Index Scan Backward using placement_created on placement pl  (cost=0.63..146.88 rows=850 width=229) (actual time=0.696..1.105 rows=858 loops=1)
                                                              Filter: ($0 OR (recruiter_id = ANY ($1)) OR (team_id = ANY ($2)) OR (location_id = ANY ($3)) OR (hashed SubPlan 6))
                                                              Buffers: shared hit=145
                                                              SubPlan 6
                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                      InitPlan 5 (returns $4)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                        ->  Index Scan using candidate_pkey on candidate c  (cost=0.64..4.86 rows=1 width=80) (actual time=0.003..0.003 rows=1 loops=858)
                                                              Index Cond: (id = pl.candidate_id)
                                                              Filter: ($6 OR (recruiter_id = ANY ($7)) OR (team_id = ANY ($8)) OR (location_id = ANY ($9)) OR ($10 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 13))
                                                              Buffers: shared hit=2594
                                                              SubPlan 13
                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                      InitPlan 12 (returns $11)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                  ->  Index Scan using person_pkey on person p  (cost=0.29..10.39 rows=1 width=28) (actual time=0.006..0.006 rows=0 loops=858)
                                                        Index Cond: (id = c.person_id)
                                                        Filter: ((SubPlan 21) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                        Rows Removed by Filter: 1
                                                        Buffers: shared hit=5168
                                                        SubPlan 21
                                                          ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.003..0.003 rows=1 loops=858)
                                                                Index Cond: (person_id = p.id)
                                                                Filter: ($14 OR (recruiter_id = ANY ($15)) OR (team_id = ANY ($16)) OR (location_id = ANY ($17)) OR ($18 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 20))
                                                                Buffers: shared hit=2594
                                                                InitPlan 14 (returns $14)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.485..0.485 rows=1 loops=1)
                                                                        Buffers: shared hit=20
                                                                InitPlan 15 (returns $15)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                InitPlan 16 (returns $16)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                InitPlan 17 (returns $17)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                InitPlan 18 (returns $18)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                SubPlan 20
                                                                  ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                        InitPlan 19 (returns $19)
                                                                          ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                        ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                            ->  Index Scan using app_user_pkey on app_user ru  (cost=0.27..1.58 rows=1 width=33) (never executed)
                                                  Index Cond: (id = pl.recruiter_id)
                                      ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=29) (never executed)
                                ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (never executed)
                          ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (never executed)
                    ->  Seq Scan on vendor v  (cost=0.00..1.08 rows=8 width=33) (never executed)
              ->  Seq Scan on implementation_partner ip  (cost=0.00..0.00 rows=1 width=48) (never executed)
        ->  Seq Scan on technology tech  (cost=0.00..1.14 rows=14 width=27) (never executed)
Planning:
  Buffers: shared hit=66
Planning Time: 11.664 ms
Execution Time: 8.928 ms
```

#### placements/org, term `Zebrowski`, after (median exec 14.3 ms)

```text
Limit  (cost=4.17..13038.78 rows=1 width=511) (actual time=14.764..14.787 rows=0 loops=1)
  Buffers: shared hit=7907
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=1.059..1.060 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 2 (returns $1)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 3 (returns $2)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 4 (returns $3)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 7 (returns $6)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.657..0.658 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 8 (returns $7)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 10 (returns $9)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 11 (returns $10)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Nested Loop Left Join  (cost=1.83..13036.44 rows=1 width=511) (actual time=14.762..14.779 rows=0 loops=1)
        Join Filter: (tech.id = pl.technology_id)
        Buffers: shared hit=7907
        ->  Nested Loop Left Join  (cost=1.83..13035.09 rows=1 width=408) (actual time=14.762..14.777 rows=0 loops=1)
              Join Filter: (ip.id = pl.implementation_partner_id)
              Buffers: shared hit=7907
              ->  Nested Loop Left Join  (cost=1.83..13035.08 rows=1 width=376) (actual time=14.761..14.776 rows=0 loops=1)
                    Join Filter: (v.id = pl.vendor_id)
                    Buffers: shared hit=7907
                    ->  Nested Loop  (cost=1.83..13033.90 rows=1 width=359) (actual time=14.760..14.775 rows=0 loops=1)
                          Join Filter: (cl.id = pl.client_id)
                          Buffers: shared hit=7907
                          ->  Nested Loop Left Join  (cost=1.83..13032.36 rows=1 width=343) (actual time=14.759..14.773 rows=0 loops=1)
                                Join Filter: (l.id = pl.location_id)
                                Buffers: shared hit=7907
                                ->  Nested Loop Left Join  (cost=1.83..13031.27 rows=1 width=335) (actual time=14.758..14.772 rows=0 loops=1)
                                      Join Filter: (tm.id = pl.team_id)
                                      Buffers: shared hit=7907
                                      ->  Nested Loop Left Join  (cost=1.83..13029.60 rows=1 width=322) (actual time=14.758..14.771 rows=0 loops=1)
                                            Buffers: shared hit=7907
                                            ->  Nested Loop  (cost=1.56..13028.00 rows=1 width=305) (actual time=14.757..14.770 rows=0 loops=1)
                                                  Buffers: shared hit=7907
                                                  ->  Nested Loop  (cost=1.27..4274.13 rows=842 width=293) (actual time=1.763..6.623 rows=858 loops=1)
                                                        Buffers: shared hit=2739
                                                        ->  Index Scan Backward using placement_created on placement pl  (cost=0.63..146.88 rows=850 width=229) (actual time=1.085..1.922 rows=858 loops=1)
                                                              Filter: ($0 OR (recruiter_id = ANY ($1)) OR (team_id = ANY ($2)) OR (location_id = ANY ($3)) OR (hashed SubPlan 6))
                                                              Buffers: shared hit=145
                                                              SubPlan 6
                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                      InitPlan 5 (returns $4)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                        ->  Index Scan using candidate_pkey on candidate c  (cost=0.64..4.86 rows=1 width=80) (actual time=0.005..0.005 rows=1 loops=858)
                                                              Index Cond: (id = pl.candidate_id)
                                                              Filter: ($6 OR (recruiter_id = ANY ($7)) OR (team_id = ANY ($8)) OR (location_id = ANY ($9)) OR ($10 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 13))
                                                              Buffers: shared hit=2594
                                                              SubPlan 13
                                                                ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                      InitPlan 12 (returns $11)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                  ->  Index Scan using person_pkey on person p  (cost=0.29..10.39 rows=1 width=28) (actual time=0.009..0.009 rows=0 loops=858)
                                                        Index Cond: (id = c.person_id)
                                                        Filter: ((SubPlan 21) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                        Rows Removed by Filter: 1
                                                        Buffers: shared hit=5168
                                                        SubPlan 21
                                                          ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.004..0.004 rows=1 loops=858)
                                                                Index Cond: (person_id = p.id)
                                                                Filter: ($14 OR (recruiter_id = ANY ($15)) OR (team_id = ANY ($16)) OR (location_id = ANY ($17)) OR ($18 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 20))
                                                                Buffers: shared hit=2594
                                                                InitPlan 14 (returns $14)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.597..0.597 rows=1 loops=1)
                                                                        Buffers: shared hit=20
                                                                InitPlan 15 (returns $15)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                InitPlan 16 (returns $16)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                InitPlan 17 (returns $17)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                InitPlan 18 (returns $18)
                                                                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                SubPlan 20
                                                                  ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                        InitPlan 19 (returns $19)
                                                                          ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                        ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                            ->  Index Scan using app_user_pkey on app_user ru  (cost=0.27..1.58 rows=1 width=33) (never executed)
                                                  Index Cond: (id = pl.recruiter_id)
                                      ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=29) (never executed)
                                ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (never executed)
                          ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (never executed)
                    ->  Seq Scan on vendor v  (cost=0.00..1.08 rows=8 width=33) (never executed)
              ->  Seq Scan on implementation_partner ip  (cost=0.00..0.00 rows=1 width=48) (never executed)
        ->  Seq Scan on technology tech  (cost=0.00..1.14 rows=14 width=27) (never executed)
Planning:
  Buffers: shared hit=66
Planning Time: 19.777 ms
Execution Time: 15.109 ms
```

#### placements/team, term `Zebrowski`, before (median exec 27.3 ms)

```text
Limit  (cost=5020.30..5020.30 rows=1 width=511) (actual time=26.443..26.464 rows=0 loops=1)
  Buffers: shared hit=1961
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.720..0.720 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 2 (returns $1)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.139..1.140 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 3 (returns $2)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.161..1.161 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 4 (returns $3)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.481..0.482 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 7 (returns $6)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.387..0.388 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 8 (returns $7)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.903..0.903 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.181..1.182 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 10 (returns $9)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 11 (returns $10)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Sort  (cost=5017.96..5017.96 rows=1 width=511) (actual time=26.441..26.454 rows=0 loops=1)
        Sort Key: pl.created_at DESC, pl.id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=1961
        ->  Nested Loop Left Join  (cost=1.56..5017.95 rows=1 width=511) (actual time=26.433..26.446 rows=0 loops=1)
              Join Filter: (tech.id = pl.technology_id)
              Buffers: shared hit=1961
              ->  Nested Loop Left Join  (cost=1.56..5016.60 rows=1 width=408) (actual time=26.431..26.444 rows=0 loops=1)
                    Join Filter: (ip.id = pl.implementation_partner_id)
                    Buffers: shared hit=1961
                    ->  Nested Loop Left Join  (cost=1.56..5016.59 rows=1 width=376) (actual time=26.431..26.443 rows=0 loops=1)
                          Join Filter: (v.id = pl.vendor_id)
                          Buffers: shared hit=1961
                          ->  Nested Loop  (cost=1.56..5015.41 rows=1 width=359) (actual time=26.430..26.443 rows=0 loops=1)
                                Join Filter: (cl.id = pl.client_id)
                                Buffers: shared hit=1961
                                ->  Nested Loop Left Join  (cost=1.56..5013.87 rows=1 width=343) (actual time=26.430..26.442 rows=0 loops=1)
                                      Join Filter: (l.id = pl.location_id)
                                      Buffers: shared hit=1961
                                      ->  Nested Loop Left Join  (cost=1.56..5012.78 rows=1 width=335) (actual time=26.429..26.441 rows=0 loops=1)
                                            Join Filter: (tm.id = pl.team_id)
                                            Buffers: shared hit=1961
                                            ->  Nested Loop Left Join  (cost=1.56..5011.11 rows=1 width=322) (actual time=26.429..26.440 rows=0 loops=1)
                                                  Buffers: shared hit=1961
                                                  ->  Nested Loop  (cost=1.29..5009.51 rows=1 width=305) (actual time=26.428..26.439 rows=0 loops=1)
                                                        Buffers: shared hit=1961
                                                        ->  Nested Loop  (cost=1.00..4213.25 rows=76 width=293) (actual time=5.537..23.743 rows=42 loops=1)
                                                              Buffers: shared hit=1625
                                                              ->  Seq Scan on placement pl  (cost=0.35..73.25 rows=850 width=229) (actual time=3.041..21.104 rows=42 loops=1)
                                                                    Filter: ($0 OR (recruiter_id = ANY ($1)) OR (team_id = ANY ($2)) OR (location_id = ANY ($3)) OR (hashed SubPlan 6))
                                                                    Rows Removed by Filter: 816
                                                                    Buffers: shared hit=1415
                                                                    SubPlan 6
                                                                      ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (actual time=16.879..16.967 rows=1667 loops=1)
                                                                            Buffers: shared hit=1281
                                                                            InitPlan 5 (returns $4)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=16.866..16.866 rows=1 loops=1)
                                                                                    Buffers: shared hit=1281
                                                                            ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.000..0.001 rows=1 loops=1)
                                                              ->  Index Scan using candidate_pkey on candidate c  (cost=0.64..4.86 rows=1 width=80) (actual time=0.062..0.062 rows=1 loops=42)
                                                                    Index Cond: (id = pl.candidate_id)
                                                                    Filter: (((pl.recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (pl.team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (pl.location_id = ANY ('{}'::uuid[])) OR (recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (location_id = ANY ('{}'::uuid[]))) AND ($6 OR (recruiter_id = ANY ($7)) OR (team_id = ANY ($8)) OR (location_id = ANY ($9)) OR ($10 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 13)))
                                                                    Buffers: shared hit=210
                                                                    SubPlan 13
                                                                      ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                            InitPlan 12 (returns $11)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                        ->  Index Scan using person_pkey on person p  (cost=0.29..10.39 rows=1 width=28) (actual time=0.064..0.064 rows=0 loops=42)
                                                              Index Cond: (id = c.person_id)
                                                              Filter: ((SubPlan 21) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                              Rows Removed by Filter: 1
                                                              Buffers: shared hit=336
                                                              SubPlan 21
                                                                ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.060..0.060 rows=1 loops=42)
                                                                      Index Cond: (person_id = p.id)
                                                                      Filter: ($14 OR (recruiter_id = ANY ($15)) OR (team_id = ANY ($16)) OR (location_id = ANY ($17)) OR ($18 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 20))
                                                                      Buffers: shared hit=210
                                                                      InitPlan 14 (returns $14)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.433..0.433 rows=1 loops=1)
                                                                              Buffers: shared hit=20
                                                                      InitPlan 15 (returns $15)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.890..0.891 rows=1 loops=1)
                                                                              Buffers: shared hit=40
                                                                      InitPlan 16 (returns $16)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.048..1.048 rows=1 loops=1)
                                                                              Buffers: shared hit=24
                                                                      InitPlan 17 (returns $17)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      InitPlan 18 (returns $18)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                      SubPlan 20
                                                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                              InitPlan 19 (returns $19)
                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                  ->  Index Scan using app_user_pkey on app_user ru  (cost=0.27..1.58 rows=1 width=33) (never executed)
                                                        Index Cond: (id = pl.recruiter_id)
                                            ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=29) (never executed)
                                      ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (never executed)
                                ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (never executed)
                          ->  Seq Scan on vendor v  (cost=0.00..1.08 rows=8 width=33) (never executed)
                    ->  Seq Scan on implementation_partner ip  (cost=0.00..0.00 rows=1 width=48) (never executed)
              ->  Seq Scan on technology tech  (cost=0.00..1.14 rows=14 width=27) (never executed)
Planning:
  Buffers: shared hit=66
Planning Time: 11.236 ms
Execution Time: 26.718 ms
```

#### placements/team, term `Zebrowski`, after (median exec 28.8 ms)

```text
Limit  (cost=5020.30..5020.30 rows=1 width=511) (actual time=33.692..33.713 rows=0 loops=1)
  Buffers: shared hit=1961
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=1.006..1.008 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 2 (returns $1)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.756..1.757 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 3 (returns $2)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.723..1.724 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 4 (returns $3)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.839..0.840 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 7 (returns $6)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.664..0.664 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 8 (returns $7)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.634..1.635 rows=1 loops=1)
          Buffers: shared hit=40
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.812..1.812 rows=1 loops=1)
          Buffers: shared hit=24
  InitPlan 10 (returns $9)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 11 (returns $10)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  ->  Sort  (cost=5017.96..5017.96 rows=1 width=511) (actual time=33.691..33.704 rows=0 loops=1)
        Sort Key: pl.created_at DESC, pl.id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=1961
        ->  Nested Loop Left Join  (cost=1.56..5017.95 rows=1 width=511) (actual time=33.682..33.696 rows=0 loops=1)
              Join Filter: (tech.id = pl.technology_id)
              Buffers: shared hit=1961
              ->  Nested Loop Left Join  (cost=1.56..5016.60 rows=1 width=408) (actual time=33.681..33.694 rows=0 loops=1)
                    Join Filter: (ip.id = pl.implementation_partner_id)
                    Buffers: shared hit=1961
                    ->  Nested Loop Left Join  (cost=1.56..5016.59 rows=1 width=376) (actual time=33.681..33.693 rows=0 loops=1)
                          Join Filter: (v.id = pl.vendor_id)
                          Buffers: shared hit=1961
                          ->  Nested Loop  (cost=1.56..5015.41 rows=1 width=359) (actual time=33.680..33.692 rows=0 loops=1)
                                Join Filter: (cl.id = pl.client_id)
                                Buffers: shared hit=1961
                                ->  Nested Loop Left Join  (cost=1.56..5013.87 rows=1 width=343) (actual time=33.680..33.691 rows=0 loops=1)
                                      Join Filter: (l.id = pl.location_id)
                                      Buffers: shared hit=1961
                                      ->  Nested Loop Left Join  (cost=1.56..5012.78 rows=1 width=335) (actual time=33.679..33.690 rows=0 loops=1)
                                            Join Filter: (tm.id = pl.team_id)
                                            Buffers: shared hit=1961
                                            ->  Nested Loop Left Join  (cost=1.56..5011.11 rows=1 width=322) (actual time=33.679..33.689 rows=0 loops=1)
                                                  Buffers: shared hit=1961
                                                  ->  Nested Loop  (cost=1.29..5009.51 rows=1 width=305) (actual time=33.678..33.688 rows=0 loops=1)
                                                        Buffers: shared hit=1961
                                                        ->  Nested Loop  (cost=1.00..4213.25 rows=76 width=293) (actual time=8.663..28.943 rows=42 loops=1)
                                                              Buffers: shared hit=1625
                                                              ->  Seq Scan on placement pl  (cost=0.35..73.25 rows=850 width=229) (actual time=4.517..24.528 rows=42 loops=1)
                                                                    Filter: ($0 OR (recruiter_id = ANY ($1)) OR (team_id = ANY ($2)) OR (location_id = ANY ($3)) OR (hashed SubPlan 6))
                                                                    Rows Removed by Filter: 816
                                                                    Buffers: shared hit=1415
                                                                    SubPlan 6
                                                                      ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (actual time=18.391..18.487 rows=1667 loops=1)
                                                                            Buffers: shared hit=1281
                                                                            InitPlan 5 (returns $4)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=18.377..18.378 rows=1 loops=1)
                                                                                    Buffers: shared hit=1281
                                                                            ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.000..0.001 rows=1 loops=1)
                                                              ->  Index Scan using candidate_pkey on candidate c  (cost=0.64..4.86 rows=1 width=80) (actual time=0.104..0.104 rows=1 loops=42)
                                                                    Index Cond: (id = pl.candidate_id)
                                                                    Filter: (((pl.recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (pl.team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (pl.location_id = ANY ('{}'::uuid[])) OR (recruiter_id = ANY ('{b92ac765-9af5-4dab-958a-3a6e42edf2b9}'::uuid[])) OR (team_id = ANY ('{f0f1fc79-0671-47af-af2c-59e8b1f3fd1b}'::uuid[])) OR (location_id = ANY ('{}'::uuid[]))) AND ($6 OR (recruiter_id = ANY ($7)) OR (team_id = ANY ($8)) OR (location_id = ANY ($9)) OR ($10 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 13)))
                                                                    Buffers: shared hit=210
                                                                    SubPlan 13
                                                                      ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                            InitPlan 12 (returns $11)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                        ->  Index Scan using person_pkey on person p  (cost=0.29..10.39 rows=1 width=28) (actual time=0.112..0.112 rows=0 loops=42)
                                                              Index Cond: (id = c.person_id)
                                                              Filter: ((SubPlan 21) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                              Rows Removed by Filter: 1
                                                              Buffers: shared hit=336
                                                              SubPlan 21
                                                                ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.106..0.106 rows=1 loops=42)
                                                                      Index Cond: (person_id = p.id)
                                                                      Filter: ($14 OR (recruiter_id = ANY ($15)) OR (team_id = ANY ($16)) OR (location_id = ANY ($17)) OR ($18 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 20))
                                                                      Buffers: shared hit=210
                                                                      InitPlan 14 (returns $14)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.725..0.726 rows=1 loops=1)
                                                                              Buffers: shared hit=20
                                                                      InitPlan 15 (returns $15)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.665..1.666 rows=1 loops=1)
                                                                              Buffers: shared hit=40
                                                                      InitPlan 16 (returns $16)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=1.863..1.864 rows=1 loops=1)
                                                                              Buffers: shared hit=24
                                                                      InitPlan 17 (returns $17)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                      InitPlan 18 (returns $18)
                                                                        ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                      SubPlan 20
                                                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                              InitPlan 19 (returns $19)
                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                  ->  Index Scan using app_user_pkey on app_user ru  (cost=0.27..1.58 rows=1 width=33) (never executed)
                                                        Index Cond: (id = pl.recruiter_id)
                                            ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=29) (never executed)
                                      ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (never executed)
                                ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (never executed)
                          ->  Seq Scan on vendor v  (cost=0.00..1.08 rows=8 width=33) (never executed)
                    ->  Seq Scan on implementation_partner ip  (cost=0.00..0.00 rows=1 width=48) (never executed)
              ->  Seq Scan on technology tech  (cost=0.00..1.14 rows=14 width=27) (never executed)
Planning:
  Buffers: shared hit=66
Planning Time: 12.742 ms
Execution Time: 34.056 ms
```

#### employees/org(hr), term `Zebrowski`, before (median exec 50.9 ms)

```text
Limit  (cost=55897.61..55897.62 rows=5 width=777) (actual time=50.083..50.173 rows=6 loops=1)
  Buffers: shared hit=62842
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.683..0.684 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 18 (returns $17)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.385..0.386 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 19 (returns $18)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 20 (returns $19)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 21 (returns $20)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 22 (returns $21)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  InitPlan 25 (returns $24)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.488..0.488 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 26 (returns $25)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 27 (returns $26)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 28 (returns $27)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  ->  Sort  (cost=55895.01..55895.02 rows=5 width=777) (actual time=50.081..50.165 rows=6 loops=1)
        Sort Key: e.status_since DESC, e.person_id DESC
        Sort Method: quicksort  Memory: 27kB
        Buffers: shared hit=62842
        ->  Nested Loop Left Join  (cost=1.55..55894.95 rows=5 width=777) (actual time=3.118..50.141 rows=6 loops=1)
              Join Filter: (pc.id = ae.payroll_company_id)
              Buffers: shared hit=62842
              ->  Nested Loop Left Join  (cost=1.30..55871.98 rows=1 width=513) (actual time=2.581..49.592 rows=6 loops=1)
                    Join Filter: (ae.assignment_id = a.id)
                    Buffers: shared hit=62819
                    ->  Nested Loop Left Join  (cost=1.30..55871.96 rows=1 width=489) (actual time=2.577..49.577 rows=6 loops=1)
                          Join Filter: (pp.assignment_id = a.id)
                          Buffers: shared hit=62819
                          ->  Nested Loop Left Join  (cost=1.30..55871.95 rows=1 width=485) (actual time=2.574..49.564 rows=6 loops=1)
                                Join Filter: (v.id = pl.vendor_id)
                                Rows Removed by Join Filter: 48
                                Buffers: shared hit=62819
                                ->  Nested Loop Left Join  (cost=1.30..55870.77 rows=1 width=468) (actual time=2.568..49.545 rows=6 loops=1)
                                      Join Filter: (cl.id = pl.client_id)
                                      Rows Removed by Join Filter: 144
                                      Buffers: shared hit=62813
                                      ->  Nested Loop Left Join  (cost=1.30..55869.23 rows=1 width=452) (actual time=2.556..49.509 rows=6 loops=1)
                                            Join Filter: (pl.id = a.placement_id)
                                            Rows Removed by Join Filter: 5148
                                            Buffers: shared hit=62807
                                            ->  Nested Loop Left Join  (cost=0.94..55785.35 rows=1 width=372) (actual time=1.844..47.925 rows=6 loops=1)
                                                  Buffers: shared hit=62607
                                                  ->  Nested Loop Left Join  (cost=0.93..55785.33 rows=1 width=296) (actual time=1.833..47.882 rows=6 loops=1)
                                                        Join Filter: (lu.id = tm.lead_id)
                                                        Rows Removed by Join Filter: 528
                                                        Buffers: shared hit=62607
                                                        ->  Nested Loop Left Join  (cost=0.93..55513.55 rows=1 width=279) (actual time=1.789..47.654 rows=6 loops=1)
                                                              Join Filter: (cru.id = c.recruiter_id)
                                                              Rows Removed by Join Filter: 644
                                                              Buffers: shared hit=61549
                                                              ->  Nested Loop Left Join  (cost=0.93..55241.77 rows=1 width=262) (actual time=1.607..47.192 rows=6 loops=1)
                                                                    Join Filter: (tm.id = c.team_id)
                                                                    Rows Removed by Join Filter: 73
                                                                    Buffers: shared hit=60224
                                                                    ->  Nested Loop Left Join  (cost=0.93..55240.09 rows=1 width=233) (actual time=1.596..47.168 rows=6 loops=1)
                                                                          Join Filter: (l.id = c.location_id)
                                                                          Rows Removed by Join Filter: 7
                                                                          Buffers: shared hit=60218
                                                                          ->  Nested Loop Left Join  (cost=0.93..55239.00 rows=1 width=225) (actual time=1.582..47.144 rows=6 loops=1)
                                                                                Buffers: shared hit=60212
                                                                                ->  Nested Loop  (cost=0.29..55237.14 rows=1 width=163) (actual time=1.185..46.730 rows=6 loops=1)
                                                                                      Buffers: shared hit=60174
                                                                                      ->  Seq Scan on employee e  (cost=0.00..234.00 rows=5000 width=90) (actual time=0.695..1.569 rows=10000 loops=1)
                                                                                            Filter: $0
                                                                                            Buffers: shared hit=154
                                                                                      ->  Index Scan using person_pkey on person p  (cost=0.29..11.00 rows=1 width=73) (actual time=0.004..0.004 rows=0 loops=10000)
                                                                                            Index Cond: (id = e.person_id)
                                                                                            Filter: ((SubPlan 9) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                                                            Rows Removed by Filter: 1
                                                                                            Buffers: shared hit=60020
                                                                                            SubPlan 9
                                                                                              ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=10000)
                                                                                                    Index Cond: (person_id = p.id)
                                                                                                    Filter: ($2 OR (recruiter_id = ANY ($3)) OR (team_id = ANY ($4)) OR (location_id = ANY ($5)) OR ($6 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 8))
                                                                                                    Buffers: shared hit=30020
                                                                                                    InitPlan 2 (returns $2)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.463..0.464 rows=1 loops=1)
                                                                                                            Buffers: shared hit=20
                                                                                                    InitPlan 3 (returns $3)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                    InitPlan 4 (returns $4)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                    InitPlan 5 (returns $5)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                    InitPlan 6 (returns $6)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                                                    SubPlan 8
                                                                                                      ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                                            InitPlan 7 (returns $7)
                                                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                            ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                                ->  Index Scan using candidate_pkey on candidate c  (cost=0.64..1.86 rows=1 width=78) (actual time=0.067..0.067 rows=1 loops=6)
                                                                                      Index Cond: (id = e.candidate_id)
                                                                                      Filter: ($17 OR (recruiter_id = ANY ($18)) OR (team_id = ANY ($19)) OR (location_id = ANY ($20)) OR ($21 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 24))
                                                                                      Buffers: shared hit=38
                                                                                      SubPlan 24
                                                                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                              InitPlan 23 (returns $22)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                          ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.002..0.002 rows=2 loops=6)
                                                                                Buffers: shared hit=6
                                                                    ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.001..0.002 rows=13 loops=6)
                                                                          Buffers: shared hit=6
                                                              ->  Seq Scan on app_user cru  (cost=0.00..269.68 rows=168 width=33) (actual time=0.002..0.067 rows=108 loops=6)
                                                                    Buffers: shared hit=1325
                                                        ->  Seq Scan on app_user lu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.001..0.032 rows=89 loops=6)
                                                              Buffers: shared hit=1058
                                                  ->  Limit  (cost=0.01..0.02 rows=1 width=76) (actual time=0.004..0.006 rows=0 loops=6)
                                                        ->  Sort  (cost=0.01..0.02 rows=1 width=76) (actual time=0.003..0.005 rows=0 loops=6)
                                                              Sort Key: a.assignment_no DESC
                                                              Sort Method: quicksort  Memory: 25kB
                                                              ->  Seq Scan on assignment a  (cost=0.00..0.00 rows=1 width=76) (actual time=0.000..0.002 rows=0 loops=6)
                                                                    Filter: ((person_id = e.person_id) AND (SubPlan 151))
                                                                    SubPlan 151
                                                                      ->  Index Scan using placement_pkey on placement p_3  (cost=3.06..11.16 rows=1 width=0) (never executed)
                                                                            Index Cond: (id = a.placement_id)
                                                                            Filter: (($146 OR (recruiter_id = ANY ($147)) OR (team_id = ANY ($148)) OR (location_id = ANY ($149)) OR (hashed SubPlan 150)) AND ($139 OR (recruiter_id = ANY ($140)) OR (team_id = ANY ($141)) OR (location_id = ANY ($142)) OR (hashed SubPlan 144)))
                                                                            InitPlan 139 (returns $139)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                            InitPlan 140 (returns $140)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 141 (returns $141)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 142 (returns $142)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 145 (returns $146)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                            InitPlan 146 (returns $147)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 147 (returns $148)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 148 (returns $149)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            SubPlan 150
                                                                              ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                    InitPlan 149 (returns $150)
                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                    ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                            SubPlan 144
                                                                              ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                    InitPlan 143 (returns $143)
                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                    ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                            ->  Seq Scan on placement pl  (cost=0.35..73.25 rows=850 width=96) (actual time=0.083..0.220 rows=858 loops=6)
                                                  Filter: ($24 OR (recruiter_id = ANY ($25)) OR (team_id = ANY ($26)) OR (location_id = ANY ($27)) OR (hashed SubPlan 30))
                                                  Buffers: shared hit=200
                                                  SubPlan 30
                                                    ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                          InitPlan 29 (returns $28)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                          ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                      ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (actual time=0.001..0.002 rows=24 loops=6)
                                            Buffers: shared hit=6
                                ->  Seq Scan on vendor v  (cost=0.00..1.08 rows=8 width=33) (actual time=0.001..0.001 rows=8 loops=6)
                                      Buffers: shared hit=6
                          ->  Seq Scan on assignment_plan pp  (cost=0.00..0.00 rows=1 width=20) (actual time=0.000..0.001 rows=0 loops=6)
                                Filter: (SubPlan 57)
                                SubPlan 57
                                  ->  Seq Scan on assignment a_1  (cost=0.00..0.00 rows=1 width=0) (never executed)
                                        Filter: ((id = pp.assignment_id) AND (SubPlan 43))
                                        SubPlan 43
                                          ->  Index Scan using placement_pkey on placement p_1  (cost=3.06..11.16 rows=1 width=0) (never executed)
                                                Index Cond: (id = a_1.placement_id)
                                                Filter: (($38 OR (recruiter_id = ANY ($39)) OR (team_id = ANY ($40)) OR (location_id = ANY ($41)) OR (hashed SubPlan 42)) AND ($31 OR (recruiter_id = ANY ($32)) OR (team_id = ANY ($33)) OR (location_id = ANY ($34)) OR (hashed SubPlan 36)))
                                                InitPlan 31 (returns $31)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                InitPlan 32 (returns $32)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 33 (returns $33)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 34 (returns $34)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 37 (returns $38)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                InitPlan 38 (returns $39)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 39 (returns $40)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 40 (returns $41)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                SubPlan 42
                                                  ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                        InitPlan 41 (returns $42)
                                                          ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                        ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                SubPlan 36
                                                  ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                        InitPlan 35 (returns $35)
                                                          ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                        ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                    ->  Seq Scan on assignment_employment ae  (cost=0.00..0.00 rows=1 width=40) (actual time=0.000..0.001 rows=0 loops=6)
                          Filter: (SubPlan 111)
                          SubPlan 111
                            ->  Seq Scan on assignment a_2  (cost=0.00..0.00 rows=1 width=0) (never executed)
                                  Filter: ((id = ae.assignment_id) AND (SubPlan 97))
                                  SubPlan 97
                                    ->  Index Scan using placement_pkey on placement p_2  (cost=3.06..11.16 rows=1 width=0) (never executed)
                                          Index Cond: (id = a_2.placement_id)
                                          Filter: (($92 OR (recruiter_id = ANY ($93)) OR (team_id = ANY ($94)) OR (location_id = ANY ($95)) OR (hashed SubPlan 96)) AND ($85 OR (recruiter_id = ANY ($86)) OR (team_id = ANY ($87)) OR (location_id = ANY ($88)) OR (hashed SubPlan 90)))
                                          InitPlan 85 (returns $85)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                          InitPlan 86 (returns $86)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 87 (returns $87)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 88 (returns $88)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 91 (returns $92)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                          InitPlan 92 (returns $93)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 93 (returns $94)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 94 (returns $95)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          SubPlan 96
                                            ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                  InitPlan 95 (returns $96)
                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                  ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                          SubPlan 90
                                            ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                  InitPlan 89 (returns $89)
                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                  ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
              ->  Function Scan on payroll_companies pc  (cost=0.25..10.25 rows=1000 width=48) (actual time=0.082..0.082 rows=0 loops=6)
                    Buffers: shared hit=23
Planning:
  Buffers: shared hit=154
Planning Time: 4.738 ms
Execution Time: 50.922 ms
```

#### employees/org(hr), term `Zebrowski`, after (median exec 58.2 ms)

```text
Limit  (cost=55897.61..55897.62 rows=5 width=777) (actual time=77.189..77.243 rows=6 loops=1)
  Buffers: shared hit=62842
  InitPlan 1 (returns $0)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.989..0.990 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 18 (returns $17)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.611..0.612 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 19 (returns $18)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 20 (returns $19)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 21 (returns $20)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 22 (returns $21)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
  InitPlan 25 (returns $24)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.584..0.585 rows=1 loops=1)
          Buffers: shared hit=20
  InitPlan 26 (returns $25)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 27 (returns $26)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  InitPlan 28 (returns $27)
    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
  ->  Sort  (cost=55895.01..55895.02 rows=5 width=777) (actual time=77.187..77.234 rows=6 loops=1)
        Sort Key: e.status_since DESC, e.person_id DESC
        Sort Method: quicksort  Memory: 27kB
        Buffers: shared hit=62842
        ->  Nested Loop Left Join  (cost=1.55..55894.95 rows=5 width=777) (actual time=4.622..77.205 rows=6 loops=1)
              Join Filter: (pc.id = ae.payroll_company_id)
              Buffers: shared hit=62842
              ->  Nested Loop Left Join  (cost=1.30..55871.98 rows=1 width=513) (actual time=3.678..76.241 rows=6 loops=1)
                    Join Filter: (ae.assignment_id = a.id)
                    Buffers: shared hit=62819
                    ->  Nested Loop Left Join  (cost=1.30..55871.96 rows=1 width=489) (actual time=3.673..76.219 rows=6 loops=1)
                          Join Filter: (pp.assignment_id = a.id)
                          Buffers: shared hit=62819
                          ->  Nested Loop Left Join  (cost=1.30..55871.95 rows=1 width=485) (actual time=3.667..76.193 rows=6 loops=1)
                                Join Filter: (v.id = pl.vendor_id)
                                Rows Removed by Join Filter: 48
                                Buffers: shared hit=62819
                                ->  Nested Loop Left Join  (cost=1.30..55870.77 rows=1 width=468) (actual time=3.657..76.114 rows=6 loops=1)
                                      Join Filter: (cl.id = pl.client_id)
                                      Rows Removed by Join Filter: 144
                                      Buffers: shared hit=62813
                                      ->  Nested Loop Left Join  (cost=1.30..55869.23 rows=1 width=452) (actual time=3.641..76.054 rows=6 loops=1)
                                            Join Filter: (pl.id = a.placement_id)
                                            Rows Removed by Join Filter: 5148
                                            Buffers: shared hit=62807
                                            ->  Nested Loop Left Join  (cost=0.94..55785.35 rows=1 width=372) (actual time=2.707..73.935 rows=6 loops=1)
                                                  Buffers: shared hit=62607
                                                  ->  Nested Loop Left Join  (cost=0.93..55785.33 rows=1 width=296) (actual time=2.694..73.872 rows=6 loops=1)
                                                        Join Filter: (lu.id = tm.lead_id)
                                                        Rows Removed by Join Filter: 528
                                                        Buffers: shared hit=62607
                                                        ->  Nested Loop Left Join  (cost=0.93..55513.55 rows=1 width=279) (actual time=2.640..73.569 rows=6 loops=1)
                                                              Join Filter: (cru.id = c.recruiter_id)
                                                              Rows Removed by Join Filter: 644
                                                              Buffers: shared hit=61549
                                                              ->  Nested Loop Left Join  (cost=0.93..55241.77 rows=1 width=262) (actual time=2.360..72.865 rows=6 loops=1)
                                                                    Join Filter: (tm.id = c.team_id)
                                                                    Rows Removed by Join Filter: 73
                                                                    Buffers: shared hit=60224
                                                                    ->  Nested Loop Left Join  (cost=0.93..55240.09 rows=1 width=233) (actual time=2.348..72.830 rows=6 loops=1)
                                                                          Join Filter: (l.id = c.location_id)
                                                                          Rows Removed by Join Filter: 7
                                                                          Buffers: shared hit=60218
                                                                          ->  Nested Loop Left Join  (cost=0.93..55239.00 rows=1 width=225) (actual time=2.339..72.801 rows=6 loops=1)
                                                                                Buffers: shared hit=60212
                                                                                ->  Nested Loop  (cost=0.29..55237.14 rows=1 width=163) (actual time=1.707..72.138 rows=6 loops=1)
                                                                                      Buffers: shared hit=60174
                                                                                      ->  Seq Scan on employee e  (cost=0.00..234.00 rows=5000 width=90) (actual time=1.005..2.466 rows=10000 loops=1)
                                                                                            Filter: $0
                                                                                            Buffers: shared hit=154
                                                                                      ->  Index Scan using person_pkey on person p  (cost=0.29..11.00 rows=1 width=73) (actual time=0.007..0.007 rows=0 loops=10000)
                                                                                            Index Cond: (id = e.person_id)
                                                                                            Filter: ((SubPlan 9) AND (((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text))
                                                                                            Rows Removed by Filter: 1
                                                                                            Buffers: shared hit=60020
                                                                                            SubPlan 9
                                                                                              ->  Index Scan using candidate_person_id_key on candidate c_1  (cost=1.94..10.01 rows=1 width=0) (actual time=0.003..0.003 rows=1 loops=10000)
                                                                                                    Index Cond: (person_id = p.id)
                                                                                                    Filter: ($2 OR (recruiter_id = ANY ($3)) OR (team_id = ANY ($4)) OR (location_id = ANY ($5)) OR ($6 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 8))
                                                                                                    Buffers: shared hit=30020
                                                                                                    InitPlan 2 (returns $2)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.668..0.668 rows=1 loops=1)
                                                                                                            Buffers: shared hit=20
                                                                                                    InitPlan 3 (returns $3)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                    InitPlan 4 (returns $4)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                    InitPlan 5 (returns $5)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                    InitPlan 6 (returns $6)
                                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                                                    SubPlan 8
                                                                                                      ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                                            InitPlan 7 (returns $7)
                                                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                                            ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                                ->  Index Scan using candidate_pkey on candidate c  (cost=0.64..1.86 rows=1 width=78) (actual time=0.108..0.108 rows=1 loops=6)
                                                                                      Index Cond: (id = e.candidate_id)
                                                                                      Filter: ($17 OR (recruiter_id = ANY ($18)) OR (team_id = ANY ($19)) OR (location_id = ANY ($20)) OR ($21 AND (visibility = 'all_teams'::text) AND (marketing_status = ANY ('{active,full_of_interviews}'::text[]))) OR (hashed SubPlan 24))
                                                                                      Buffers: shared hit=38
                                                                                      SubPlan 24
                                                                                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                              InitPlan 23 (returns $22)
                                                                                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                          ->  Seq Scan on location l  (cost=0.00..1.04 rows=4 width=24) (actual time=0.002..0.002 rows=2 loops=6)
                                                                                Buffers: shared hit=6
                                                                    ->  Seq Scan on team tm  (cost=0.00..1.30 rows=30 width=45) (actual time=0.001..0.002 rows=13 loops=6)
                                                                          Buffers: shared hit=6
                                                              ->  Seq Scan on app_user cru  (cost=0.00..269.68 rows=168 width=33) (actual time=0.002..0.105 rows=108 loops=6)
                                                                    Buffers: shared hit=1325
                                                        ->  Seq Scan on app_user lu  (cost=0.00..269.68 rows=168 width=33) (actual time=0.001..0.042 rows=89 loops=6)
                                                              Buffers: shared hit=1058
                                                  ->  Limit  (cost=0.01..0.02 rows=1 width=76) (actual time=0.006..0.008 rows=0 loops=6)
                                                        ->  Sort  (cost=0.01..0.02 rows=1 width=76) (actual time=0.005..0.006 rows=0 loops=6)
                                                              Sort Key: a.assignment_no DESC
                                                              Sort Method: quicksort  Memory: 25kB
                                                              ->  Seq Scan on assignment a  (cost=0.00..0.00 rows=1 width=76) (actual time=0.001..0.002 rows=0 loops=6)
                                                                    Filter: ((person_id = e.person_id) AND (SubPlan 151))
                                                                    SubPlan 151
                                                                      ->  Index Scan using placement_pkey on placement p_3  (cost=3.06..11.16 rows=1 width=0) (never executed)
                                                                            Index Cond: (id = a.placement_id)
                                                                            Filter: (($146 OR (recruiter_id = ANY ($147)) OR (team_id = ANY ($148)) OR (location_id = ANY ($149)) OR (hashed SubPlan 150)) AND ($139 OR (recruiter_id = ANY ($140)) OR (team_id = ANY ($141)) OR (location_id = ANY ($142)) OR (hashed SubPlan 144)))
                                                                            InitPlan 139 (returns $139)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                            InitPlan 140 (returns $140)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 141 (returns $141)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 142 (returns $142)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 145 (returns $146)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                                            InitPlan 146 (returns $147)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 147 (returns $148)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            InitPlan 148 (returns $149)
                                                                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                            SubPlan 150
                                                                              ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                    InitPlan 149 (returns $150)
                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                    ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                                            SubPlan 144
                                                                              ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                                                    InitPlan 143 (returns $143)
                                                                                      ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                                                    ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                            ->  Seq Scan on placement pl  (cost=0.35..73.25 rows=850 width=96) (actual time=0.100..0.301 rows=858 loops=6)
                                                  Filter: ($24 OR (recruiter_id = ANY ($25)) OR (team_id = ANY ($26)) OR (location_id = ANY ($27)) OR (hashed SubPlan 30))
                                                  Buffers: shared hit=200
                                                  SubPlan 30
                                                    ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                          InitPlan 29 (returns $28)
                                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                          ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                      ->  Seq Scan on client cl  (cost=0.00..1.24 rows=24 width=32) (actual time=0.002..0.005 rows=24 loops=6)
                                            Buffers: shared hit=6
                                ->  Seq Scan on vendor v  (cost=0.00..1.08 rows=8 width=33) (actual time=0.001..0.002 rows=8 loops=6)
                                      Buffers: shared hit=6
                          ->  Seq Scan on assignment_plan pp  (cost=0.00..0.00 rows=1 width=20) (actual time=0.001..0.002 rows=0 loops=6)
                                Filter: (SubPlan 57)
                                SubPlan 57
                                  ->  Seq Scan on assignment a_1  (cost=0.00..0.00 rows=1 width=0) (never executed)
                                        Filter: ((id = pp.assignment_id) AND (SubPlan 43))
                                        SubPlan 43
                                          ->  Index Scan using placement_pkey on placement p_1  (cost=3.06..11.16 rows=1 width=0) (never executed)
                                                Index Cond: (id = a_1.placement_id)
                                                Filter: (($38 OR (recruiter_id = ANY ($39)) OR (team_id = ANY ($40)) OR (location_id = ANY ($41)) OR (hashed SubPlan 42)) AND ($31 OR (recruiter_id = ANY ($32)) OR (team_id = ANY ($33)) OR (location_id = ANY ($34)) OR (hashed SubPlan 36)))
                                                InitPlan 31 (returns $31)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                InitPlan 32 (returns $32)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 33 (returns $33)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 34 (returns $34)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 37 (returns $38)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                                InitPlan 38 (returns $39)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 39 (returns $40)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                InitPlan 40 (returns $41)
                                                  ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                SubPlan 42
                                                  ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                        InitPlan 41 (returns $42)
                                                          ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                        ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                                SubPlan 36
                                                  ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                        InitPlan 35 (returns $35)
                                                          ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                        ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                    ->  Seq Scan on assignment_employment ae  (cost=0.00..0.00 rows=1 width=40) (actual time=0.000..0.002 rows=0 loops=6)
                          Filter: (SubPlan 111)
                          SubPlan 111
                            ->  Seq Scan on assignment a_2  (cost=0.00..0.00 rows=1 width=0) (never executed)
                                  Filter: ((id = ae.assignment_id) AND (SubPlan 97))
                                  SubPlan 97
                                    ->  Index Scan using placement_pkey on placement p_2  (cost=3.06..11.16 rows=1 width=0) (never executed)
                                          Index Cond: (id = a_2.placement_id)
                                          Filter: (($92 OR (recruiter_id = ANY ($93)) OR (team_id = ANY ($94)) OR (location_id = ANY ($95)) OR (hashed SubPlan 96)) AND ($85 OR (recruiter_id = ANY ($86)) OR (team_id = ANY ($87)) OR (location_id = ANY ($88)) OR (hashed SubPlan 90)))
                                          InitPlan 85 (returns $85)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                          InitPlan 86 (returns $86)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 87 (returns $87)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 88 (returns $88)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 91 (returns $92)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                                          InitPlan 92 (returns $93)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 93 (returns $94)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          InitPlan 94 (returns $95)
                                            ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                          SubPlan 96
                                            ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                  InitPlan 95 (returns $96)
                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                  ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                                          SubPlan 90
                                            ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                                                  InitPlan 89 (returns $89)
                                                    ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                                                  ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
              ->  Function Scan on payroll_companies pc  (cost=0.25..10.25 rows=1000 width=48) (actual time=0.156..0.156 rows=0 loops=6)
                    Buffers: shared hit=23
Planning:
  Buffers: shared hit=154
Planning Time: 7.656 ms
Execution Time: 78.396 ms
```

#### applicants/org(hr), term `Zebrowski`, before (median exec 15.3 ms)

```text
Limit  (cost=1897.80..1904.83 rows=7 width=147) (actual time=15.113..15.131 rows=11 loops=1)
  Buffers: shared hit=817
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.804..0.805 rows=1 loops=1)
          Buffers: shared hit=20
  ->  Result  (cost=1897.54..1904.57 rows=7 width=147) (actual time=15.111..15.126 rows=11 loops=1)
        Buffers: shared hit=817
        ->  Sort  (cost=1897.54..1897.56 rows=7 width=143) (actual time=15.082..15.085 rows=11 loops=1)
              Sort Key: ap.created_at DESC, ap.id DESC
              Sort Method: quicksort  Memory: 26kB
              Buffers: shared hit=817
              ->  Seq Scan on applicant ap  (cost=0.35..1897.44 rows=7 width=143) (actual time=3.530..15.059 rows=11 loops=1)
                    Filter: (((hashed SubPlan 8) OR $8) AND ((((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text) OR (email ~~* '%Zebrowski%'::text)))
                    Rows Removed by Filter: 49989
                    Buffers: shared hit=817
                    SubPlan 8
                      ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (actual time=0.780..0.782 rows=0 loops=1)
                            Buffers: shared hit=25
                            InitPlan 7 (returns $6)
                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.774..0.775 rows=1 loops=1)
                                    Buffers: shared hit=25
                            ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.000..0.001 rows=1 loops=1)
        SubPlan 6
          ->  Aggregate  (cost=0.97..0.98 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=11)
                InitPlan 1 (returns $1)
                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                ->  Seq Scan on job_application a  (cost=0.71..0.71 rows=1 width=0) (actual time=0.001..0.001 rows=0 loops=11)
                      Filter: ((applicant_id = ap.id) AND ($1 OR (hashed SubPlan 3) OR (hashed SubPlan 5)))
                      SubPlan 3
                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                              InitPlan 2 (returns $2)
                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                      SubPlan 5
                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                              InitPlan 4 (returns $4)
                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
Planning:
  Buffers: shared hit=5
Planning Time: 0.339 ms
Execution Time: 15.238 ms
```

#### applicants/org(hr), term `Zebrowski`, after (median exec 13.2 ms)

```text
Limit  (cost=1897.80..1904.83 rows=7 width=147) (actual time=13.069..13.087 rows=11 loops=1)
  Buffers: shared hit=817
  InitPlan 9 (returns $8)
    ->  Result  (cost=0.00..0.26 rows=1 width=1) (actual time=0.638..0.638 rows=1 loops=1)
          Buffers: shared hit=20
  ->  Result  (cost=1897.54..1904.57 rows=7 width=147) (actual time=13.067..13.082 rows=11 loops=1)
        Buffers: shared hit=817
        ->  Sort  (cost=1897.54..1897.56 rows=7 width=143) (actual time=13.043..13.047 rows=11 loops=1)
              Sort Key: ap.created_at DESC, ap.id DESC
              Sort Method: quicksort  Memory: 26kB
              Buffers: shared hit=817
              ->  Seq Scan on applicant ap  (cost=0.35..1897.44 rows=7 width=143) (actual time=2.751..13.026 rows=11 loops=1)
                    Filter: (((hashed SubPlan 8) OR $8) AND ((((first_name || ' '::text) || last_name) ~~* '%Zebrowski%'::text) OR (email ~~* '%Zebrowski%'::text)))
                    Rows Removed by Filter: 49989
                    Buffers: shared hit=817
                    SubPlan 8
                      ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (actual time=0.731..0.733 rows=0 loops=1)
                            Buffers: shared hit=25
                            InitPlan 7 (returns $6)
                              ->  Result  (cost=0.00..0.26 rows=1 width=32) (actual time=0.726..0.727 rows=1 loops=1)
                                    Buffers: shared hit=25
                            ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.000..0.000 rows=1 loops=1)
        SubPlan 6
          ->  Aggregate  (cost=0.97..0.98 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=11)
                InitPlan 1 (returns $1)
                  ->  Result  (cost=0.00..0.26 rows=1 width=1) (never executed)
                ->  Seq Scan on job_application a  (cost=0.71..0.71 rows=1 width=0) (actual time=0.001..0.001 rows=0 loops=11)
                      Filter: ((applicant_id = ap.id) AND ($1 OR (hashed SubPlan 3) OR (hashed SubPlan 5)))
                      SubPlan 3
                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                              InitPlan 2 (returns $2)
                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
                      SubPlan 5
                        ->  ProjectSet  (cost=0.26..0.33 rows=10 width=16) (never executed)
                              InitPlan 4 (returns $4)
                                ->  Result  (cost=0.00..0.26 rows=1 width=32) (never executed)
                              ->  Result  (cost=0.00..0.01 rows=1 width=0) (never executed)
Planning:
  Buffers: shared hit=5
Planning Time: 0.256 ms
Execution Time: 13.171 ms
```


# Pipeline report: one evaluation per request and keyset paging (R-23, E-03)

Measured by W3-H on 2026-11-05. Before = `pipeline-report.service.ts` at 6cc3ad5 (a page query with
`count(*) OVER ()` + `ORDER BY lower(name) … OFFSET`, then a second statement that rebuilt and re-ran the
whole `baseSql` CTE for the summary). After = one statement: `rows AS MATERIALIZED` feeds a `summary` CTE and a
`page` CTE (keyset on `(lower(name) NULLS LAST, id)`, the deprecated `OFFSET` still applied), joined
`summary LEFT JOIN page`, with the lookup joins (technology, team, recruiter, location) done after the
`LIMIT`. No index was added (migration 0489 not used): the sort key is computed after the aggregation, so no
index can serve it; the cost is the aggregation itself.

## Environment and method

- Same cluster as above (PostgreSQL 16.15, tmpfs, `fsync=off`, 4 vCPU, shared with other agents' test runs,
  so ±30 % noise). Scratch database `eureka_perf_w3h` from `pnpm --filter @eureka/api db:seed-load`
  (default volume: 50,000 candidates, 58,352 submissions, 16,214 interviews, 892 placements, 167 users),
  plus one `perf-ceo@eureka.example` user holding `ceo` (org scope), then `VACUUM ANALYZE`.
- A script booted the real API (`createApp`, `AUTH_MODE=dev`, swc decorators) against the scratch database,
  signed in, called `GET /api/v1/reports/pipeline?…` and captured the exact SQL and parameters the service
  sent. Each captured statement was run with `EXPLAIN (ANALYZE, BUFFERS)` five times in a rolled-back
  transaction as the API runs it (`SET LOCAL ROLE eureka_app`, `eureka.user_id` = caller). "Exec" = median
  execution time, summed over the statements of one request; "Buffers" = shared hits of the top plan node,
  summed; "HTTP" = median of three `app.inject` round trips after one warm-up. Two full runs each side; both
  are shown (before run 1 used a period with no activity, so its `period` row is omitted).
- Cases: `org` = perf-ceo, `team` = `load-lead-01`; `page1` = `limit=50`; `offset5000` = `limit=50&offset=5000`;
  `period` = `limit=50&from=2026-09-01&to=2026-10-31` (29,556 candidates match); `cursor@5000` (after only) =
  `limit=50&cursor=<nextCursor of the page ending at row 5000>`, the keyset equivalent of `offset5000`.

## Results

| Case | Rows matched | Statements before → after | Exec before (ms) | Exec after (ms) | Buffers before → after | HTTP before (ms) | HTTP after (ms) |
|---|--:|---|--:|--:|---|--:|--:|
| org/page1 | 50,000 | 2 → 1 | 1,157 / 1,540 | 623 / 530 | 653K → 328K | 1,238 / 1,609 | 499 / 487 |
| org/offset5000 | 50,000 | 2 → 1 | 2,794 / 1,684 | 633 / 518 | 653K → 328K | 2,496 / 1,261 | 505 / 457 |
| org/cursor@5000 | 50,000 | – → 1 | – | 757 / 586 | – → 328K | – | 498 / 479 |
| org/period | 29,556 | 2 → 1 | – / 1,210 | 524 / 540 | 654K → 328K | – / 878 | 460 / 395 |
| team/page1 | 1,667 | 2 → 1 | 132 / 153 | 51 / 50 | 43.1K → 22.8K | 166 / 188 | 71 / 57 |

## Findings

- **Half the database work per request, as predicted.** Shared-buffer touches halve in every case (one
  evaluation of the full-history aggregation instead of two), and execution time drops 55–70 % for org
  scope and about 65 % for team scope. HTTP latency drops from 0.9–2.5 s to about 0.4–0.5 s at org scope.
- **Deep pages no longer cost more than the first.** Before, `offset=5000` paid for the window count, the
  full sort and the skipped rows on top of the second evaluation; after, `offset5000`, `cursor@5000` and
  `page1` are within noise of each other because the aggregation (≈ 370 ms of the ≈ 500 ms at org scope:
  hash joins over all 50,000 candidates' submissions, interviews and assessments) dominates. The keyset does
  not make org-scope pages cheap by itself; it makes the page cost independent of depth and removes the
  10,000 offset ceiling for clients that adopt `cursor`.
- **Page and summary always agree.** Both are read from the same materialized `rows` in one statement and
  therefore one snapshot; before, a write committed between the two statements could make `total`/`funnel`
  disagree with the page.
- **Remaining cost (not done here):** the org-scope report still aggregates every candidate's whole history
  on each call (≈ 0.5 s on this data). The finding's further option, a persisted "furthest stage" per
  candidate maintained by triggers or the outbox, or a short per-user summary cache, would be the next step
  if the report becomes hot; both need a design decision (trigger upkeep and backfill, or staleness).
