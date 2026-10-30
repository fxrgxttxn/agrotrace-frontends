#!/usr/bin/env bash
# Merge convention (SP3): per-backend code goes only inside `# --- <backend> (plan N) ---` … `# --- end <backend> ---`.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
DC="docker compose"
T="$DC run --rm tools"
cmd="${1:-help}"; shift || true

# ── Shared-stand mutex ──────────────────────────────────────────────────────────────────────────────────────────────
# Several git worktrees (parallel backend ports) share ONE docker stand: one postgres/redis/rabbitmq/minio and the
# agrotrace-* containers. Commands that reset/seed/migrate the shared DB or recreate backend containers with test
# profiles take a host-level lock first; others wait ("waiting for <owner>" every AT_LOCK_NOTICE s, AT_LOCK_TIMEOUT s
# limit, default 90 min). Lock = directory, created with mkdir (atomic), at
#   AT_LOCK_DIR, else <main repo git common dir>/agrotrace-stand.lock (identical from every worktree of the clone),
#   else ${TMPDIR:-/tmp}/agrotrace-stand.lock (no git).
# It lives on the HOST: at.sh runs on the host (it drives `docker compose`); the tools container only runs
# tests/at, which sets AT_LOCK_DIR itself. In AT_DRY_RUN=1 the lock is skipped unless AT_LOCK_DIR is set.
# AT_NO_LOCK=1 bypasses. Nested at.sh calls of a locked command see AT_LOCK_HELD=<token> and do not re-lock.
# A lock whose recorded PID is gone on this host is taken over with a warning.
lock_dir() {
  if [ -n "${AT_LOCK_DIR:-}" ]; then echo "$AT_LOCK_DIR"; return; fi
  local g
  if g="$(git rev-parse --git-common-dir 2>/dev/null)" && g="$(cd "$g" 2>/dev/null && pwd)"; then
    echo "$g/agrotrace-stand.lock"
  else
    echo "${TMPDIR:-/tmp}/agrotrace-stand.lock"
  fi
}

lock_field() { { sed -n "s/^$1=//p" "$2/owner" 2>/dev/null || true; } | head -n1; }

lock_owner_desc() {
  echo "$(lock_field cmd "$1") in $(lock_field worktree "$1") (pid $(lock_field pid "$1"), since $(lock_field started "$1"))"
}

lock_release() {
  [ -n "${AT_LOCK_MINE:-}" ] || return 0
  if [ "$(lock_field token "$AT_LOCK_MINE_DIR")" = "$AT_LOCK_MINE" ]; then rm -rf "$AT_LOCK_MINE_DIR"; fi
  AT_LOCK_MINE=""
}

