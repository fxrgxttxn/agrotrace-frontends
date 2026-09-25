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

  # R88 M1: the access log never records the query string (signed-URL `sig`/`exp`, SSE access_token).
  logfmt="$(echo "$full" | awk '/log_format main/,/;/')"
  echo "$logfmt" | grep -q '"$request_method $uri $server_protocol"' \
    || { echo "gw:test: log_format main must log \$request_method \$uri \$server_protocol"; exit 1; }
  echo "$logfmt" | grep -qE '\$request"|\$request_uri|\$args|\$query_string' \
    && { echo "gw:test: log_format main must not log the query string"; exit 1; }
  probe="at-log-probe-$RANDOM$RANDOM"
  $T sh -c "curl -s -o /dev/null 'http://gateway/_ds/?sig=${probe}&access_token=${probe}'"
  sleep 1
  $DC logs --since 2m gateway 2>&1 | grep -q "GET /_ds/ HTTP" \
    || { echo "gw:test: access log line for the probe request not found"; exit 1; }
  $DC logs --since 2m gateway 2>&1 | grep -q "$probe" \
    && { echo "gw:test: the query string of a request leaked into the gateway log"; exit 1; }
  echo "gw:test: access log has no query strings"

  # R92: nor does the error log. nginx's error-log lines carry `request: "GET /path?query …"` and their format is
  # not configurable, so the level is `crit`: an unreachable backend (react-laravel: no api-laravel container)
  # logs at `error` and must leave no trace of the query string.
  echo "$full" | grep -qE '^\s*error_log\s+\S+\s+crit;' \
    || { echo "gw:test: error_log must be at level crit (its lines include the request line with the query)"; exit 1; }
  eprobe="at-err-probe-$RANDOM$RANDOM"
  $T sh -c "curl -s -o /dev/null -H 'Host: react-laravel.localhost' 'http://gateway/api/v1/health/live?sig=${eprobe}&access_token=${eprobe}'"
  sleep 1
  $DC logs --since 2m gateway 2>&1 | grep -q "$eprobe" \
    && { echo "gw:test: the query string of a failed proxied request leaked into the gateway error log"; exit 1; }
  echo "gw:test: error log has no query strings"

  $T pnpm --filter @agrotrace/tests-gateway test
)

INFRA_SERVICES="postgres redis rabbitmq minio mailpit mercury-mock"

# AT_DRY_RUN=1 prints the docker commands of `up` instead of running them (tests/at).
run() {
  if [ "${AT_DRY_RUN:-}" = "1" ]; then echo "+ $*"; else "$@"; fi
}

# Services of one backend implementation (spec §14.4).
backend_services() {
  case "$1" in
    express) echo "api-express worker-express" ;;
    django)  echo "api-django worker-django beat-django" ;;
    laravel) echo "api-laravel worker-laravel scheduler-laravel" ;;
    *) return 1 ;;
  esac
}

# `./at up <front> <back>`: one frontend×backend combination (spec §14.4).
up_combo() (
  set -euo pipefail
  front="$1"; back="${2:-}"
  services="$(backend_services "$back")" || {
    echo "usage: ./at up <react|angular|svelte> <express|django|laravel>" >&2; exit 2; }
  if [ "${AT_DRY_RUN:-}" != "1" ]; then
    defined="$($DC config --services)"
    missing=""
    for s in $services; do echo "$defined" | grep -qx "$s" || missing="$missing $s"; done
    if [ -n "$missing" ]; then
      echo "up $front $back: service(s)$missing are not in docker-compose.yml yet — the $back backend plan adds them." >&2
      exit 1
    fi
  fi
  run $DC up -d --build --wait $INFRA_SERVICES
  run $DC up --build minio-init
  run $DC up -d --build --wait $services gateway
  port="$( (set -a; . ./.env; echo "${GATEWAY_PORT:-80}") )"
  echo "$front + $back: http://${front}-${back}.localhost:${port}/"
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
  # The command wrappers (at, at.sh, at.cmd, at.ps1; `up` in AT_DRY_RUN mode) — tests/at.
  at:test)   $T pnpm --filter @agrotrace/tests-at test "$@" ;;
  # Everything, in dependency order: unit → wrappers → tests/db (throwaway agrotrace_test) → dev DB migrated and
  # seed checked → gateway up + gw:test → design-system showcase (Playwright).
  test:all)
    "$0" test
    "$0" at:test
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
  # `up <front> <back>` (R88 M6, spec §14.4): infra + the backend's services + the gateway; the
  # frontend is static and served by the gateway at http://<front>-<back>.localhost:<GATEWAY_PORT>/.
  up)
    case "${1:-all}" in
      infra)   run $DC up -d --build --wait $INFRA_SERVICES && run $DC up --build minio-init ;;
      gateway)
        run $DC up -d --build --wait gateway
        set -a; . ./.env; set +a
        echo "Gateway up: http://localhost:${GATEWAY_PORT:-80}/  (design system: http://localhost:${GATEWAY_PORT:-80}/_ds/)" ;;
      react|angular|svelte) up_combo "$@" ;;
      all) run $DC up -d --build --wait ;;
      *) echo "usage: ./at up [all|infra|gateway|<react|angular|svelte> <express|django|laravel>]" >&2; exit 2 ;;
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
    $T sh -c 'curl -fsS http://minio:9000/minio/health/live && curl -fsS http://mailpit:8025/livez && curl -fsS http://mercury-mock:8080/health' && echo "infra ok" ;;
  # Demo data (db/seed): replaces all data of the dev DB (except roles, regions, schema_migrations),
  # its MinIO objects and Redis. Timestamps end at SEED_NOW (env, ISO minute; default: now).
  # Idempotent for the same SEED_NOW. Never writes tracked files (R86).
  seed)        $DC run --rm -e SEED_NOW -e SEED_ALLOW_DB tools pnpm --filter @agrotrace/seed seed ;;
  # Regenerates docs/demo-accounts.md from the demo story at REFERENCE_NOW (no database needed, R86).
  seed:docs)   $T pnpm --filter @agrotrace/seed docs ;;
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
  # Top-level commands only (two-space indented case labels).
  help|*)  grep -E '^  [a-z:-]+\)' "$0" | sed 's/).*//' | tr -d ' ' ;;
esac
