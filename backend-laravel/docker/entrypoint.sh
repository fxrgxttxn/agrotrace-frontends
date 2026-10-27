#!/bin/sh
# Every process of the image (api, worker, scheduler) validates its environment first: an invalid value stops it with
# exit code 78 (EX_CONFIG) and one line per problem (App\Support\EnvConfig, incl. the P61 connection budget).
set -e
php /app/artisan agrotrace:preflight
# FrankenPHP's threads (docker/Caddyfile): the Octane workers' own, one classic thread per SSE stream up to
# SSE_MAX_STREAMS (App\Sse\StreamAdmission counts them), and 16 more classic threads that no stream ever keeps: they
# answer the requests to /events/stream that end at once (401, 429, the cap's `retry:`) while the streams are full —
# with no free thread FrankenPHP 1.4 would park those unanswered (it has no max_wait_time).
SSE_ADMISSION_THREADS=16
FRANKENPHP_NUM_THREADS=$(( ${OCTANE_WORKERS:-32} + SSE_ADMISSION_THREADS + ${SSE_MAX_STREAMS:-200} ))
export FRANKENPHP_NUM_THREADS
exec "$@"
