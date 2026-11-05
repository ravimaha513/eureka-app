#!/usr/bin/env bash
# Get a checkout ready for work without starting any servers: deps, local
# Postgres, migrations, fictional seed. Idempotent; safe to run every session
# (e.g. from the cloud environment setup script). `pnpm local` calls it first.
#   ./scripts/dev-up.sh           prepare (skips whatever is already done)
#   ./scripts/dev-up.sh --reset   wipe the local dev database first (only when asked)
# EUREKA_ADMIN_URL=postgres://... uses an existing Postgres 16 instead of Docker.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_URL="${EUREKA_ADMIN_URL:-postgres://postgres:postgres@127.0.0.1:55432/eureka}"
APP_PASSWORD="${APP_DB_PASSWORD:-eureka_local}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 22 ] || die "Node 22+ is required (found: $(node -v 2>/dev/null || echo none)). Try: nvm install 22 && nvm use 22"
command -v pnpm >/dev/null || { say "Enabling pnpm via corepack"; corepack enable; }

# Dependencies: reinstall only when the lockfile changed since the last install.
stamp=node_modules/.dev-up-lock-hash
lock_hash=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
if [ "$(cat "$stamp" 2>/dev/null)" != "$lock_hash" ]; then
  say "Installing dependencies"
  pnpm install --frozen-lockfile
  echo "$lock_hash" > "$stamp"
else
  say "Dependencies up to date"
fi

# Native Postgres 16 on :55432 when Docker is not running (e.g. cloud
# containers: Docker CLI but no daemon). Same credentials as docker-compose.yml.
native_pg() {
  local bin data run=()
  bin=$(ls -d /usr/lib/postgresql/16/bin 2>/dev/null || pg_config --bindir 2>/dev/null) || die "No Docker daemon and no Postgres 16 server binaries (apt install postgresql-16), or set EUREKA_ADMIN_URL."
  [ -x "$bin/pg_ctl" ] || die "No Docker daemon and no pg_ctl in $bin, or set EUREKA_ADMIN_URL."
  if [ "$(id -u)" = 0 ]; then
    data=/var/lib/postgresql/eureka-dev; run=(runuser -u postgres --)   # postgres refuses to run as root
  else
    data="$PWD/.pgdata"
  fi
  if [ "${1:-}" = "--reset" ] && [ -d "$data" ]; then
    say "Resetting the local database"
    "${run[@]}" "$bin/pg_ctl" -D "$data" -m fast stop >/dev/null 2>&1 || true
    rm -rf "$data"
  fi
  if [ ! -s "$data/PG_VERSION" ]; then
    say "Initialising native Postgres 16 in $data"
    local pw; pw=$(mktemp); echo postgres > "$pw"; chmod 644 "$pw"
    mkdir -p "$data"; [ ${#run[@]} -eq 0 ] || chown postgres: "$data"
    "${run[@]}" "$bin/initdb" -D "$data" -U postgres --pwfile="$pw" --auth=scram-sha-256 -E UTF8 >/dev/null
    rm -f "$pw"
  fi
  if ! "${run[@]}" "$bin/pg_ctl" -D "$data" status >/dev/null 2>&1; then
    say "Starting native Postgres 16 on 127.0.0.1:55432"
    "${run[@]}" "$bin/pg_ctl" -D "$data" -l "$data/server.log" -w \
      -o "-p 55432 -c listen_addresses=127.0.0.1 -k /tmp" start >/dev/null
  else
    say "Native Postgres already running"
  fi
  PGPASSWORD=postgres psql -h 127.0.0.1 -p 55432 -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='eureka'" | grep -q 1 \
    || PGPASSWORD=postgres psql -h 127.0.0.1 -p 55432 -U postgres -qc "CREATE DATABASE eureka"
}

if [ -z "${EUREKA_ADMIN_URL:-}" ]; then
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    if [ "${1:-}" = "--reset" ]; then say "Resetting the local database"; docker compose down -v; fi
    say "Starting Postgres 16 (docker compose)"
    docker compose up -d --wait db
  else
    native_pg "$@"
  fi
fi

# migrate() skips applied migrations; seed-dev skips fixtures once users exist.
say "Applying migrations and seeding fictional data (skips what is done)"
MIGRATION_DATABASE_URL="$ADMIN_URL" APP_DB_PASSWORD="$APP_PASSWORD" WORKER_DB_PASSWORD="$APP_PASSWORD" \
  pnpm --filter @eureka/api exec tsx src/db/seed-dev.ts

say "Dev environment ready (database: ${ADMIN_URL#*@})"
