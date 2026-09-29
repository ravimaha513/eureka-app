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

```bash
pnpm install
pnpm test          # unit + integration (needs PostgreSQL 16, see apps/api/README)
pnpm docs:grants   # regenerate the grants table used in docs/design.md
```
