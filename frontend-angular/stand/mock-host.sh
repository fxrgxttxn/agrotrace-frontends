#!/bin/sh
# Entrypoint of gateway-angular (docker-compose.angular-dev.yml): the shared gateway template, with `mock` accepted as
# the backend part of the host (angular-mock.localhost) — mock mode (ruling FM23), where the MSW service worker of
# @agrotrace/mock-api answers /api/v1 in the browser and no api-mock container exists (a request that still reaches the
# gateway gets its 502 BACKEND_UNAVAILABLE; `/_health/mock` of the start page likewise answers "fail"). The mock host's
# document root is the mock-mode build (/srv/<front>-mock = frontend-angular/dist-mock); the other hosts keep
# /srv/<front> (the production build). Rewritten here, at start, so the shared template stays the single source of
# every other rule (CSP, headers, caching, /_ds). Idempotent: a template that already accepts `mock` keeps its host
# rule; the root rewrite applies only to the template's plain `root /srv/$front;`.
set -eu
t=/etc/nginx/templates/nginx.conf.template
sed \
  -e 's/django|laravel)/django|laravel|mock)/g' \
  -e 's|^\(\s*\)root /srv/\$front;|\1root /srv/$front_root;|' \
  -e 's|^\(\s*\)# --- SPA hosts: |\1map $host $front_root {\n\1  ~^(?<fr>react\|angular\|svelte)-mock\.localhost$ ${fr}-mock;\n\1  default $front;\n\1}\n\n\1# --- SPA hosts: |' \
  "$t" > /tmp/nginx.conf.template
mv /tmp/nginx.conf.template "$t"
grep -q 'laravel|mock)' "$t" || { echo "gateway-angular: mock host not accepted by the template" >&2; exit 1; }
grep -q 'root /srv/\$front_root;' "$t" || { echo "gateway-angular: mock document root not set" >&2; exit 1; }
exec /docker-entrypoint.sh nginx -g 'daemon off;'
