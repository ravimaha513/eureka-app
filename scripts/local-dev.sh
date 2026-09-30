#!/usr/bin/env bash
# Run Eureka locally with fictional data: Postgres (Docker), API and web app.
#   ./scripts/local-dev.sh          start (seeds on first run)
#   ./scripts/local-dev.sh --reset  wipe the local database first
# Needs Node 22+, Docker Desktop. Open http://localhost:5173 and pick a fictional user.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_URL="${EUREKA_ADMIN_URL:-postgres://postgres:postgres@127.0.0.1:55432/eureka}"
APP_PASSWORD="eureka_local"
API_PORT="${API_PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 22 ] || die "Node 22+ is required (found: $(node -v 2>/dev/null || echo none)). Try: nvm install 22 && nvm use 22"
command -v pnpm >/dev/null || { say "Enabling pnpm via corepack"; corepack enable; }

if [ -z "${EUREKA_ADMIN_URL:-}" ]; then
  command -v docker >/dev/null || die "Docker is required for the local database (or set EUREKA_ADMIN_URL to an existing Postgres 16)."
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop and retry."
  if [ "${1:-}" = "--reset" ]; then say "Resetting the local database"; docker compose down -v; fi
  say "Starting Postgres 16 (docker compose)"
  docker compose up -d --wait db
fi

for p in "$API_PORT" "$WEB_PORT"; do
  if command -v lsof >/dev/null && lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then die "Port $p is in use. Stop that process or set API_PORT / WEB_PORT."; fi
done

say "Installing dependencies"
pnpm install --frozen-lockfile

say "Applying migrations and seeding fictional data"
MIGRATION_DATABASE_URL="$ADMIN_URL" APP_DB_PASSWORD="$APP_PASSWORD" \
  pnpm --filter @eureka/api exec tsx src/db/seed-dev.ts

# Same host/database as the admin URL, but as the least-privilege API role.
APP_URL="postgres://eureka_app:${APP_PASSWORD}@${ADMIN_URL#*@}"

pids=()
cleanup() { say "Stopping"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

say "Starting API on http://localhost:$API_PORT"
( cd apps/api && NODE_ENV=development AUTH_MODE=dev SESSION_SECRET="local-dev-session-secret-local-dev-session" \
    DATABASE_URL="$APP_URL" PORT="$API_PORT" pnpm dev ) &
pids+=($!)

for _ in $(seq 1 60); do curl -fsS "http://localhost:$API_PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://localhost:$API_PORT/api/health" >/dev/null || die "API did not start; see the output above."

say "Starting web app on http://localhost:$WEB_PORT"
( cd apps/web && API_PORT="$API_PORT" pnpm exec vite --port "$WEB_PORT" --strictPort ) &
pids+=($!)

sleep 3
say "Ready: http://localhost:$WEB_PORT  (pick a fictional user; Ctrl-C to stop)"
if command -v open >/dev/null; then open "http://localhost:$WEB_PORT"; fi
wait
