# Eureka App

Internal talent-operations platform replacing the Sales, interview and placement Google Sheets.
All sample data in this repository is fictional.

- Design (HLD + LLD): [docs/design.md](docs/design.md)
- Implementation plan: [docs/implementation-plan.md](docs/implementation-plan.md)

## Layout

| Path | Contents |
|---|---|
| `packages/shared` | Authorization catalog (roles, permissions, scoped grants), engine and tests |
| `apps/api` | NestJS API and worker |
| `apps/web` | React web app |
| `db/migrations` | SQL migrations including RLS policies |
| `infra` | AWS Terraform/Terragrunt and deploy runbook ([infra/README.md](infra/README.md)) |
| `Dockerfile` | One ARM64 image for the API, worker and migration task |

## Run it locally (one command)

Needs Node 22+ and Docker Desktop running.

```bash
pnpm local            # or ./scripts/local-dev.sh; add --reset to start from a fresh database
```

It starts PostgreSQL 16 in Docker (port 55432), applies migrations, seeds fictional
users and candidates, then runs the API (:3000) and web app (:5173) and opens the
browser. Pick a fictional user on the sign-in screen, for example
"Recruiter (Team Rohit)", "Lead (Team Rohit)", "Location Ops Admin (Dallas)" or
"Org Admin". Ctrl-C stops everything; the database keeps its data between runs.

## Develop

Requires Node 22, pnpm 10 and PostgreSQL 16.

```bash
pnpm install
pnpm -r test          # unit + integration tests (create throwaway databases)
pnpm docs:grants      # regenerate the grants table used in docs/design.md

# run locally with fictional data
createdb eureka_dev
MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/eureka_dev APP_DB_PASSWORD=devpass \
  pnpm --filter @eureka/api exec tsx src/db/seed-dev.ts
NODE_ENV=development AUTH_MODE=dev SESSION_SECRET=$(openssl rand -hex 32) \
  DATABASE_URL=postgres://eureka_app:devpass@127.0.0.1:5432/eureka_dev pnpm --filter @eureka/api dev
pnpm --filter @eureka/web dev          # http://localhost:5173, pick a fictional user to sign in
pnpm --filter @eureka/web e2e          # Playwright role journeys against the running stack
```

E2E environment: `E2E_BASE_URL` (web app, default http://localhost:5173), `PW_CHROMIUM` (a
preinstalled Chromium binary instead of `playwright install`) and `E2E_DATABASE_URL` (superuser
URL of the stack's database, e.g. `postgres://postgres:postgres@127.0.0.1:5432/eureka_dev`; only
the candidate feedback journey needs it, to mint a feedback link as the worker would, and it skips
without it). Journeys create their own records, so they can run in parallel and be repeated on one
seeded database.

## Deploy

AWS (ECS Fargate, RDS, CloudFront) via GitHub Actions with OIDC; no AWS keys in the repo.
One-time setup and the deploy flow are in [infra/README.md](infra/README.md).
