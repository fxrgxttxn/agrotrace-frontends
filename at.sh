#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
DC="docker compose"
T="$DC run --rm tools"
cmd="${1:-help}"; shift || true

run() {
  if [ "${AT_DRY_RUN:-}" = "1" ]; then echo "+ $*"; else "$@"; fi
}

port_of() {
  local var
  case "$1" in react) var=REACT_PORT ;; angular) var=ANGULAR_PORT ;; svelte) var=SVELTE_PORT ;; esac
  local v="${!var:-}"
  if [ -z "$v" ]; then v="$( (set -a; . ./.env; echo "${!var:-}") )"; fi
  case "$1" in react) echo "${v:-8089}" ;; angular) echo "${v:-8090}" ;; svelte) echo "${v:-8091}" ;; esac
}

fe_front() {
  case "${1:-}" in
    react|angular|svelte) ;;
    *) echo "usage: ./at fe:<build|test|dev|gateway|e2e-smoke> <react|angular|svelte>" >&2; exit 2 ;;
  esac
}

fe_out() { if [ "$1" = svelte ]; then echo "frontend-svelte/build"; else echo "frontend-$1/dist"; fi; }

gateway_running() {
  if [ "${AT_DRY_RUN:-}" = "1" ]; then echo "${AT_DRY_STAND:-0}"; return; fi
  [ -n "$($DC --profile "$1" ps -q --status running "gateway-$1" 2>/dev/null)" ] && echo 1 || echo 0
}

fe_gateway() (
  set -euo pipefail
  fe_front "${1:-}"
  local front="$1" out; out="$(fe_out "$1")"
  case "${2:-up}" in
    up)
      if [ "${AT_DRY_RUN:-}" != "1" ]; then
        [ -f "$out/index.html" ] || [ -f "$out-mock/index.html" ] \
          || { echo "fe:gateway: no $out or $out-mock — run ./at fe:build $front [--mock] first" >&2; exit 1; }
        mkdir -p "$out" "$out-mock"
      fi
      run $DC --profile "$front" up -d --build --force-recreate --wait "gateway-$front"
      local port; port="$(port_of "$front")"
      echo "$front: http://$front-mock.localhost:$port/  (design system: http://localhost:$port/_ds/)" ;;
    down) run $DC --profile "$front" rm -sf "gateway-$front" ;;
    *) echo "usage: ./at fe:gateway <react|angular|svelte> [up|down]" >&2; exit 2 ;;
  esac
)

fe_build() (
  set -euo pipefail
  fe_front "${1:-}"; local front="$1"; shift
  local script
  case "${1:-}" in
    '') script=build ;;
    --mock) script=build:mock ;;
    *) echo "usage: ./at fe:build <react|angular|svelte> [--mock]" >&2; exit 2 ;;
  esac
  if [ "$(gateway_running "$front")" = "1" ]; then
    run $DC --profile "$front" stop "gateway-$front"
    trap 'fe_gateway "$front" up' EXIT
  fi
  run $T pnpm --filter "@agrotrace/frontend-$front" "$script"
)

fe_e2e_smoke() (
  set -euo pipefail
  fe_front "${1:-}"; local front="$1"; shift
  if [ "$(gateway_running "$front")" != "1" ]; then fe_gateway "$front" up; fi
  run $DC run --rm -w "//repo/frontend-$front" playwright npx --no-install playwright test -c e2e/playwright.config.ts "$@"
)

e2e() (
  set -euo pipefail
  local front=react back=mock
  case "${1:-}" in react|angular|svelte) front="$1"; shift ;; esac
  case "${1:-}" in mock|express) back="$1"; shift ;; esac
  local gw="${GATEWAY_HOST:-gateway-$front}"
  if [ -z "${GATEWAY_HOST:-}" ] && [ "$(gateway_running "$front")" != "1" ]; then
    echo "e2e: gateway-$front is not running — ./at fe:build $front --mock && ./at fe:gateway $front" >&2
    exit 1
  fi
  run $DC run --rm -e FRONT="$front" -e BACK="$back" -e GATEWAY_HOST="$gw" -e GATEWAY_PORT=80 \
    -w //repo/tests/e2e playwright npx --no-install playwright test "$@"
)

case "$cmd" in
  install)   $T pnpm install "$@" ;;
  sh)        $T bash ;;
  pnpm)      $T pnpm "$@" ;;
  test)      $T pnpm -r --workspace-concurrency=1 --filter '!./tests/**' test "$@" ;;
  lint)      $T pnpm lint ;;
  typecheck) $T pnpm -r typecheck ;;
  fmt)
    if [ $# -eq 0 ]; then
      echo "usage: ./at fmt <path>… — formats the given files/directories with Prettier" >&2
      exit 2
    fi
    for p in "$@"; do
      case "$p" in
        -*) echo "./at fmt: '$p' looks like an option; only paths are accepted" >&2; exit 2 ;;
      esac
    done
    run $T pnpm exec prettier --write -- "$@" ;;
  ds:test)   $DC run --rm playwright npx --no-install playwright test "$@" ;;
  fe:build)  fe_build "$@" ;;
  fe:test)   fe_front "${1:-}"; front="$1"; shift; run $T pnpm --filter "@agrotrace/frontend-$front" test "$@" ;;
  fe:dev)
    fe_front "${1:-}"; front="$1"; shift
    if [ "$front" = angular ]; then p=4200; else p=5173; fi
    run $DC run --rm -p "$p:$p" tools pnpm --filter "@agrotrace/frontend-$front" dev "$@" ;;
  fe:gateway)   fe_gateway "$@" ;;
  fe:e2e-smoke) fe_e2e_smoke "$@" ;;
  e2e)       e2e "$@" ;;
  down)      $DC --profile react --profile angular --profile svelte down "$@" ;;
  help|*)    grep -E '^  [a-z0-9:-]+\)' "$0" | sed 's/).*//' | tr -d ' ' ;;
esac