# lock_acquire <description>
lock_acquire() {
  [ "${AT_NO_LOCK:-}" = "1" ] && return 0
  if [ "${AT_DRY_RUN:-}" = "1" ] && [ -z "${AT_LOCK_DIR:-}" ]; then return 0; fi
  local dir; dir="$(lock_dir)"
  if [ -n "${AT_LOCK_HELD:-}" ] && [ "$(lock_field token "$dir")" = "$AT_LOCK_HELD" ]; then return 0; fi
  local timeout="${AT_LOCK_TIMEOUT:-5400}" notice="${AT_LOCK_NOTICE:-30}" poll="${AT_LOCK_POLL:-1}"
  local start=$SECONDS last=$((SECONDS - notice)) pid host mine_host grace=0
  mine_host="$(hostname 2>/dev/null || echo host)"
  while :; do
    if mkdir "$dir" 2>/dev/null; then
      local token="$$-$(date +%s)-$RANDOM"
      {
        echo "token=$token"; echo "pid=$$"; echo "host=$mine_host"; echo "worktree=$PWD"
        echo "cmd=$1"; echo "started=$(date '+%Y-%m-%d %H:%M:%S')"
      } > "$dir/owner"
      AT_LOCK_MINE="$token"; AT_LOCK_MINE_DIR="$dir"
      export AT_LOCK_HELD="$token"
      trap lock_release EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM
      return 0
    fi
    pid="$(lock_field pid "$dir")"; host="$(lock_field host "$dir")"
    if [ -z "$pid" ]; then
      # Owner file not written yet (or the lock is broken): give the creator a few polls, then take over.
      grace=$((grace + 1))
      if [ "$grace" -gt 20 ] && [ ! -f "$dir/owner" ]; then pid=0; host="$mine_host"; fi
    fi
    if [ -n "$pid" ] && [ "$host" = "$mine_host" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "at: stale stand lock (pid $pid gone: $(lock_owner_desc "$dir")) — taking over" >&2
      # rename first: of several waiters only one wins the rename
      if mv "$dir" "$dir.stale.$$" 2>/dev/null; then rm -rf "$dir.stale.$$"; fi
      continue
    fi
    if [ $((SECONDS - start)) -ge "$timeout" ]; then
      echo "at: timed out after ${timeout}s waiting for the shared stand, held by $(lock_owner_desc "$dir") (lock: $dir; AT_NO_LOCK=1 bypasses)" >&2
      exit 75
    fi
    if [ $((SECONDS - last)) -ge "$notice" ]; then
      echo "at: waiting for $(lock_owner_desc "$dir") [$((SECONDS - start))s, limit ${timeout}s]" >&2
      last=$SECONDS
    fi
    sleep "$poll"
  done
}

# Drops (if present) and recreates $1 as an empty DB owned by agrotrace_owner,
# with role grants applied (ALTER DEFAULT PRIVILEGES/GRANT CONNECT are per-database).
recreate_db() {
  local dbname="$1"
  $DC exec -T postgres psql -U agrotrace_owner -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${dbname} WITH (FORCE);"
  $DC exec -T postgres psql -U agrotrace_owner -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${dbname} OWNER agrotrace_owner;"
  $DC exec -T postgres psql -U agrotrace_owner -d "${dbname}" -v ON_ERROR_STOP=1 -f //docker-entrypoint-initdb.d/01-roles.sql
}

# SP2: the unit-test DB of one backend port — agrotrace_test_django (django:test) or agrotrace_test_laravel
# (laravel:test); agrotrace_test stays tests/db's and gen:db-types' (recreated by them). Creates the DB when it is
# missing (owned by agrotrace_owner, the re-runnable role grants of 01-roles.sql applied every time) and migrates it
# with dbmate from db/migrations — the same migrations as every other DB. Never drops it: a port's suite cleans up
# its own rows. Runs under the stand lock (django:test and laravel:test are in the lock list). Exports, for the
# backend's hook: TEST_DATABASE_URL (owner, ?sslmode=disable) and TEST_APP_DATABASE_URL (agrotrace_app) of that DB.
TEST_DBS="agrotrace_test_django agrotrace_test_laravel"
prepare_test_db() {
  local db="$1" psql="$DC exec -T postgres psql -U agrotrace_owner -v ON_ERROR_STOP=1"
  case " $TEST_DBS " in
    *" $db "*) ;;
    *) echo "prepare_test_db: '$db' is not a per-backend test DB ($TEST_DBS)" >&2; return 2 ;;
  esac
  set -a; . ./.env; set +a
  export TEST_DATABASE_URL="${DATABASE_URL%/*}/${db}?sslmode=disable"
  export TEST_APP_DATABASE_URL="${APP_DATABASE_URL%/*}/${db}"
  run $DC up -d $NO_RECREATE --wait postgres
  if [ "${AT_DRY_RUN:-}" = "1" ] \
    || [ "$($psql -d postgres -tA -c "SELECT 1 FROM pg_database WHERE datname = '${db}'" | tr -d '\r')" != "1" ]; then
    run $psql -d postgres -c "CREATE DATABASE ${db} OWNER agrotrace_owner;"
  fi
  run $psql -d "$db" -f //docker-entrypoint-initdb.d/01-roles.sql
  run $DC run --rm --no-deps dbmate --url "$TEST_DATABASE_URL" --no-dump-schema --wait up
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
  $DC run --rm --no-deps dbmate --url "$url" --no-dump-schema --wait up

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
# or fail, so it never lingers. A running real api-express (Plan 1) would share the name with the stub (Docker DNS
# round-robin), so it is stopped for the run and started again afterwards.
gw_test() (
  set -euo pipefail
  had_api=0
  if [ -n "$($DC ps -q --status running api-express 2>/dev/null)" ]; then had_api=1; $DC stop api-express >/dev/null; fi
  cleanup() {
    $DC --profile gwtest rm -sf gateway-test-upstream >/dev/null 2>&1 || true
    if [ "$had_api" = "1" ]; then $DC start api-express >/dev/null 2>&1 || true; fi
  }
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
# postgres and rabbitmq bind-mount files of the checkout, so from another worktree their config hash differs and a
# plain `up` recreates them, dropping every backend's connections. They are only created when missing;
# AT_RECREATE=1 recreates them to apply a changed infra/postgres/init or infra/rabbitmq file.
INFRA_BOUND="postgres rabbitmq"
INFRA_REST="redis minio mailpit mercury-mock"
NO_RECREATE="--no-recreate"
[ "${AT_RECREATE:-}" = "1" ] && NO_RECREATE=""
infra_up() {
  run $DC up -d $NO_RECREATE --wait $INFRA_BOUND && run $DC up -d --build --wait $INFRA_REST
}

# AT_DRY_RUN=1 prints the docker commands of `up` instead of running them (tests/at).
run() {
  if [ "${AT_DRY_RUN:-}" = "1" ]; then echo "+ $*"; else "$@"; fi
}

# Services of one backend implementation (spec §14.4).
backend_services() {
  case "$1" in
    express) echo "api-express worker-express scheduler-express" ;;
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
  infra_up
  run $DC up --build minio-init
  run $DC up -d --build --no-deps --wait $services gateway
  port="$( (set -a; . ./.env; echo "${GATEWAY_PORT:-80}") )"
  echo "$front + $back: http://${front}-${back}.localhost:${port}/"
)

# `./at up all`: the 3×3 matrix (spec §14.4) — infra (postgres/rabbitmq never recreated), the three production
# front builds (skipped with AT_SKIP_FE_BUILD=1), the nine backend services and the gateway with --no-deps.
up_all() (
  set -euo pipefail
  infra_up
  run $DC up --build minio-init
  if [ "${AT_SKIP_FE_BUILD:-}" != "1" ]; then
    for f in react angular svelte; do run $T pnpm --filter "@agrotrace/frontend-$f" build; done
  fi
  run $DC up -d --build --no-deps --wait $(backend_services express) $(backend_services django)     $(backend_services laravel) gateway
  port="$( (set -a; . ./.env; echo "${GATEWAY_PORT:-80}") )"
  for b in express django laravel; do for f in react angular svelte; do
    echo "http://${f}-${b}.localhost:${port}/"
  done; done
)

# `./at up <back>`: infra + one backend's services (api, worker, scheduler), no gateway.
up_backend() (
  set -euo pipefail
  back="$1"
  services="$(backend_services "$back")"
  infra_up
  run $DC up --build minio-init
  run $DC up -d --build --no-deps --wait $services
  echo "$back up: http://api-${back}:8000/api/v1 inside the \`at\` network (through the gateway: ./at up <front> $back)"
)

