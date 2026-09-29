# @eureka/api

NestJS (Fastify) API. See `docs/design.md` for the security model.

## Run locally

```bash
createdb eureka   # PostgreSQL 16
MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/eureka APP_DB_PASSWORD=dev pnpm --filter @eureka/api db:seed
cp ../../.env.example .env   # set DATABASE_URL=postgres://eureka_app:dev@127.0.0.1:5432/eureka
pnpm --filter @eureka/api dev
```

## Tests

`pnpm test` creates a throwaway database per run on `TEST_PG_ADMIN_URL`
(default `postgres://postgres:postgres@127.0.0.1:5432`) and runs:

| Suite | What it proves |
|---|---|
| `test/rls.int.test.ts` | RLS on every sensitive table; hardened definer functions; RLS alone returns exactly what the engine allows for every fixture user (differential); column guards, snapshots, transitions, worker limits |
| `test/api.int.test.ts` | Sessions, CSRF, timeouts, OIDC validation and account linking; authorization matrix generated from the catalog for every role × endpoint; API differential; 404 vs 403; mass assignment; field masking; audit |
