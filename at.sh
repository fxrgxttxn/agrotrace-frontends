#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
DC="docker compose"
T="$DC run --rm tools"
cmd="${1:-help}"; shift || true
case "$cmd" in
  install) $T pnpm install "$@" ;;
  sh)      $T bash ;;
  pnpm)    $T pnpm "$@" ;;
  test)    $T pnpm -r --workspace-concurrency=1 test "$@" ;;
  lint)    $T pnpm -r lint ;;
  fmt)     $T pnpm exec prettier --write . ;;
  help|*)  grep -E '^\s+[a-z:-]+\)' "$0" | sed 's/).*//' | tr -d ' ' ;;
esac
