---
name: eureka-handoff
description: Wrap up a Eureka work session — update the PR Handoff block, record the merge in docs/HANDOFF.md, queue the staging deploy train. Use when the user says "wrap up", "hand off", "I'm stopping", "merge this", "ship it", or at the end of any session with unfinished or finished work.
---

# Eureka handoff

Several Claude sessions work this repo at once. Work that exists only locally is lost when the
container is reclaimed. Handoff lives in the **PR description**.

## Before stopping (always)

1. `pnpm -r typecheck` and relevant tests (`eureka-test-run`). Note failures honestly.
2. Commit and push the branch. Unfinished work: push + **draft** PR, never local only.
3. Update the PR description's handoff block:
   ```
   ## Handoff
   Done: …   Left: …   Gotchas: …   Migrations: 04x0–04x9 (used: …)
   ```
   `Left` = concrete next steps; `Gotchas` = traps the next session would hit (stale template,
   flaky test, open product question). Migrations line must match `scripts/session-brief.sh`.
4. To pick up someone else's work: `gh pr view N` and read their handoff.

## On merge to main

1. Add **one line** to `docs/HANDOFF.md` under "Built" (grep for `## Built`, don't read the
   30K file). Nothing else in that file per session.
2. After pushing to main, queue the train in the background:
   ```bash
   infra/scripts/deploy-train.sh go
   ```
   It deploys only when ≥3 non-doc commits are queued; under 3 it exits 0 and commits wait.
   Use `--force` only when the user explicitly asks for a deploy now. Never call
   `deploy-local.sh` directly.

## Don'ts

- Don't edit files in another session's worktree; the main checkout is for merge/review only.
- Don't write session notes into `docs/HANDOFF.md` beyond the one Built line.
