#!/usr/bin/env bash
# SessionStart hook: short, git-derived briefing so parallel Claude sessions see each other's work.
# Prints worktrees, open PRs, and migration numbers taken on any branch. No fetch (stays fast).
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

max_migration() { # highest 4-digit migration number in a ref (or the working tree when no ref)
  if [ -n "$1" ]; then git ls-tree --name-only "$1" db/migrations/ 2>/dev/null
  else ls db/migrations 2>/dev/null; fi | sed -nE 's#.*/?([0-9]{4})_.*#\1#p' | sort -n | tail -1
}

echo "## Session brief (scripts/session-brief.sh)"
echo "Here: $(git branch --show-current) @ $(git rev-parse --short HEAD), behind origin/main by $(git rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
[ -n "$(git ls-files -u | head -1)" ] && echo "WARNING: unresolved merge conflicts in this checkout"

echo "Worktrees (one session each; do not edit another's):"
git worktree list | sed 's/^/  /'

if command -v gh >/dev/null; then
  echo "Open PRs (handoff notes in each description: gh pr view N):"
  prs=$(gh pr list --state open --limit 30 --json number,title,headRefName,isDraft \
    --jq '.[] | select(.headRefName | startswith("dependabot") | not)
          | "  #\(.number) \(if .isDraft then "[draft] " else "" end)\(.headRefName): \(.title)"' 2>/dev/null)
  echo "${prs:-  (none)}"
fi

main_max=$(max_migration origin/main)
all_max=$(max_migration)
echo "Migrations: origin/main highest ${main_max:-none}. Taken on other branches:"
# Remote branches, plus local ones with no origin counterpart (unpushed work).
refs=$(git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -v -e '^origin$' -e '/HEAD$' -e dependabot)
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
  git show-ref --verify -q "refs/remotes/origin/$b" || refs="$refs $b"
done
for ref in $refs; do
  m=$(max_migration "$ref")
  if [ -n "$m" ] && [ "$m" \> "${main_max:-0000}" ]; then
    echo "  $ref: up to $m"
    [ "$m" \> "${all_max:-0000}" ] && all_max=$m
  fi
done
[ "${all_max:-0000}" \> "${main_max:-0000}" ] || echo "  (none)"
echo "Next free migration block: $(printf '%04d' $(( (10#${all_max:-0} / 10 + 1) * 10 )))"
