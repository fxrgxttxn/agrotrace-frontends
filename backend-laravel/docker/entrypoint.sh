#!/bin/sh
# Every process of the image (api, worker, scheduler) validates its environment first: an invalid value stops it with
# exit code 78 (EX_CONFIG) and one line per problem (App\Support\EnvConfig, incl. the P61 connection budget).
set -e
php /app/artisan agrotrace:preflight
# FrankenPHP requires more PHP threads than Octane workers (docker/Caddyfile).
FRANKENPHP_NUM_THREADS=$(( ${OCTANE_WORKERS:-32} + 2 ))
export FRANKENPHP_NUM_THREADS
exec "$@"
