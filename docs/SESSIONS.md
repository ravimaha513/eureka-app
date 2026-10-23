# Sessions: who is doing what

Retired as a hand-kept table (it went stale and was invisible to other worktrees). Work in flight is
now read from git:

- `scripts/session-brief.sh` (runs automatically at session start): worktrees, open PRs, migration
  numbers taken on every branch, next free migration block.
- Handoff notes live in each PR description (`gh pr view N`).
- Rules for parallel sessions: `CLAUDE.md` "Parallel sessions".
