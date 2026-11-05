---
name: eureka-test-run
description: Run Eureka's API, unit, typecheck or web tests the right way (queued gate, throwaway Postgres, filtered output). Use whenever about to run tests, "run the suite", "does this pass", before a commit, or when a test run hangs, runs out of connections, or shows stale schema.
---

# Running Eureka tests

## Commands

| What | Command |
|---|---|
| Typecheck all | `pnpm -r typecheck 2>&1 \| tail -40` |
| All unit + int (pre-commit) | `pnpm -r test 2>&1 \| grep -E 'FAIL\|Error\|✓ \|Tests ' \| tail -40` |
| One API file | `pnpm test:api test/<file> --reporter=dot 2>&1 \| tail -40` |
| Full API suite (~4 min) | `pnpm test:api --reporter=dot 2>&1 \| grep -E 'FAIL\|Error\|Tests ' \| tail -40` |
| Web unit | `pnpm --filter @eureka/web test` |
| E2E | `pnpm --filter @eureka/web e2e` against a running, freshly seeded `pnpm local` |

## Rules

- **Never call `vitest` directly** for API tests — it skips `scripts/test-api-gate.sh`, the
  machine-wide queue (one full suite with 6 forks; 3 filtered runs with 2 forks each).
- `pnpm test:api` starts throwaway tmpfs Postgres `testdb` on :55433 (600 connections). The dev
  DB on :55432 only allows 100 — too few. Don't point tests at it.
- Don't run web and API suites at the same time.
- Prefer filtered runs while iterating; run the full suite once before pushing.
- Pipe output; never dump a full vitest log into context.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Schema looks old / new migration not applied | `TEST_FRESH_TEMPLATE=1 pnpm test:api ...` (template cached by hash) |
| "Waiting for test gate" | Another session runs tests; wait. Stale locks from dead PIDs clear automatically |
| Too many connections / OOM | `TEST_MAX_FORKS=2` |
| One file takes minutes alone | Split it (`eureka-shard-split`) |
| testdb not up | `docker compose --profile test up -d --wait testdb` |

## Reporting

Report pass/fail with the failing test names and the first error lines. If a run was skipped
or partial, say so.
