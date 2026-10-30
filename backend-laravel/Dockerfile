# syntax=docker/dockerfile:1
# AgroTrace backend on Laravel 11 (Plan 5): one image, three processes (spec 8.1, 14.4) —
#   api-laravel        supervisord: FrankenPHP with the Octane workers (docker/Caddyfile) behind HAProxy :8000
#   worker-laravel     consumers + Telegram poller (Plan 5 Tasks 6, 12)
#   scheduler-laravel  the job processes (Plan 5 Task 9, L5)
# Build context: the repository root (contracts/ and pnpm-lock.yaml are needed); Dockerfile.dockerignore next to
# this file trims it. Stages: contract (the bundled contract + swagger-ui-dist of the lockfile), base (FrankenPHP +
# PHP extensions + composer), dev (php-tools: pcov, the repository mounted), vendor (composer install), prod.

# ── contract: contracts/openapi.yaml → openapi.json (the same redocly bundle as tests/api and Express) and the exact
# swagger-ui-dist version of pnpm-lock.yaml (the one Express serves). ─────────────────────────────────────────────────
FROM node:22-alpine AS contract
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
ENV CI=true
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=agrotrace-pnpm-store,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=agrotrace-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --ignore-scripts \
      --filter @agrotrace/contracts --filter @agrotrace/backend-express
RUN pnpm --filter @agrotrace/contracts bundle \
 && mkdir -p /out/swagger \
 && cp contracts/dist/openapi.json /out/openapi.json \
 && cd backend-express/node_modules/swagger-ui-dist \
 && cp package.json swagger-ui.css swagger-ui-bundle.js swagger-ui-standalone-preset.js favicon-32x32.png /out/swagger/ \
 && mkdir -p /out/fonts/onest /out/fonts/jetbrains-mono \
 && cp -rL /repo/backend-express/node_modules/@fontsource/onest/files /out/fonts/onest/ \
 && cp -rL /repo/backend-express/node_modules/@fontsource/jetbrains-mono/files /out/fonts/jetbrains-mono/

# ── base: FrankenPHP (PHP 8.3 ZTS) with the extensions of the plan's tech stack. ────────────────────────────────────
FROM dunglas/frankenphp:1.4.4-php8.3-bookworm AS base
RUN install-php-extensions bcmath pcntl gd pdo_pgsql sockets zip opcache
# HAProxy: the thin front of api-laravel (docker/haproxy-api.cfg); supervisor runs it with FrankenPHP.
RUN apt-get update && apt-get install -y --no-install-recommends haproxy supervisor && rm -rf /var/lib/apt/lists/*
# PECL extensions pinned (apcu and pcov from their GitHub sources: pecl.php.net times out intermittently).
RUN install-php-extensions krakjoe/apcu@v5.1.24
RUN install-php-extensions redis-6.1.0
COPY --from=composer:2.8.1 /usr/bin/composer /usr/bin/composer
COPY backend-laravel/docker/php.ini /usr/local/etc/php/conf.d/zz-agrotrace.ini
ENV COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_HOME=/tmp/composer TZ=UTC
WORKDIR /app

# ── dev: the php-tools service (docker-compose.yml, profile tools): composer, pest with coverage, pint, larastan over
# the mounted repository (/repo/backend-laravel, vendor in the laravel-vendor volume). ────────────────────────────────
FROM base AS dev
RUN install-php-extensions krakjoe/pcov@v1.0.12
RUN apt-get update && apt-get install -y --no-install-recommends git unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/backend-laravel

# ── vendor: production dependencies exactly as locked. ──────────────────────────────────────────────────────────────
FROM base AS vendor
COPY backend-laravel/composer.json backend-laravel/composer.lock /app/
RUN --mount=type=cache,id=agrotrace-composer,target=/tmp/composer/cache \
    composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction --no-progress
COPY backend-laravel/ /app/
RUN composer dump-autoload --optimize --classmap-authoritative --no-dev --no-interaction \
 && rm -rf /app/tests /app/docker/*.md

# ── prod: the image of api-laravel, worker-laravel and scheduler-laravel. ───────────────────────────────────────────
FROM base AS prod
COPY --from=vendor /app /app
COPY --from=contract /out/openapi.json /app/resources/contract/openapi.json
COPY --from=contract /out/swagger /app/resources/swagger/dist
COPY contracts/rules /app/resources/contract/rules
# The `mail.*` templates (and the notification texts, Task 12) of packages/i18n (App\Infrastructure\I18n\Messages).
COPY packages/i18n/locales/ru.json /app/resources/i18n/ru.json
# The QR label fonts (Onest, JetBrains Mono: the @fontsource WOFF files Express embeds), converted for TCPDF once here.
COPY --from=contract /out/fonts /app/resources/fonts
ENV PDF_FONT_CACHE=/app/resources/fonts-tcpdf
# An empty .env: every setting comes from the environment (compose `env_file` + `environment`).
RUN touch .env \
 && mkdir -p storage/framework/cache storage/framework/views storage/logs bootstrap/cache /data/caddy /config/caddy \
 && php artisan agrotrace:fonts \
 && chown -R www-data:www-data storage bootstrap/cache /data /config \
 && chmod +x docker/entrypoint.sh
ENV APP_ENV=production APP_DEBUG=false AGROTRACE_PROCESS=api
USER www-data
EXPOSE 8000 9464
# The base image checks Caddy's admin endpoint, which only api runs (and with admin off): compose defines api-laravel's.
HEALTHCHECK NONE
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["supervisord", "-c", "/app/docker/supervisord-api.conf"]