# SP1: while tests run against one backend (or a cross pair), the scheduler processes of every OTHER implementation
# are stopped — their ticks (lab-escalation, recall-task-overdue, notification-delivery) act on the shared DB and would
# write audit/outbox/notification rows with their own `backend`, which tests/api asserts (API_BACKEND). The containers
# are found by docker label (compose project `agrotrace` + compose service), never by compose service name, so this
# works from a worktree whose compose file does not define them. The caller's EXIT trap starts them again
# (wake_schedulers, best effort). Dry run (tests/at): AT_DRY_SCHEDULERS lists the scheduler services to treat as running.
AT_PROJECT=agrotrace
scheduler_service() { case "$1" in django) echo beat-django ;; *) echo "scheduler-$1" ;; esac; }
QUIETED=""
# quiet_schedulers <backend…>: stops the running schedulers of every backend not named.
quiet_schedulers() {
  local keep=" $* " b svc names n
  QUIETED=""
  for b in express django laravel; do
    case "$keep" in *" $b "*) continue ;; esac
    svc="$(scheduler_service "$b")"
    if [ "${AT_DRY_RUN:-}" = "1" ]; then
      case " ${AT_DRY_SCHEDULERS:-} " in *" $svc "*) names="${AT_PROJECT}-${svc}-1" ;; *) names="" ;; esac
    else
      names="$(docker ps --filter "label=com.docker.compose.project=${AT_PROJECT}" \
        --filter "label=com.docker.compose.service=${svc}" --filter status=running --format '{{.Names}}' | tr -d '\r')"
    fi
    for n in $names; do
      if [ "${AT_DRY_RUN:-}" = "1" ]; then echo "+ docker stop $n"; else docker stop "$n" >/dev/null; fi
      QUIETED="$QUIETED $n"
    done
  done
  if [ -n "$QUIETED" ] && [ "${AT_DRY_RUN:-}" != "1" ]; then
    echo "at: stopped the schedulers of the other backends for this run:$QUIETED (started again on exit)" >&2
  fi
}
wake_schedulers() {
  local n
  for n in $QUIETED; do
    if [ "${AT_DRY_RUN:-}" = "1" ]; then echo "+ docker start $n"
    else docker start "$n" >/dev/null 2>&1 || echo "at: could not start $n again — start it by hand (docker start $n)" >&2; fi
  done
  QUIETED=""
}

# `./at api:test [backend] [--reset] [--ratelimits] [--tz <zone>] [vitest args…]`: tests/api (HTTP contract suite,
# shared by the three backends) against api-<backend> (default express). Starts infra and the backend's services
# first; --reset reloads the demo data (./at reset) before the run. The suite reads the dev DB read-only
# (tests/api/lib/db.ts), apart from the documented fixture writes.
# P10: by default api-<backend> runs for the suite with the api-test overrides (docker-compose.api-test.yml:
# RATE_LIMIT_OVERRIDES) and is restored to its plain configuration afterwards; the rate-limit tests (named
# `[ratelimit]`) skip themselves. --ratelimits runs only those tests (API_RATELIMITS=1 → tests/api/vitest.config.ts
# testNamePattern), against the plain backend (no overrides). The api-test profile covers all three processes (the
# scheduler ticks every second, SCHEDULER_TICK_MS); --tz <zone> runs them with TZ=<zone> (Review Focus 4: every date
# rule is UTC, so the suite must pass in any zone).
api_test() (
  set -euo pipefail
  back="express"
  case "${1:-}" in express|django|laravel) back="$1"; shift ;; esac
  reset=0
  ratelimits=0
  tz=""
  while :; do
    case "${1:-}" in
      --reset) reset=1; shift ;;
      --ratelimits) ratelimits=1; shift ;;
      --tz) tz="${2:?--tz needs a zone, e.g. Europe/Moscow}"; shift 2 ;;
      *) break ;;
    esac
  done
  up_backend "$back"
  quiet_schedulers "$back"
  trap wake_schedulers EXIT
  if [ "$reset" = "1" ]; then run "$0" reset; fi
  tests="$DC run --rm -e API_URL=http://api-${back}:8000/api/v1 -e API_BACKEND=${back}"
  if [ "$ratelimits" = "1" ]; then
    run $tests -e API_RATELIMITS=1 tools pnpm --filter @agrotrace/tests-api test "$@"
    return
  fi
  procs="$(backend_services "$back")"
  # Own processes back to the plain configuration first, then the other backends' schedulers (SP1).
  restore() { local rc=0; run $DC up -d --no-build --no-deps --wait $procs || rc=$?; wake_schedulers; return "$rc"; }
  trap restore EXIT
  # `env` makes the zone visible in a dry run (tests/at); without --tz the profile defaults TZ to UTC.
  zone=(); if [ -n "$tz" ]; then zone=(env "API_TEST_TZ=$tz"); fi
  run "${zone[@]}" $DC -f docker-compose.yml -f docker-compose.api-test.yml up -d --no-build --no-deps --wait $procs
  # A run without vitest arguments is a full run: the contract coverage gate (tests/api/contract-coverage.test.ts) must
  # then run and pass — it fails instead of skipping (review M2).
  if [ $# -eq 0 ]; then tests="$tests -e API_COVERAGE_REQUIRED=1"; fi
  run $tests tools pnpm --filter @agrotrace/tests-api test "$@"
)

# `./at cross:test [a] [b] [vitest args…]`: tests/cross — cross-backend scenarios (spec 15.2) against api-<a> and api-<b>
# (CROSS_API_URLS), both started first. Default pair express express (main has no other backend); the ports run their
# pairs in both orders (`cross:test express django`, `cross:test django express`).
cross_test() (
  set -euo pipefail
  a="express"; b="express"
  case "${1:-}" in express|django|laravel) a="$1"; shift ;; esac
  case "${1:-}" in express|django|laravel) b="$1"; shift ;; esac
  up_backend "$a"
  if [ "$b" != "$a" ]; then up_backend "$b"; fi
  quiet_schedulers "$a" "$b"
  trap wake_schedulers EXIT
  run $DC run --rm -e "CROSS_API_URLS=http://api-${a}:8000/api/v1,http://api-${b}:8000/api/v1" tools \
    pnpm --filter @agrotrace/tests-cross test "$@"
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

