#!/usr/bin/env bash
# All logic of `./at.sh bench <sub>` lives here (at.sh only delegates one line, spec Global
# Constraints). Talks exclusively to the `agrotrace-bench` compose project (isolated stand, no
# published ports) — never touches the shared `agrotrace` project the other streams use.
set -euo pipefail
cd "$(dirname "$0")"

DC="docker compose -p agrotrace-bench -f docker-compose.yml"
STATE_FILE=".bench-state"

cmd="${1:-help}"; shift || true

usage() {
  echo "usage: ./at.sh bench <up|down|env|test|gen|load|run|plot|report|all> [args]" >&2
  echo "       ./at.sh bench up [pg_profile:default|tuned] [redis_profile:default|tuned] [durability:strict|relaxed]" >&2
  exit 2
}

check_profile()    { case "$1" in default|tuned) ;; *) echo "bench: profile must be default or tuned, got '$1'" >&2; usage ;; esac; }
check_durability() { case "$1" in strict|relaxed) ;; *) echo "bench: durability must be strict or relaxed, got '$1'" >&2; usage ;; esac; }

sync_commit_for() { case "$1" in strict) echo on ;; relaxed) echo off ;; *) usage ;; esac; }     # PG synchronous_commit
appendfsync_for() { case "$1" in strict) echo always ;; relaxed) echo everysec ;; *) usage ;; esac; } # Redis appendfsync

# Every subcommand except up/down needs a stand that `up` already brought up and recorded here —
# this is what tells `test`/`gen`/`load`/`run`/... which profiles/durability are actually live.
# Re-derives (and re-exports) PG_SYNCHRONOUS_COMMIT/REDIS_APPENDFSYNC from DURABILITY every time,
# not just inside `up`: any `$DC run`/`$DC up` call recomputes the container's effective config
# from the *current* environment, and an unset override silently falls back to the compose file's
# own default (`on`/`everysec`) — without this, `test`/`load`/`run` etc. would each redefine (and
# `run`, since bench-redis is a dependency, transparently recreate) bench-redis with the wrong
# durability the moment they run without these two exported alongside it.
load_state() {
  [ -f "$STATE_FILE" ] || { echo "bench: no stand is up — run './at.sh bench up' first" >&2; exit 1; }
  set -a; . "./$STATE_FILE"; set +a
  export PG_SYNCHRONOUS_COMMIT; PG_SYNCHRONOUS_COMMIT="$(sync_commit_for "$DURABILITY")"
  export REDIS_APPENDFSYNC; REDIS_APPENDFSYNC="$(appendfsync_for "$DURABILITY")"
}

do_up() {
  local pg="${1:-default}" rd="${2:-default}" dur="${3:-relaxed}"
  check_profile "$pg"; check_profile "$rd"; check_durability "$dur"
  { echo "PG_PROFILE=$pg"; echo "REDIS_PROFILE=$rd"; echo "DURABILITY=$dur"; } > "$STATE_FILE"
  load_state
  $DC up -d --build --wait bench-postgres bench-redis
  do_env
}

do_env() {
  load_state
  export DOCKER_VERSION DOCKER_COMPOSE_VERSION
  DOCKER_VERSION="$(docker --version)"
  DOCKER_COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || echo unknown)"
  $DC run --rm bench-runner python -m agrobench.env
}

case "$cmd" in
  up)   do_up "$@" ;;
  down) $DC down --volumes "$@"; rm -f "$STATE_FILE" ;;
  env)  do_env ;;
  test) load_state; $DC run --rm bench-runner python -m pytest tests "$@" ;;
  gen)  load_state; $DC run --rm bench-runner python -m agrobench.generate "$@" ;;
  # PostgreSQL first (COPY -> indexes -> ANALYZE), then Redis (pipeline load, then durability
  # mode restored) — independent datastores, order between the two does not matter otherwise.
  load)
    load_state
    $DC run --rm bench-runner python -m agrobench.load_pg "$@"
    $DC run --rm bench-runner python -m agrobench.load_redis "$@" ;;
  run)    load_state; $DC run --rm bench-runner python -m agrobench.run "$@" ;;
  plot)   load_state; $DC run --rm bench-runner python -m agrobench.plot "$@" ;;
  report) load_state; $DC run --rm bench-runner python -m agrobench.report_tables "$@" ;;
  # Full matrix (spec §13.6): {PG default,tuned} x {Redis default,tuned} x {strict,relaxed}, each
  # combination loaded and measured fresh, then plots + report tables from the accumulated CSVs.
  all)
    "$0" gen
    for pg in default tuned; do
      for rd in default tuned; do
        for dur in strict relaxed; do
          "$0" up "$pg" "$rd" "$dur"
          "$0" load
          "$0" run
        done
      done
    done
    "$0" plot
    "$0" report ;;
  help|*) usage ;;
esac
