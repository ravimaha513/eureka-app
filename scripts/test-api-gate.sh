#!/usr/bin/env bash
# Runs the API suite under a machine-wide limit, so parallel sessions queue instead of stacking forks
# on one Postgres. Full runs go one at a time; runs with a file filter share TEST_GATE_SLOTS slots.
# Locks live in the shared git dir, so every worktree sees them. CI runs alone and skips the gate.
# Usage (from apps/api, via `pnpm test`): test-api-gate.sh [vitest args]. TEST_MAX_FORKS still overrides.
set -u

[ -n "${CI:-}" ] && exec vitest run "$@"

COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd)
GATE="$COMMON/test-api-gate"
mkdir -p "$GATE"

targeted=
for arg in "$@"; do
  case "$arg" in -*) ;; *) targeted=1 ;; esac
done

if [ -n "$targeted" ]; then
  slots=$(seq 1 "${TEST_GATE_SLOTS:-3}" | sed 's/^/targeted-/')
  export TEST_MAX_FORKS="${TEST_MAX_FORKS:-2}"
else
  slots=full
  export TEST_MAX_FORKS="${TEST_MAX_FORKS:-6}"
fi

# A slot whose owner died is cleared here. Two waiters racing on that can at worst let one extra run through.
clear_if_stale() {
  local pid
  pid=$(cat "$1/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$1"; fi
}

held=
release() { [ -n "$held" ] && rm -rf "$held"; held=; }
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

announced=
while [ -z "$held" ]; do
  for slot in $slots; do
    clear_if_stale "$GATE/$slot"
    if mkdir "$GATE/$slot" 2>/dev/null; then
      held="$GATE/$slot"
      echo $$ > "$held/pid"
      echo "pid $$ in $PWD since $(date '+%H:%M')" > "$held/info"
      break
    fi
  done
  if [ -z "$held" ]; then
    if [ -z "$announced" ]; then
      echo "test gate: waiting for a free slot, held by:"
      cat "$GATE"/*/info 2>/dev/null | sed 's/^/  /'
      announced=1
    fi
    sleep 3
  fi
done

# Not exec: the trap above has to release the slot when vitest exits.
vitest run "$@"
