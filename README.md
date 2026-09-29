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

## Develop

Requires Node 22, pnpm 10 and PostgreSQL 16.

```bash
pnpm install
pnpm -r test          # 328 unit + integration tests (creates throwaway databases)
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