# ── Frontends (Plan 2+) ─────────────────────────────────────────────────────────────────────────────────────────────
# `fe:<cmd> <front>` for react, angular and svelte. Each front has its own stand, never touching the shared
# `agrotrace` services:
#   react   — `gateway-react` (compose project agrotrace-react, docker-compose.react-dev.yml, host port 8089) on the
#             main stack's network: react-express.localhost = dist against the shared api-express, react-mock.localhost
#             = dist-mock (./at fe:build react --mock, ruling FM23: the mock backend in the browser).
#   angular — `gateway-angular` (compose project agrotrace-angular, docker-compose.angular-dev.yml, host port 8090)
#             on its own network: http://angular-mock.localhost:8090/ serves the mock-mode build (dist-mock, ruling
#             FM23 — the MSW service worker of @agrotrace/mock-api answers /api/v1 in the browser, no API server);
#             the production build (dist) is served at the other angular-* hosts (no backend on this network — its
#             e2e answers /api/v1 in the page); its Playwright one-off runs in the same compose project.
#   svelte  — `gateway-svelte` (compose project agrotrace-svelte, docker-compose.svelte-mock.yml, host port 8091) on its
#             own network: svelte-mock.localhost = build-mock (./at fe:build svelte --mock, ruling FM23: the mock backend
#             in the browser, no API server), svelte-express.localhost = the production build (nothing behind its /api:
#             its e2e answers /api/v1 in Playwright's route layer), with its own Playwright.
DCR="docker compose -f docker-compose.react-dev.yml"
DCA="docker compose -f docker-compose.angular-dev.yml"
DCS="docker compose -f docker-compose.svelte-mock.yml"

fe_front() {
  case "${1:-}" in
    react|angular|svelte) ;;
    *) echo "usage: ./at fe:<build|test|dev|gateway|e2e-smoke> <react|angular|svelte>" >&2; exit 2 ;;
  esac
}

# `fe:gateway <front> [up|down]`: the built app (./at fe:build <front> [--mock]) behind the gateway nginx —
# react: dist and/or dist-mock at http://react-express.localhost:8089/ and http://react-mock.localhost:8089/ (the
# backend itself comes from the shared stack: ./at up express); angular: dist and dist-mock (both required) at
# http://angular-mock.localhost:8090/; svelte: build and/or build-mock at http://svelte-mock.localhost:8091/ (no
# backend needed). The design system at /_ds/ of the same port.
fe_gateway() (
  set -euo pipefail
  fe_front "${1:-}"
  front="$1"
  case "${2:-up}" in
    up)
      if [ "${AT_DRY_RUN:-}" != "1" ]; then
        case "$front" in
          react)
            [ -f frontend-react/dist/index.html ] || [ -f frontend-react/dist-mock/index.html ] \
              || { echo "fe:gateway: no frontend-react/dist or dist-mock — run ./at fe:build react [--mock] first" >&2; exit 1; }
            mkdir -p frontend-react/dist frontend-react/dist-mock
            docker network inspect agrotrace_at >/dev/null 2>&1 \
              || { echo "fe:gateway: network agrotrace_at does not exist — start the stack first (./at up express)" >&2; exit 1; } ;;
          angular)
            [ -f "frontend-angular/dist/index.html" ] || { echo "fe:gateway: no frontend-angular/dist — run ./at fe:build angular first" >&2; exit 1; }
            [ -f "frontend-angular/dist-mock/index.html" ] || { echo "fe:gateway: no frontend-angular/dist-mock — run ./at fe:build angular --mock first" >&2; exit 1; } ;;
          svelte)
            [ -f frontend-svelte/build/index.html ] || [ -f frontend-svelte/build-mock/index.html ] \
              || { echo "fe:gateway: no frontend-svelte/build or build-mock — run ./at fe:build svelte [--mock] first" >&2; exit 1; }
            mkdir -p frontend-svelte/build frontend-svelte/build-mock ;;
        esac
      fi
      case "$front" in
        react)
          run $DCR up -d --build --wait gateway-react
          echo "React: http://react-express.localhost:8089/  mock: http://react-mock.localhost:8089/  (design system: http://localhost:8089/_ds/)" ;;
        angular)
          run $DCA up -d --build --wait gateway-angular
          echo "Angular: http://angular-mock.localhost:8090/  (design system: http://localhost:8090/_ds/)" ;;
        svelte)
          # Always recreated: adapter-static replaces frontend-svelte/build on every build, and a running container
          # would keep serving the deleted directory through its bind mount.
          run $DCS up -d --build --force-recreate --wait gateway-svelte
          echo "Svelte: mock http://svelte-mock.localhost:8091/  production http://svelte-express.localhost:8091/  (design system: http://localhost:8091/_ds/)" ;;
      esac ;;
    down)
      case "$front" in
        react) run $DCR down ;;
        angular) run $DCA down ;;
        svelte) run $DCS down ;;
      esac ;;
    *) echo "usage: ./at fe:gateway <react|angular|svelte> [up|down]" >&2; exit 2 ;;
  esac
)

# Whether the Svelte stand (gateway-svelte) runs: 1 or 0 (dry run: AT_DRY_STAND, default 0).
svelte_stand() {
  if [ "${AT_DRY_RUN:-}" = "1" ]; then echo "${AT_DRY_STAND:-0}"; return; fi
  [ -n "$($DCS ps -q --status running gateway-svelte 2>/dev/null)" ] && echo 1 || echo 0
}

