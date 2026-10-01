# Load test (k6)

Launch check from the implementation plan: **120 concurrent users, 50k
candidates, p95 < 500 ms, error rate < 1%**, with the Hot List and the
interview board named explicitly. Fictional data only; never run it against
production (the script refuses hosts that are not localhost or `*staging*`).

| File | What |
|---|---|
| `eureka.js` | k6 script: 120 VUs, ramp 2 min, hold 10 min, ramp down 1 min |
| `../apps/api/src/db/seed-load.ts` | seeds the load database: 167 fictional users in 30 teams, 50k candidates, ~58k submissions, ~16k interviews, ~900 placements |

## What a virtual user does

Each VU signs in once as its own fictional user and then loops: one screen
visit (a list, often followed by opening a record), with 2–6 s of think time
between requests. Per 20 VUs: 14 recruiters, 3 leads, 1 manager, 1 location
admin, 1 HR or Accounts user.

| Persona | Mix |
|---|---|
| Recruiter | Hot List 35% (filters, next page, open profile), candidates 20%, submissions 15%, interview board 15%, placements 5% |
| Lead | Hot List 25%, candidates 20%, submissions 20%, interview board 25%, placements 10% |
| Manager | Hot List 20%, submissions 25%, interview board 30%, placements 25% |
| Location admin | candidates 30%, interview board 50%, submissions 20% |
| HR / Accounts | placements (with detail) 70–80%, Hot List / candidates |

Recruiters and leads also write in 15% of iterations (`WRITE_SHARE`): log a
submission, move one to `under_review`, or schedule an interview (a 409 for an
overlapping slot counts as expected). Thresholds: `http_req_duration` p95 <
500 ms overall and for `name:hotlist` and `name:interviews_board`,
`http_req_failed` < 1%, checks > 99%. k6 exits non-zero when any fails.

## Run locally

```sh
# 1. A throwaway database with the load data (about 4 minutes)
createdb -h 127.0.0.1 -U postgres eureka_load
LOAD_SEED_CONFIRM=127.0.0.1/eureka_load \
MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/eureka_load \
  pnpm --filter @eureka/api db:seed-load
psql postgres://postgres:postgres@127.0.0.1:5432/eureka_load -c "ALTER ROLE eureka_app PASSWORD 'eureka_local'"

# 2. The API in dev sign-in mode against it
cd apps/api && NODE_ENV=development AUTH_MODE=dev SESSION_SECRET=local-dev-session-secret-local-dev-session \
  DATABASE_URL=postgres://eureka_app:eureka_local@127.0.0.1:5432/eureka_load pnpm dev

# 3. k6 (https://grafana.com/docs/k6/latest/set-up/install-k6/)
k6 run -e BASE_URL=http://localhost:3000 loadtest/eureka.js
# quicker smoke: -e VUS=20 -e RAMP=10s -e HOLD=1m -e RAMP_DOWN=10s
```

The seed refuses any host or database name containing "prod" and only runs
when `LOAD_SEED_CONFIRM` names the exact `<host>/<database>`. Re-running it
keeps the data and only re-mints sessions (below). `ALTER ROLE` is
cluster-wide: on a shared Postgres, reuse the password the other databases
already use.

## Run against staging

Staging runs `NODE_ENV=production` with Google sign-in, so dev sign-in is
refused there. Use **minted sessions** instead: the seed inserts one session
per load user with id `hex(HMAC-SHA256(LOAD_SESSION_KEY, email))`, and k6
derives the same ids. Pick a throwaway key of 32+ characters per run; the
sessions expire after `LOAD_SESSION_HOURS` (default 12) and, like every
session, after 60 idle minutes, so start k6 within the hour (or seed again).

1. Create staging (`infra/README.md`) and let the deploy apply migrations.
2. Seed it from inside the VPC with a one-off task on the migrate task
   definition (it has the master credentials and the image contains
   `dist/db/seed-load.js`):

   ```sh
   cd infra/live/staging && OUT=$(terragrunt output -json)
   DB=$(jq -r .db_endpoint.value <<<"$OUT")
   aws ecs run-task --region us-east-2 --cluster "$(jq -r .ecs_cluster.value <<<"$OUT")" \
     --task-definition "$(jq -r .migrate_task_definition.value <<<"$OUT")" --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[$(jq -r '.public_subnet_ids.value|join(",")' <<<"$OUT")],securityGroups=[$(jq -r .jobs_security_group_id.value <<<"$OUT")],assignPublicIp=ENABLED}" \
     --overrides "$(jq -nc --arg c "$DB/eureka" --arg k "$LOAD_SESSION_KEY" '{containerOverrides:[{name:"migrate",
        command:["node","dist/db/seed-load.js"],
        environment:[{name:"LOAD_SEED_CONFIRM",value:$c},{name:"LOAD_SESSION_KEY",value:$k}]}]}')"
   ```

   Logs: `/eureka/staging/migrate`. Overrides are visible in the ECS API, so
   the key must be a fresh one used only for this run.
