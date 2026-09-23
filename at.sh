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
  up)
    case "${1:-all}" in
      infra) $DC up -d --wait postgres redis rabbitmq minio mailpit && $DC up minio-init ;;
      *) $DC up -d --wait ;;
    esac ;;
  down)        $DC down "$@" ;;
  db:migrate)  $DC run --rm dbmate --wait up ;;
  db:rollback) $DC run --rm dbmate rollback ;;
  db:new)      $DC run --rm dbmate new "$1" ;;
  db:test)     $T pnpm --filter @agrotrace/tests-db test ;;
  psql)        $DC exec postgres psql -U agrotrace_owner agrotrace ;;
  check)
    $DC exec -T postgres pg_isready -U agrotrace_owner && \
    $DC exec -T redis redis-cli ping && \
    $DC exec -T rabbitmq rabbitmq-diagnostics -q check_running && \
    $T sh -c 'curl -fsS http://minio:9000/minio/health/live && curl -fsS http://mailpit:8025/livez' && echo "infra ok" ;;
  help|*)  grep -E '^\s+[a-z:-]+\)' "$0" | sed 's/).*//' | tr -d ' ' ;;
esac