# `fe:build <front> [--mock]`: dist (the live API through the gateway) or, with --mock (ruling FM23), the build with
# the in-browser backend of @agrotrace/mock-api (react/angular: dist-mock, svelte: build-mock). Svelte (polish P2):
# adapter-static deletes and recreates frontend-svelte/build[-mock], which a running gateway-svelte holds as a bind
# mount — on Docker Desktop the build then fails (`ENOENT: mkdir build/assets/…`) or the stand keeps serving the
# deleted directory. A running stand is stopped for the build and recreated afterwards, whatever the build's outcome.
fe_build() (
  set -euo pipefail
  fe_front "${1:-}"; front="$1"; shift
  local script
  case "${1:-}" in
    '') script=build ;;
    --mock) script=build:mock ;;
    *) echo "usage: ./at fe:build <react|angular|svelte> [--mock]" >&2; exit 2 ;;
  esac
  if [ "$front" = svelte ] && [ "$(svelte_stand)" = "1" ]; then
    run $DCS stop gateway-svelte
    trap 'fe_gateway svelte up' EXIT
  fi
  run $T pnpm --filter "@agrotrace/frontend-$front" "$script"
  # The main gateway serves the production build through a symlink (PL2): point it at the new build.
  if [ "$script" = build ] && { [ "${AT_DRY_GATEWAY:-}" = "1" ] || { [ "${AT_DRY_RUN:-}" != "1" ]       && [ -n "$($DC ps -q --status running gateway 2>/dev/null)" ]; }; }; then
    run $DC exec -T gateway sh //docker-entrypoint.d/40-fronts.sh
  fi
)

# `fe:e2e-smoke <front> [playwright args…]`: the build through its gateway (started if needed; svelte: always
# recreated), Playwright one-off — frontend-<front>/e2e (`//repo`: no Git Bash path conversion). React: the
# `playwright` service on network agrotrace_at; Angular: `playwright-angular` of project agrotrace-angular; Svelte:
# `playwright-svelte` of project agrotrace-svelte.
fe_e2e_smoke() (
  set -euo pipefail
  fe_front "${1:-}"; front="$1"; shift
  case "$front" in
    react)
      if [ "${AT_DRY_RUN:-}" = "1" ] || [ -z "$($DCR ps -q --status running gateway-react 2>/dev/null)" ]; then
        fe_gateway react up
      fi
      run $DC run --rm -w //repo/frontend-react playwright npx --no-install playwright test -c e2e/playwright.config.ts "$@" ;;
    angular)
      if [ "${AT_DRY_RUN:-}" = "1" ] || [ -z "$($DCA ps -q --status running gateway-angular 2>/dev/null)" ]; then
        fe_gateway angular up
      fi
      run $DCA run --rm -w //repo/frontend-angular playwright-angular npx --no-install playwright test -c e2e/playwright.config.ts "$@" ;;
    svelte)
      fe_gateway svelte up
      run $DCS run --rm -w //repo/frontend-svelte playwright-svelte npx --no-install playwright test -c e2e/playwright.config.ts "$@" ;;
  esac
)

# `e2e [front] [back] [playwright args…]`: the shared parity suite tests/e2e (Plan 2 Task 9) against
# http://{front}-{back}.localhost through a gateway. front ∈ react|angular|svelte (default react), back ∈
# mock|express|django|laravel (default mock); every other argument goes to Playwright unchanged
# (`./at e2e --grep UC-02`, `./at e2e angular mock visual.spec.ts`).
# Gateway: GATEWAY_HOST if set, else the front's stand (gateway-<front>, compose project agrotrace-<front>) when it
# runs, else the main `gateway`; inside the network it listens on 80 (GATEWAY_PORT). Playwright one-off: the
# `playwright` service on network agrotrace_at, except for the Angular and Svelte stands, which have their own networks
# (ruling FM23) — there `playwright-angular` of agrotrace-angular (when its stand runs) / `playwright-svelte` of
# agrotrace-svelte (always for svelte: the main network cannot resolve its stand), with the
# working directory overridden to tests/e2e.
e2e_gateway() {
  if [ -n "${GATEWAY_HOST:-}" ]; then echo "$GATEWAY_HOST"; return; fi
  local running
  if [ "${AT_DRY_RUN:-}" = "1" ]; then running="${AT_DRY_STAND:-1}"
  else running=$([ -n "$(docker ps -q --filter "label=com.docker.compose.service=gateway-$1" --filter status=running)" ] && echo 1 || echo 0)
  fi
  if [ "$running" = "1" ]; then echo "gateway-$1"; else echo gateway; fi
}
e2e() (
  set -euo pipefail
  front=react; back=mock
  case "${1:-}" in react|angular|svelte) front="$1"; shift ;; esac
  case "${1:-}" in mock|express|django|laravel) back="$1"; shift ;; esac
  # A real backend is always reached through the main gateway (PL5); the stands serve only the mock builds.
  if [ "$back" = mock ]; then gw="$(e2e_gateway "$front")"; else gw=gateway; fi
  if [ "$front" = svelte ] && [ "$gw" = gateway ] && [ "$back" = mock ]; then
    # Polish P2: without its stand the run would only fail later on every page with a DNS error of Playwright.
    echo "e2e: the Svelte stand (gateway-svelte, compose project agrotrace-svelte) is not running —" \
      "build and start it first: ./at fe:build svelte --mock && ./at fe:gateway svelte up" >&2
    exit 1
  fi
  if [ "$gw" = gateway ]; then compose="$DC"; service=playwright
  elif [ "$front" = svelte ]; then compose="$DCS"; service=playwright-svelte
  elif [ "$gw" = gateway-angular ]; then compose="$DCA"; service=playwright-angular
  else compose="$DC"; service=playwright; fi
  # A real backend: the other implementations' schedulers are stopped for the run (SP1); mock needs nothing.
  # The e2e profile (docker-compose.e2e.yml, PL4) on api-<back> for the run, the plain configuration back on exit.
  if [ "$back" != mock ]; then
    quiet_schedulers "$back"
    e2e_restore() { local rc=0; run $DC up -d --no-build --no-deps --wait "api-$back" || rc=$?; wake_schedulers; return "$rc"; }
    trap e2e_restore EXIT
    run $DC -f docker-compose.yml -f docker-compose.e2e.yml up -d --no-build --no-deps --wait "api-$back"
  fi
  run $compose run --rm -e FRONT="$front" -e BACK="$back" -e GATEWAY_HOST="$gw" -e GATEWAY_PORT=80 \
    -w //repo/tests/e2e $service npx --no-install playwright test "$@"
)