3. Run k6 with the same key:

   ```sh
   k6 run -e BASE_URL=https://eureka-staging.spokenly.click -e AUTH=minted \
     -e LOAD_SESSION_KEY="$LOAD_SESSION_KEY" loadtest/eureka.js
   ```

Before a staging run, account for the edge limits (they are per source IP and
will otherwise dominate the result):

- **WAF** blocks an IP above `waf_rate_limit_per_5min` (2000 on staging).
  120 VUs from one machine send roughly 25–30 requests/s, about 8,000 per 5
  minutes. Raise the limit for the test window in `infra/live/staging/env.hcl`
  (and lower it afterwards), or run k6 from several machines.
- **API Gateway** throttles the stage at 100 requests/s (burst 300), which is
  enough for this mix.
- **Hot List** allows 60 pages per user per minute per API task; each VU is a
  different user (up to 120 recruiters exist), so this only bites if VUS is
  raised far above 120.
- To bypass CloudFront and WAF entirely, target the API Gateway endpoint
  (`terragrunt output api_gateway_endpoint`) with
  `-e ALLOW_HOST=<that host> -e ORIGIN_VERIFY=<value of /eureka/staging/app/origin_secret>`.
  That measures the API alone, without the edge.

Also note that staging runs one 0.25 vCPU API task (`api_max_count = 2`) on a
db.t4g.micro: the result is a lower bound for production sizing, and the
p95 target applies to the production configuration.

## First local results (2026-10-01, not a pass)

One API process (pool of 10 connections) and PostgreSQL 16 on a shared
development container, 120 VUs, 30 s ramp, 2 min hold:

| Metric | Result | Target |
|---|---|---|
| p95, all requests | 565 ms | < 500 ms |
| p95, Hot List | 719 ms | < 500 ms |
| p95, interview board | 456 ms | < 500 ms |
| failed requests | 0.02% | < 1% |

Things to look at before the staging run (all three tuned since, below):

- `GET /api/v1/submissions` without filters takes 1.7 s for a manager and
  2.4 s for a location admin even when idle (58k submissions), and under load
  one request hit the API's 5 s `statement_timeout`.
- The Hot List page takes ~200 ms idle and is the slowest screen under load.
- `GET /api/v1/interviews` without a date range takes 0.5–0.8 s for broad
  scopes (the board always sends one).

### Tuning (2026-10-01, idle, same seed; service time, 20 runs, p95)

| Endpoint | Manager | Location admin | Lead |
|---|---|---|---|
| submissions, before 0027 | 1,608 ms | 2,612 ms | 473 ms |
| submissions, after 0027 + 0034 | 38 ms | 42 ms | 34 ms |
| interviews (no range), before 0027 | 476 ms | 765 ms | 226 ms |
| interviews (no range), after 0027 + 0034 | 57 ms | 45 ms | 52 ms |
| Hot List, before 0034 | 235 ms | 236 ms | 276 ms |
| Hot List, after 0034 | 10 ms | 16 ms | 10 ms |

Causes: (1) no index matched the list order, so every visible row was
joined and sorted before `LIMIT` (0027 added `submitted_at` / `starts_at`
indexes); (2) the activity read policies searched the caller's
owned-candidate array linearly per row (~12,500 ids for a location admin:
2.2 s just to read the visible submissions; 0034 makes it a hashed set,
45 ms); (3) `authz.hotlist_page` ran a generic plan that sorted all ~40k
Hot List rows per page (0034 plans each call with its actual arguments).

0038 applies the same two fixes to the placement and assignment read policies
and to `authz.hotlist_export` (idle p95, before → after: placements list
81 → 58 ms manager, 60 → 46 ms location admin, 48 → 37 ms lead; full export
298 → 157 ms manager, 172 → 55 ms lead; export with a name search 212 → 60 ms).

### Second local run (2026-10-01, after 0034 and 0038: a pass)

Same setup as the first run (one API process, pool of 10, shared PostgreSQL 16,
fresh load seed with all migrations), 120 VUs, 30 s ramp, 2 min hold, 10 s ramp
down; 4,553 requests, 2,673 iterations:

| Metric | First run | Second run | Target |
|---|---|---|---|
| p95, all requests | 565 ms | 156 ms | < 500 ms |
| p95, Hot List | 719 ms | 113 ms | < 500 ms |
| p95, interview board | 456 ms | 214 ms | < 500 ms |
| failed requests | 0.02% | 0.00% | < 1% |
| checks | | 100% | > 99% |

Slowest single request: 663 ms (interview board). Staging (0.25 vCPU,
db.t4g.micro) is still to be measured.
