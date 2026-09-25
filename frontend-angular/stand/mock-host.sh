#!/bin/sh
# Entrypoint of gateway-angular (docker-compose.angular-dev.yml): the shared gateway template, with `mock` accepted as
# the backend part of the host (angular-mock.localhost) — mock mode, where the MSW service worker of @agrotrace/mock-api
# answers /api/v1 in the browser and no api-mock container exists (a request that still reaches the gateway gets its
# 502 BACKEND_UNAVAILABLE; `/_health/mock` of the start page likewise answers "fail"). Rewritten here, at start,
# so the shared template stays the single source of every other
# rule (CSP, headers, caching, /_ds). Idempotent: a template that already accepts `mock` is left as it is.
set -eu
t=/etc/nginx/templates/nginx.conf.template
sed 's/django|laravel)/django|laravel|mock)/g' "$t" > /tmp/nginx.conf.template
mv /tmp/nginx.conf.template "$t"
grep -q 'laravel|mock)' "$t" || { echo "gateway-angular: mock host not accepted by the template" >&2; exit 1; }
exec /docker-entrypoint.sh nginx -g 'daemon off;'
