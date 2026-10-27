#!/bin/sh
# Every process of the image (api, worker, scheduler) validates its environment first: an invalid value stops it with
# exit code 78 (EX_CONFIG) and one line per problem (App\Support\EnvConfig, incl. the P61 connection budget).
set -e
php /app/artisan agrotrace:preflight
# Express's PORT / METRICS_PORT / SHUTDOWN_TIMEOUT_MS (validated above). PORT is the HAProxy front
# (docker/haproxy-api.cfg), METRICS_PORT the Caddy block (docker/Caddyfile). On SIGTERM the requests and handlers in
# flight get SHUTDOWN_TIMEOUT_MS (Caddy grace_period, HAProxy hard-stop-after; ≥ 1 ms, since 0 would mean "no limit"
# to both); supervisord SIGKILLs what still runs 2 s later (stopwaitsecs of the supervisord-*.conf programs) — the
# exit watchdog of Express's onShutdown.
PORT=${PORT:-8000}
METRICS_PORT=${METRICS_PORT:-9464}
SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS:-10000}
AGROTRACE_GRACE_MS=$(( SHUTDOWN_TIMEOUT_MS > 0 ? SHUTDOWN_TIMEOUT_MS : 1 ))
AGROTRACE_STOP_WAIT_SECS=$(( (SHUTDOWN_TIMEOUT_MS + 999) / 1000 + 2 ))
export PORT METRICS_PORT SHUTDOWN_TIMEOUT_MS AGROTRACE_GRACE_MS AGROTRACE_STOP_WAIT_SECS
# FrankenPHP's threads (docker/Caddyfile): the Octane workers' own, one classic thread per SSE stream up to
# SSE_MAX_STREAMS (App\Sse\StreamAdmission counts them), and 16 more classic threads that no stream ever keeps: they
# answer the requests to /events/stream that end at once (401, 429, the cap's `retry:`) while the streams are full —
# with no free thread FrankenPHP 1.4 would park those unanswered (it has no max_wait_time).
SSE_ADMISSION_THREADS=16
FRANKENPHP_NUM_THREADS=$(( ${OCTANE_WORKERS:-32} + SSE_ADMISSION_THREADS + ${SSE_MAX_STREAMS:-200} ))
export FRANKENPHP_NUM_THREADS
exec "$@"
