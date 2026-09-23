#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
DC="docker compose"
T="$DC run --rm tools"
cmd="${1:-help}"; shift || true

# PG16's pg_dump (bundled with the postgres:16-alpine image) instead of dbmate's
# bundled pg_dump 18, whose output PG16 cannot load back. Also strips the
# \restrict/\unrestrict guard meta-commands (backported to recent PG16 point
# releases) and any transaction_timeout SET line — neither is valid outside psql
# and neither should end up in the committed schema.sql.
dump_schema() {
  $DC exec -T postgres pg_dump -U agrotrace_owner --schema-only --no-owner agrotrace \
    | grep -vF '\restrict' \
    | grep -vF '\unrestrict' \
    | grep -v '^SET transaction_timeout' \
    > db/schema.sql
}

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
  db:migrate)  $DC run --rm dbmate --no-dump-schema --wait up && dump_schema ;;
  db:rollback) $DC run --rm dbmate --no-dump-schema rollback && dump_schema ;;
  db:new)      $DC run --rm dbmate new "$1" ;;
  db:test)
    set -a; . ./.env; set +a
    TDB=agrotrace_test
    TEST_DATABASE_URL="${DATABASE_URL%/*}/${TDB}?sslmode=disable"
    TEST_APP_DATABASE_URL="${APP_DATABASE_URL%/*}/${TDB}"
    $DC up -d --wait postgres
    $DC exec -T postgres psql -U agrotrace_owner -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${TDB} WITH (FORCE);"
    $DC exec -T postgres psql -U agrotrace_owner -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TDB} OWNER agrotrace_owner;"
    $DC exec -T postgres psql -U agrotrace_owner -d "${TDB}" -v ON_ERROR_STOP=1 -f //docker-entrypoint-initdb.d/01-roles.sql
    $DC run --rm dbmate --url "$TEST_DATABASE_URL" --no-dump-schema --wait up
    $DC run --rm -e DATABASE_URL="$TEST_DATABASE_URL" -e APP_DATABASE_URL="$TEST_APP_DATABASE_URL" tools \
      pnpm --filter @agrotrace/tests-db test ;;
  psql)        $DC exec postgres psql -U agrotrace_owner agrotrace ;;
  check)
    $DC exec -T postgres pg_isready -U agrotrace_owner && \
    $DC exec -T redis redis-cli ping && \
    $DC exec -T rabbitmq rabbitmq-diagnostics -q check_running && \
    $T sh -c 'curl -fsS http://minio:9000/minio/health/live && curl -fsS http://mailpit:8025/livez' && echo "infra ok" ;;
  help|*)  grep -E '^\s+[a-z:-]+\)' "$0" | sed 's/).*//' | tr -d ' ' ;;
esac
