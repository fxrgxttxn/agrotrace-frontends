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
  run $DC up -d --build --wait $INFRA_SERVICES
  run $DC up --build minio-init
  run $DC up -d --build --wait $services gateway
  port="$( (set -a; . ./.env; echo "${GATEWAY_PORT:-80}") )"
  echo "$front + $back: http://${front}-${back}.localhost:${port}/"
)

# `./at up <back>`: infra + one backend's services (api, worker, scheduler), no gateway.
up_backend() (
  set -euo pipefail
  back="$1"
  services="$(backend_services "$back")"
  run $DC up -d --build --wait $INFRA_SERVICES
  run $DC up --build minio-init
  run $DC up -d --build --wait $services
  echo "$back up: http://api-${back}:8000/api/v1 inside the \`at\` network (through the gateway: ./at up <front> $back)"
)

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
  if [ "$reset" = "1" ]; then run "$0" reset; fi
  tests="$DC run --rm -e API_URL=http://api-${back}:8000/api/v1 -e API_BACKEND=${back}"
  if [ "$ratelimits" = "1" ]; then
    run $tests -e API_RATELIMITS=1 tools pnpm --filter @agrotrace/tests-api test "$@"
    return
  fi
  procs="$(backend_services "$back")"
  restore() { run $DC up -d --no-build --wait $procs; }
  trap restore EXIT
  # `env` makes the zone visible in a dry run (tests/at); without --tz the profile defaults TZ to UTC.
  zone=(); if [ -n "$tz" ]; then zone=(env "API_TEST_TZ=$tz"); fi
  run "${zone[@]}" $DC -f docker-compose.yml -f docker-compose.api-test.yml up -d --no-build --wait $procs
  run $tests tools pnpm --filter @agrotrace/tests-api test "$@"
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
  gw="$(e2e_gateway "$front")"
  if [ "$front" = svelte ] && [ "$gw" = gateway ]; then
    # Polish P2: without its stand the run would only fail later on every page with a DNS error of Playwright.
    echo "e2e: the Svelte stand (gateway-svelte, compose project agrotrace-svelte) is not running —" \
      "build and start it first: ./at fe:build svelte --mock && ./at fe:gateway svelte up" >&2
    exit 1
  fi
  if [ "$front" = svelte ]; then compose="$DCS"; service=playwright-svelte
  elif [ "$gw" = gateway-angular ]; then compose="$DCA"; service=playwright-angular
  else compose="$DC"; service=playwright; fi
  run $compose run --rm -e FRONT="$front" -e BACK="$back" -e GATEWAY_HOST="$gw" -e GATEWAY_PORT=80 \
    -w //repo/tests/e2e $service npx --no-install playwright test "$@"
)

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
  # seed checked → tests/api against Express (after a reset; then its rate-limit tests, P10) → gateway up + gw:test → Swagger UI through the gateway → design-system showcase.
  test:all)
    "$0" test
    "$0" at:test
    "$0" up infra
    "$0" db:test
    "$0" db:migrate
    "$0" seed:test
    "$0" api:test express --reset
    "$0" api:test express --ratelimits
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
      infra)   run $DC up -d --build --wait $INFRA_SERVICES && run $DC up --build minio-init ;;
      gateway)
        run $DC up -d --build --wait gateway
        set -a; . ./.env; set +a
        echo "Gateway up: http://localhost:${GATEWAY_PORT:-80}/  (design system: http://localhost:${GATEWAY_PORT:-80}/_ds/)" ;;
      react|angular|svelte) up_combo "$@" ;;
      express|django|laravel) up_backend "$1" ;;
      all) run $DC up -d --build --wait ;;
      *) echo "usage: ./at up [all|infra|gateway|<express|django|laravel>|<react|angular|svelte> <express|django|laravel>]" >&2; exit 2 ;;
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
  # Kysely types of the Express backend (backend-express/src/db/types.generated.ts) from a freshly migrated
  # agrotrace_test — the schema of the migrations on disk, never the drifting dev DB. tests/db checks freshness.
  gen:db-types)
    set -a; . ./.env; set +a
    TDB=agrotrace_test
    TEST_DATABASE_URL="${DATABASE_URL%/*}/${TDB}?sslmode=disable"
    $DC up -d --wait postgres
    recreate_db "$TDB"
    $DC run --rm dbmate --url "$TEST_DATABASE_URL" --no-dump-schema --wait up
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
  psql)        $DC exec postgres psql -U agrotrace_owner agrotrace ;;
  check)
    $DC exec -T postgres pg_isready -U agrotrace_owner && \
    $DC exec -T redis redis-cli ping && \
    $DC exec -T rabbitmq rabbitmq-diagnostics -q check_running && \
    { [ "$($DC exec -T rabbitmq rabbitmqctl -q list_queues name arguments | grep -cE '\.jobs[[:space:]].*x-delivery-limit')" = "3" ] \
      || { echo "rabbitmq: the three jobs queues (x-delivery-limit) did not load from definitions.json"; false; }; } && \
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
  bench) exec "$(dirname "$0")/benchmark/bench.sh" "$@" ;;
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
  # Top-level commands only (two-space indented case labels).
  help|*)  grep -E '^  [a-z0-9:-]+\)' "$0" | sed 's/).*//' | tr -d ' ' ;;
esac
