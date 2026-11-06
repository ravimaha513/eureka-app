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

## Tools and technology

### What you need installed

| Tool | Version | Needed for |
|---|---|---|
| [Node.js](https://nodejs.org) | 22+ (image pins 22.20) | Everything (`engines.node >= 22`) |
| [pnpm](https://pnpm.io) | 10 (`packageManager: pnpm@10.28.0`; `corepack enable` picks it up) | Workspace install and scripts |
| [Docker](https://www.docker.com) (Desktop or Engine + Compose) | current | `pnpm local` (dev Postgres on :55432) and `pnpm test:api` (throwaway test Postgres on :55433) |
| Git | any recent | Source control |
| PostgreSQL client tools (`psql`, `createdb`) | 16 | Optional: only for the manual setup under "Develop" without Docker |
| Chromium for Playwright | from `@playwright/test` 1.x | Optional: E2E journeys (`playwright install chromium`, or point `PW_CHROMIUM` at a binary) |
| [k6](https://k6.io) | current | Optional: load test in [loadtest/](loadtest/README.md) |
| Terraform / Terragrunt | 1.10.5 / 0.77.22 (as in CI) | Optional: only for infra work; staging deploys run in GitHub Actions, no local install needed |
| AWS CLI | v2 | Optional: only for the one-time infra setup in [infra/README.md](infra/README.md) |

### Stack

| Area | Technology |
|---|---|
| Language | TypeScript 5 throughout (pnpm monorepo) |
| API + worker | NestJS 10 on Fastify 4, Zod 3 validation (OpenAPI via `zod-to-openapi`), `pg` driver, `jose` (JWT), SWC build |
| Web | React 18, Vite 5, TanStack Query 5, Recharts, lucide-react, pdf.js / mammoth (resume preview), DOMPurify |
| Shared | `packages/shared`: authorization catalog and engine (Zod) |
| Database | PostgreSQL 16 with row-level security, SECURITY DEFINER functions, plain SQL migrations in `db/migrations` |
| Files and mail | Amazon S3 (presigned uploads), AWS KMS, Amazon SES v2; local disk storage in dev |
| Spreadsheets | ExcelJS, read-excel-file (Sheets import/export) |
| Testing | Vitest 2 (unit + integration against real Postgres), Testing Library + jsdom (web), Playwright (E2E), k6 (load), OWASP ZAP baseline (CI) |
| Infrastructure | AWS: ECS Fargate (ARM64), RDS PostgreSQL, CloudFront + WAF, API Gateway, S3; Terraform + Terragrunt |
| CI/CD | GitHub Actions with AWS OIDC (`ci.yml`, `deploy.yml`, `zap-baseline.yml`, ...); one Docker image (`Dockerfile`) for API, worker and migrations |

## Run it locally (one command)

Needs Node 22+ and Docker Desktop running.

```bash
pnpm local            # or ./scripts/local-dev.sh; add --reset to start from a fresh database
```

It starts PostgreSQL 16 in Docker (port 55432), applies migrations, seeds fictional
users and candidates plus a sample pipeline (about 48 submissions at every stage, past and
upcoming interviews with feedback, and placements from Confirmed to Joined and Backout), then runs the API (:3000) and web app (:5173) and opens the
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
# an existing dev database: re-running the seed applies new migrations and adds the sample
# pipeline once (it skips users and candidates that are already there)
MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/eureka_dev pnpm --filter @eureka/api db:seed
```

E2E environment: `E2E_BASE_URL` (web app, default http://localhost:5173), `PW_CHROMIUM` (a
preinstalled Chromium binary instead of `playwright install`) and `E2E_DATABASE_URL` (superuser
URL of the stack's database, e.g. `postgres://postgres:postgres@127.0.0.1:5432/eureka_dev`; only
the candidate feedback journey needs it, to mint a feedback link as the worker would, and it skips
without it). The resume journeys need the worker running with the same `LOCAL_STORAGE_DIR` as the
API (as `pnpm local` does), so uploads get scanned. Journeys create their own records, so they can run in parallel and be repeated on one
seeded database.

## Deploy

AWS (ECS Fargate, RDS, CloudFront) via GitHub Actions with OIDC; no AWS keys in the repo.
One-time setup and the deploy flow are in [infra/README.md](infra/README.md).
