#!/usr/bin/env bash
# Batched staging deploys ("deploy train"): ship origin/main once 3-5 changes have queued, one deploy at a time.
# Usage: infra/scripts/deploy-train.sh status          # deployed sha, queued changes, lock holder
#        infra/scripts/deploy-train.sh go [--force]    # deploy origin/main if >= DEPLOY_TRAIN_MIN queued (or --force)
# Always deploys origin/main from a dedicated worktree (.claude/worktrees/deploy-staging), never the caller's HEAD.
# A "change" is a non-merge commit touching anything besides docs/ or *.md. Lock and state live in the
# shared git dir, so every worktree on this Mac sees them.
set -euo pipefail

MIN="${DEPLOY_TRAIN_MIN:-3}"
MAX="${DEPLOY_TRAIN_MAX:-5}"
REGION=us-east-2
CLUSTER=eureka-staging
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
REPO="$(dirname "$COMMON")"
LOCK="$COMMON/deploy-staging.lock"
LAST="$COMMON/deploy-staging.last" # sha of the last train, read by scripts/session-brief.sh
LOG="$COMMON/deploy-staging.log"
DEPLOY_WT="$REPO/.claude/worktrees/deploy-staging"

deployed_sha() { # image tag of the running staging api = the sha it was built from
  local td
  td=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services api \
    --query 'services[0].taskDefinition' --output text)
  aws ecs describe-task-definition --region "$REGION" --task-definition "$td" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text | sed -E 's/.*://; s/-dirty-.*//'
}

queued() { # non-doc commits on origin/main after $1, one "sha subject" per line
  local c
  for c in $(git rev-list --no-merges --reverse "$1..origin/main"); do
    git diff-tree --no-commit-id --name-only -r "$c" | grep -qvE '^docs/|\.md$' &&
      git log -1 --format='%h %s' "$c"
  done
  return 0
}

lock_holder() { # prints holder info if a live deploy holds the lock; clears a stale lock
  [ -d "$LOCK" ] || return 1
  local pid
  pid=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then cat "$LOCK/info"; return 0; fi
  rm -rf "$LOCK"; return 1
}

git fetch -q origin main
DEPLOYED=$(deployed_sha)
echo "$DEPLOYED" > "$LAST"
if ! git cat-file -e "$DEPLOYED^{commit}" 2>/dev/null; then
  echo "staging runs $DEPLOYED, unknown to git here; treating all of origin/main as queued" >&2
  DEPLOYED=$(git rev-list --max-parents=0 origin/main | tail -1)
fi
QUEUE=$(queued "$DEPLOYED")
N=$(printf '%s' "$QUEUE" | grep -c . || true)

echo "staging: ${DEPLOYED:0:9}   origin/main: $(git rev-parse --short=9 origin/main)   queued: $N (train leaves at $MIN, overdue at $MAX)"
[ -n "$QUEUE" ] && printf '%s\n' "$QUEUE" | sed 's/^/  /'
if info=$(lock_holder); then echo "deploy running: $info (log: $LOG)"; fi
pgrep -f 'deploy-local.sh' >/dev/null && ! [ -d "$LOCK" ] && echo "WARNING: deploy-local.sh running outside the train"

case "${1:-status}" in
  status) exit 0 ;;
  go) ;;
  *) echo "usage: $0 status | go [--force]" >&2; exit 2 ;;
esac

if lock_holder >/dev/null; then echo "train already running; your commits ride the next one"; exit 0; fi
if pgrep -f 'deploy-local.sh' >/dev/null; then echo "deploy-local.sh running outside the train; retry after it ends"; exit 0; fi
[ "$N" -gt 0 ] || { echo "nothing to deploy"; exit 0; }
if [ "$N" -lt "$MIN" ] && [ "${2:-}" != "--force" ]; then
  echo "only $N/$MIN queued; not deploying (commits stay queued; --force if the user asked for this now)"; exit 0
fi

mkdir "$LOCK" 2>/dev/null || { echo "lost the race for the lock; train already running"; exit 0; }
trap 'rm -rf "$LOCK"' EXIT
SHA=$(git rev-parse origin/main)
echo $$ > "$LOCK/pid"
echo "pid $$, ${SHA:0:9}, $N changes, started $(date '+%H:%M')" > "$LOCK/info"

if [ -d "$DEPLOY_WT" ]; then
  git -C "$DEPLOY_WT" checkout -q --detach --force "$SHA"
else
  git worktree add -q --detach "$DEPLOY_WT" "$SHA"
fi

echo ">> train ${SHA:0:9} with $N changes; log: $LOG"
if echo y | "$DEPLOY_WT/infra/scripts/deploy-local.sh" staging > "$LOG" 2>&1; then
  echo "$SHA" > "$LAST"
  echo "OK: staging now at ${SHA:0:9}"
  tail -2 "$LOG"
else
  echo "FAILED: see $LOG" >&2
  grep -E 'Error|error:|FAIL' "$LOG" | tail -8 >&2 || tail -15 "$LOG" >&2
  exit 1
fi
