#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
DC="docker compose"
T="$DC run --rm tools"
cmd="${1:-help}"; shift || true

# Drops (if present) and recreates $1 as an empty DB owned by agrotrace_owner,
# with role grants applied (ALTER DEFAULT PRIVILEGES/GRANT CONNECT are per-database).
recreate_db() {
  local dbname="$1"
  $DC exec -T postgres psql -U agrotrace_owner -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${dbname} WITH (FORCE);"
  $DC exec -T postgres psql -U agrotrace_owner -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${dbname} OWNER agrotrace_owner;"
  $DC exec -T postgres psql -U agrotrace_owner -d "${dbname}" -v ON_ERROR_STOP=1 -f //docker-entrypoint-initdb.d/01-roles.sql
}

# schema.sql must reflect exactly what the migration files produce — never the
# long-lived dev DB, whose extensions/state can drift from the migrations (e.g.
# an extension a migration stopped creating but that stayed installed there).
# So this builds a throwaway DB from scratch, migrates it, dumps it with PG16's
# own pg_dump (bundled with the postgres:16-alpine image, unlike dbmate's image
# which bundles pg_dump 18 — output PG16 cannot load back), strips the
# \restrict/\unrestrict guard meta-commands (present even in recent PG16 point
# releases) and any transaction_timeout SET line, then re-appends dbmate's own
# footer (in the exact format `dbmate load` expects) so the file stays usable
# with dbmate.
#
# Runs in its own subshell so `set -e`/`trap` are scoped to this function only:
# any failure (or success) drops the throwaway DB and removes the staging file
# via the EXIT trap, and db/schema.sql itself is only overwritten (via `mv`,
# atomic on the same filesystem) once the dump+footer are fully built in a
# temp file — a mid-step failure never truncates or corrupts the committed file.
dump_schema() (
  set -euo pipefail
  set -a; . ./.env; set +a
  ddb="agrotrace_schema_dump"
  url="${DATABASE_URL%/*}/${ddb}?sslmode=disable"
  tmp="$(mktemp db/.schema.sql.XXXXXX)"

  cleanup() {
    $DC exec -T postgres psql -U agrotrace_owner -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS ${ddb} WITH (FORCE);" >/dev/null 2>&1 || true
    rm -f "$tmp"
  }
  trap cleanup EXIT

  recreate_db "$ddb"
  $DC run --rm dbmate --url "$url" --no-dump-schema --wait up

  $DC exec -T postgres pg_dump -U agrotrace_owner --schema-only --no-owner "${ddb}" \
    | grep -vF '\restrict' \
    | grep -vF '\unrestrict' \
    | grep -v '^SET transaction_timeout' \
    > "$tmp"

  {
    echo
    echo "--"
    echo "-- Dbmate schema migrations"
    echo "--"
    echo
    echo "INSERT INTO public.schema_migrations (version) VALUES"
    versions=($($DC exec -T postgres psql -tA -U agrotrace_owner -d "${ddb}" \
      -c "SELECT version FROM public.schema_migrations ORDER BY version;" | tr -d '\r'))
    n=${#versions[@]}
    for i in "${!versions[@]}"; do
      if [ "$i" -eq $((n - 1)) ]; then
        echo "    ('${versions[$i]}');"
      else
        echo "    ('${versions[$i]}'),"
      fi
    done
  } >> "$tmp"

  mv "$tmp" db/schema.sql
)

# Brings up the gwtest-profile stub upstream (network alias api-express; zero real backends
# otherwise), greps the gateway's actual loaded config (`nginx -T`) for the SSE location's
# directives and for the absence of `proxy_intercept_errors` (fix round 1: that directive rewrote
# real backend error responses into the gateway's own problem+json instead of passing them
# through), then runs the full tests/gateway suite. The stub is always torn down afterwards, pass
# or fail, so it never lingers or collides with a later plan's real api-express service.
gw_test() (
  set -euo pipefail
  cleanup() { $DC --profile gwtest rm -sf gateway-test-upstream >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  $DC --profile gwtest up -d --wait gateway-test-upstream

  full="$($DC exec -T gateway nginx -T 2>/dev/null)"
  echo "$full" | grep -q 'proxy_intercept_errors on;' \
    && { echo "gw:test: proxy_intercept_errors must not appear anywhere in the gateway config (it rewrites real backend error responses)"; exit 1; }

  sse="$(echo "$full" | awk '/location \/api\/v1\/events\//,/^    \}/')"
  echo "$sse" | grep -q 'proxy_buffering off;'      || { echo "gw:test: proxy_buffering off missing on /api/v1/events/"; exit 1; }
  echo "$sse" | grep -q 'proxy_read_timeout 1h;'     || { echo "gw:test: proxy_read_timeout 1h missing on /api/v1/events/"; exit 1; }
  echo "$sse" | grep -q 'proxy_cache off;'           || { echo "gw:test: proxy_cache off missing on /api/v1/events/"; exit 1; }
  echo "gw:test: SSE location config OK; proxy_intercept_errors correctly absent"

  $T pnpm --filter @agrotrace/tests-gateway test
)

# Number of migrations applied to the dev DB (0 when schema_migrations does not exist).
applied_migrations() {
  local q="$DC exec -T postgres psql -tA -v ON_ERROR_STOP=1 -U agrotrace_owner -d agrotrace -c"
  if [ "$($q "SELECT to_regclass('public.schema_migrations') IS NOT NULL" | tr -d '\r')" = "t" ]; then
    $q "SELECT count(*) FROM schema_migrations" | tr -d '\r'
  else
    echo 0
  fi
}

case "$cmd" in
  install)   $T pnpm install "$@" ;;
  sh)        $T bash ;;
  pnpm)      $T pnpm "$@" ;;
  # Unit tests of every workspace package outside tests/* (db/seed runs its unit suite only). The
  # tests/* packages need live services and run only through their own commands (R83): db:test,
  # gw:test, ds:test — `test:all` runs everything in order.
  test)      $T pnpm -r --workspace-concurrency=1 --filter '!./tests/**' test "$@" ;;
  # Everything, in dependency order: unit → tests/db (throwaway agrotrace_test) → dev DB migrated and
  # seed checked → gateway up + gw:test → design-system showcase (Playwright).
  test:all)
    "$0" test
    "$0" up infra
    "$0" db:test
    "$0" db:migrate
    "$0" seed:test
    "$0" up gateway
    "$0" gw:test
    "$0" ds:test ;;
  # ESLint's flat config (eslint.config.js) already covers the whole repo tree in one pass — `-r`
  # would instead run per-workspace-package `lint` scripts, none of which exist (only the root
  # package.json has one), so recursing here silently lints nothing.
  lint)      $T pnpm lint ;;
  typecheck) $T pnpm -r typecheck ;;
  fmt)       $T pnpm exec prettier --write . ;;
  # --build on every `up` (R80): a stale gateway/mercury-mock image is never silently reused —
  # docker compose skips the build step on its own for any service without a `build:` key, so this
  # is a no-op for postgres/redis/rabbitmq/minio/mailpit.
  up)
    case "${1:-all}" in
      infra)   $DC up -d --build --wait postgres redis rabbitmq minio mailpit && $DC up --build minio-init ;;
      gateway)
        $DC up -d --build --wait gateway
        set -a; . ./.env; set +a
        echo "Gateway up: http://localhost:${GATEWAY_PORT:-80}/  (design system: http://localhost:${GATEWAY_PORT:-80}/_ds/)" ;;
      *) $DC up -d --build --wait ;;
    esac ;;
  down)        $DC down "$@" ;;
  db:migrate)  $DC run --rm dbmate --no-dump-schema --wait up && dump_schema ;;
  # schema.sql always represents ALL migrations on disk (dump_schema builds it
  # from a throwaway DB that replays every migration, regardless of dev DB
  # state) — a rollback moves the dev DB backward, not schema.sql, so it must
  # not regenerate a file that would come out byte-identical to db:migrate's
  # anyway; only db:migrate does.
  db:rollback) $DC run --rm dbmate --no-dump-schema rollback ;;
  db:new)      $DC run --rm dbmate new "$1" ;;
  db:test)
    set -a; . ./.env; set +a
    TDB=agrotrace_test
    TEST_DATABASE_URL="${DATABASE_URL%/*}/${TDB}?sslmode=disable"
    TEST_APP_DATABASE_URL="${APP_DATABASE_URL%/*}/${TDB}"
    $DC up -d --wait postgres
    recreate_db "$TDB"
    $DC run --rm dbmate --url "$TEST_DATABASE_URL" --no-dump-schema --wait up
    $DC run --rm -e DATABASE_URL="$TEST_DATABASE_URL" -e APP_DATABASE_URL="$TEST_APP_DATABASE_URL" tools \
      pnpm --filter @agrotrace/tests-db test ;;
  ds:test)     $DC run --rm playwright npx --no-install playwright test "$@" ;;
  # Gateway must already be up (./at.sh up gateway). See gw_test() above for what this checks.
  gw:test)     gw_test ;;
  psql)        $DC exec postgres psql -U agrotrace_owner agrotrace ;;
  check)
    $DC exec -T postgres pg_isready -U agrotrace_owner && \
    $DC exec -T redis redis-cli ping && \
    $DC exec -T rabbitmq rabbitmq-diagnostics -q check_running && \
    $T sh -c 'curl -fsS http://minio:9000/minio/health/live && curl -fsS http://mailpit:8025/livez' && echo "infra ok" ;;
  # Demo data (db/seed): replaces all data of the dev DB (except roles, regions, schema_migrations),
  # its MinIO objects and Redis, and regenerates docs/demo-accounts.md. Timestamps end at SEED_NOW
  # (env, ISO minute; default: now). Idempotent for the same SEED_NOW.
  seed)        $DC run --rm -e SEED_NOW -e SEED_ALLOW_DB tools pnpm --filter @agrotrace/seed seed ;;
  # Seeds (SEED_NOW pinned for the run), checks the dev DB + MinIO, seeds again and compares.
  seed:test)   $DC run --rm -e SEED_NOW -e SEED_ALLOW_DB tools pnpm --filter @agrotrace/seed test:db "$@" ;;
  # Rolls the dev DB back to zero migrations, migrates up again and seeds.
  reset)
    $DC up -d --wait postgres
    while [ "$(applied_migrations)" != "0" ]; do
      $DC run --rm dbmate --no-dump-schema rollback
    done
    $DC run --rm dbmate --no-dump-schema --wait up
    $DC run --rm -e SEED_NOW -e SEED_ALLOW_DB tools pnpm --filter @agrotrace/seed seed ;;
  help|*)  grep -E '^\s+[a-z:-]+\)' "$0" | sed 's/).*//' | tr -d ' ' ;;
esac