# ── Per-backend helpers (the hooks the per-backend commands call) ───────────────────────────────────────────────────
# --- django (plan 3) ---
# django_test_hook [pytest args…]: the body of `django:test`, run after `prepare_test_db agrotrace_test_django`
# (TEST_DATABASE_URL / TEST_APP_DATABASE_URL exported, stand lock held). Builds the backend-django image (pytest and
# ruff are in it, D-M5) and runs, with the working tree's backend-django/ and docker-compose.yml mounted read-only,
# `pytest [args…]` against agrotrace_test_django as the app role (TEST_DATABASE_URL inside = TEST_APP_DATABASE_URL),
# then `ruff check`; fails if either fails. MSYS_NO_PATHCONV keeps Git Bash from rewriting the container paths.
# A run without pytest arguments is a full run: it also measures agrotrace/domain and fails under the §14.1 bar
# (70 %, backend-django/pyproject.toml [tool.coverage]). `-m stand` runs the stand checks (the broker topology) against
# the running stand (`./at up django` first).
django_test_hook() {
  [ $# -eq 0 ] && set -- --cov --cov-report=term
  run $DC build api-django
  run env MSYS_NO_PATHCONV=1 $DC run --rm --no-deps -e "TEST_DATABASE_URL=$TEST_APP_DATABASE_URL" \
    -e AGROTRACE_PROCESS=test -v ./backend-django:/app/backend-django:ro \
    -v ./docker-compose.yml:/app/docker-compose.yml:ro \
    api-django sh -c 'rc=0; pytest "$@" || rc=$?; ruff check . || rc=1; exit $rc' pytest "$@"
}
# --- end django ---
# --- laravel (plan 5) ---
# laravel_test_hook [pest args…] [--domain-coverage]: the body of `laravel:test`, run after
# `prepare_test_db agrotrace_test_laravel` (TEST_DATABASE_URL / TEST_APP_DATABASE_URL exported, stand lock held).
# Bundles the contract (contracts/dist/openapi.json — ContractGate and the tests read it), installs the locked composer
# packages into the laravel-vendor volume and runs Pest in php-tools; the `integration` tests use agrotrace_test_laravel
# (as agrotrace_app) and the stand's Redis. --domain-coverage: only the domain on the shared vectors
# (tests/Unit/Domain), failing below 70 % line coverage of app/Domain (spec §14.1). Other arguments go to Pest.
laravel_test_hook() {
  local pest="vendor/bin/pest" a args=()
  for a in "$@"; do
    case "$a" in
      --domain-coverage) pest="vendor/bin/pest -c phpunit.domain.xml --coverage --min=70" ;;
      *) args+=("$a") ;;
    esac
  done
  run $T pnpm --filter @agrotrace/contracts bundle
  run $DC run --rm -e TEST_DATABASE_URL -e TEST_APP_DATABASE_URL php-tools \
    sh -c "composer install --no-interaction --no-progress --quiet && $pest \"\$@\"" pest ${args[@]+"${args[@]}"}
}
# laravel_lint: Pint (--test, no rewrite) and Larastan over backend-laravel — read-only, no stand lock.
laravel_lint() {
  run $DC run --rm --no-deps php-tools \
    sh -c 'composer install --no-interaction --no-progress --quiet && vendor/bin/pint --test && vendor/bin/phpstan analyse --no-progress --memory-limit=1G'
}
# laravel_stack [pest args…]: tests/Stack (backend-laravel) against the running api-laravel through its HAProxy front —
# the only guard of the front's rules (malformed %-escapes, the prompt JSON 413 with close, headers; Ruling Q8). Starts
# the Laravel backend first (`up laravel`), stand lock held.
laravel_stack() {
  up_backend laravel
  run $DC run --rm --no-deps -e STACK_API=api-laravel:8000 php-tools \
    sh -c 'composer install --no-interaction --no-progress --quiet && vendor/bin/pest tests/Stack "$@"' pest ${1+"$@"}
}
# --- end laravel ---


# Commands that mutate the shared stand (DB reset/seed/migrate, test-profile recreation of backend containers, real
# backend e2e, benchmark, the ports' unit suites on their own migrated DBs — SP2) take the lock; everything else
# (build, `test`, mock e2e, psql, check…) does not.
case "$cmd" in
  api:test|cross:test|docs:test|gw:test|test:all|db:migrate|db:rollback|db:test|gen:db-types|seed|seed:test|reset|bench|down)
    lock_acquire "$cmd $*" ;;
  up) [ "${1:-all}" = "help" ] || lock_acquire "$cmd $*" ;;
  e2e) # only against a real backend (mock runs in the browser)
    case " $* " in *" express "*|*" django "*|*" laravel "*) lock_acquire "$cmd $*" ;; esac ;;
  lock:run) lock_acquire "$*" ;;
  # --- django (plan 3) ---
  django:test) lock_acquire "$cmd $*" ;;
  # --- end django ---
  # --- laravel (plan 5) ---
  laravel:test) lock_acquire "$cmd $*" ;;
  laravel:stack) lock_acquire "$cmd $*" ;;
  # --- end laravel ---
esac

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
  # seed checked → tests/api against Express (after a reset; then its rate-limit tests, P10) → tests/cross (default
  # express pair; the ports add theirs in their sections) → gateway up + gw:test → Swagger UI through the gateway → design-system showcase.
  # Per-backend lines (unit suite, api:test --reset / --ratelimits, cross pairs, docs:test) go in that backend's section.
  test:all)
    "$0" test
    "$0" at:test
    "$0" up infra
    "$0" db:test
    "$0" db:migrate
    "$0" seed:test
    # --- express (plan 1) ---
    "$0" api:test express --reset
    "$0" api:test express --ratelimits
    # --- end express ---
    # --- django (plan 3) ---
    "$0" django:test
    "$0" api:test django --reset
    "$0" api:test django --ratelimits
    "$0" cross:test express django
    # --- end django ---
    # --- laravel (plan 5) ---
    "$0" laravel:test
    "$0" laravel:stack
    "$0" api:test laravel --reset
    "$0" api:test laravel --ratelimits
    "$0" cross:test express laravel
    "$0" cross:test laravel express
    "$0" docs:test laravel
    # --- end laravel ---
    "$0" cross:test
    "$0" up gateway
    "$0" gw:test
    "$0" docs:test express
    "$0" ds:test ;;
  # ESLint's flat config (eslint.config.js) already covers the whole repo tree in one pass — `-r`
  # would instead run per-workspace-package `lint` scripts, none of which exist (only the root
  # package.json has one), so recursing here silently lints nothing.
  lint)      $T pnpm lint ;;
  typecheck) $T pnpm -r typecheck ;;
  # P13: explicit paths only. No arguments or any flag-like argument (`--help`, `-w`, …) is refused: prettier would
  # read a flag as an option and still `--write` the default target, reformatting the whole repository.
  fmt)
    if [ $# -eq 0 ]; then
      echo "usage: ./at fmt <path>… — formats the given files/directories with Prettier (explicit paths only)" >&2
      exit 2
    fi
    for p in "$@"; do
      case "$p" in
        -*) echo "./at fmt: '$p' looks like an option; only paths are accepted (P13)" >&2; exit 2 ;;
      esac
    done
    run $T pnpm exec prettier --write -- "$@" ;;
  # --build on every `up` (R80): a stale gateway/mercury-mock image is never silently reused —
  # docker compose skips the build step on its own for any service without a `build:` key, so this
  # is a no-op for postgres/redis/rabbitmq/minio/mailpit.
  # `up <front> <back>` (R88 M6, spec §14.4): infra + the backend's services + the gateway; the
  # frontend is static and served by the gateway at http://<front>-<back>.localhost:<GATEWAY_PORT>/.
  up)
    case "${1:-all}" in
      infra)   infra_up && run $DC up --build minio-init ;;
      gateway)
        run $DC up -d --build --wait gateway
        set -a; . ./.env; set +a
        echo "Gateway up: http://localhost:${GATEWAY_PORT:-80}/  (design system: http://localhost:${GATEWAY_PORT:-80}/_ds/)" ;;
      react|angular|svelte) up_combo "$@" ;;
      express|django|laravel) up_backend "$1" ;;
      all) up_all ;;
      *) echo "usage: ./at up [all|infra|gateway|<express|django|laravel>|<react|angular|svelte> <express|django|laravel>]" >&2; exit 2 ;;
    esac ;;
  down)        $DC down "$@" ;;
  db:migrate)  $DC up -d $NO_RECREATE --wait postgres && $DC run --rm --no-deps dbmate --no-dump-schema --wait up && dump_schema ;;
  # schema.sql always represents ALL migrations on disk (dump_schema builds it
  # from a throwaway DB that replays every migration, regardless of dev DB
  # state) — a rollback moves the dev DB backward, not schema.sql, so it must
  # not regenerate a file that would come out byte-identical to db:migrate's
  # anyway; only db:migrate does.
  db:rollback) $DC up -d $NO_RECREATE --wait postgres && $DC run --rm --no-deps dbmate --no-dump-schema rollback ;;
  db:new)      $DC run --rm --no-deps dbmate new "$1" ;;
  db:test)
    set -a; . ./.env; set +a
    TDB=agrotrace_test
    TEST_DATABASE_URL="${DATABASE_URL%/*}/${TDB}?sslmode=disable"
    TEST_APP_DATABASE_URL="${APP_DATABASE_URL%/*}/${TDB}"
    $DC up -d $NO_RECREATE --wait postgres
    recreate_db "$TDB"
    $DC run --rm --no-deps dbmate --url "$TEST_DATABASE_URL" --no-dump-schema --wait up
    $DC run --rm -e DATABASE_URL="$TEST_DATABASE_URL" -e APP_DATABASE_URL="$TEST_APP_DATABASE_URL" tools \
      pnpm --filter @agrotrace/tests-db test ;;
  # Kysely types of the Express backend (backend-express/src/db/types.generated.ts) from a freshly migrated
  # agrotrace_test — the schema of the migrations on disk, never the drifting dev DB. tests/db checks freshness.
  gen:db-types)
    set -a; . ./.env; set +a
    TDB=agrotrace_test
    TEST_DATABASE_URL="${DATABASE_URL%/*}/${TDB}?sslmode=disable"
    $DC up -d $NO_RECREATE --wait postgres
    recreate_db "$TDB"
    $DC run --rm --no-deps dbmate --url "$TEST_DATABASE_URL" --no-dump-schema --wait up
    $DC run --rm -e DATABASE_URL="$TEST_DATABASE_URL" tools \
      pnpm --filter @agrotrace/backend-express gen:db-types ;;
  ds:test)     $DC run --rm playwright npx --no-install playwright test "$@" ;;
  # Swagger UI of a backend through the gateway (P5, R89/I6): renders under the gateway CSP with no console error,
  # CSP violation or foreign request. Starts the backend and the gateway first (`up <back>`, `up gateway`).
  docs:test)
    back="${1:-express}"; [ $# -gt 0 ] && shift
    up_backend "$back"
    run $DC up -d --build --wait gateway
    run $DC run --rm -e "DOCS_BACKEND=${back}" playwright npx --no-install playwright test -c api-docs/playwright.config.ts "$@" ;;
  # Gateway must already be up (./at.sh up gateway). See gw_test() above for what this checks.
  gw:test)     gw_test ;;
  api:test)    api_test "$@" ;;
  cross:test)  cross_test "$@" ;;
  psql)        $DC exec postgres psql -U agrotrace_owner agrotrace ;;
  check)
    $DC exec -T postgres pg_isready -U agrotrace_owner && \
    $DC exec -T redis redis-cli ping && \
    $DC exec -T rabbitmq rabbitmq-diagnostics -q check_running && \
    { [ "$($DC exec -T rabbitmq rabbitmqctl -q list_queues name arguments | grep -cE '\.jobs[[:space:]].*x-delivery-limit')" = "3" ] \
      || { echo "rabbitmq: the three jobs queues (x-delivery-limit) did not load from definitions.json"; false; }; } && \
    { [ "$($DC exec -T rabbitmq rabbitmqctl -q list_queues name arguments | grep -cE '\.jobs\.delay[[:space:]].*x-message-ttl')" = "3" ] \
      || { echo "rabbitmq: the three delay queues (P56) did not load from definitions.json — restart rabbitmq"; false; }; } && \
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
    $DC up -d $NO_RECREATE --wait postgres
    while [ "$(applied_migrations)" != "0" ]; do
      $DC run --rm --no-deps dbmate --no-dump-schema rollback
    done
    $DC run --rm --no-deps dbmate --no-dump-schema --wait up
    $DC run --rm -e SEED_NOW -e SEED_ALLOW_DB tools pnpm --filter @agrotrace/seed seed ;;
  bench) "$(dirname "$0")/benchmark/bench.sh" "$@" ;; # no exec: the EXIT trap releases the stand lock
  # `lock:run <command…>`: any host command under the shared-stand lock (also the nested-call test hook).
  lock:run)  "$@" ;;
  # Frontends (see fe_front above): build into frontend-<front>/dist (svelte: build), component tests (Vitest + MSW
  # from the contract), the Vite dev server on http://localhost:5173 (angular: 4200; API proxied to api-express), the
  # separate gateway, the smoke e2e.
  # `fe:build <front> [--mock]`: the production build or, with --mock (ruling FM23), the build with the in-browser
  # backend of @agrotrace/mock-api (react-mock.localhost:8089, angular-mock.localhost:8090, svelte-mock.localhost:8091).
  fe:build)  fe_build "$@" ;;
  fe:test)   fe_front "${1:-}"; front="$1"; shift; run $T pnpm --filter "@agrotrace/frontend-$front" test "$@" ;;
  fe:dev)    fe_front "${1:-}"; if [ "$1" = "angular" ]; then run $DC run --rm -p 4200:4200 tools pnpm --filter "@agrotrace/frontend-angular" dev; else run $DC run --rm -p 5173:5173 tools pnpm --filter "@agrotrace/frontend-$1" dev; fi ;;
  fe:gateway) fe_gateway "$@" ;;
  fe:e2e-smoke) fe_e2e_smoke "$@" ;;
  # `e2e [front] [back] [playwright args…]`: the shared parity suite (see e2e above).
  e2e) e2e "$@" ;;
  # `e2e:matrix [playwright args…]`: tests/e2e on all nine front × backend pairs (spec §14.1), each after `reset`;
  # the table `front back rc seconds` goes to stdout and tests/e2e/test-results/matrix-summary.txt; fails if any failed.
  # The sub-commands take the stand lock themselves.
  e2e:matrix)
    summary=tests/e2e/test-results/matrix-summary.txt; mkdir -p tests/e2e/test-results; : > "$summary"; failed=0
    for back in express django laravel; do for front in react angular svelte; do
      start=$(date +%s); rc=0
      "$0" reset >/dev/null && "$0" e2e "$front" "$back" "$@" || rc=$?
      [ "$rc" = 0 ] || failed=1
      echo "$front $back $rc $(( $(date +%s) - start ))" | tee -a "$summary"
    done; done
    exit $failed ;;
  # Per-backend commands (unit suites, linters, package managers):
  # --- django (plan 3) ---
  # `django:test [pytest args…]` (locked): Django's unit suite on its own DB agrotrace_test_django (SP2).
  django:test) prepare_test_db agrotrace_test_django; django_test_hook "$@" ;;
  # --- end django ---
  # --- laravel (plan 5) ---
  # `laravel:test [pest args…]` (locked): Laravel's unit suite on its own DB agrotrace_test_laravel (SP2).
  laravel:test) prepare_test_db agrotrace_test_laravel; laravel_test_hook "$@" ;;
  # `laravel:stack [pest args…]` (locked): tests/Stack against api-laravel (HAProxy front rules, Ruling Q8).
  laravel:stack) laravel_stack "$@" ;;
  # `laravel:lint`: Pint --test + Larastan (backend-laravel, php-tools); `composer <args>`: composer in php-tools
  # (backend-laravel, vendor in the laravel-vendor volume). Neither changes the stand: no lock.
  laravel:lint) laravel_lint ;;
  composer)  run $DC run --rm --no-deps php-tools composer "$@" ;;
  # --- end laravel ---
  # Top-level commands only (two-space indented case labels).
  help|*)  grep -E '^  [a-z0-9:-]+\)' "$0" | sed 's/).*//' | tr -d ' ' ;;
esac
