# syntax=docker/dockerfile:1
# One image, three processes (spec 8.1, plan 3): the command picks the process —
#   python -m agrotrace.serve (api: uvicorn) | celery … worker (worker) | celery … beat (beat)
# Build context: the repository root; Dockerfile.dockerignore next to this file trims it. The node stage bundles the
# contract (contracts/dist/openapi.json) and takes the Swagger UI assets and the Onest font from the lockfile; the
# python stage installs the pinned requirements (runtime AND dev: the django:test hook runs pytest + ruff in this
# image, D-M5).

FROM node:22-alpine AS node
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
ENV CI=true
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=agrotrace-pnpm-store,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=agrotrace-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter @agrotrace/contracts --filter @agrotrace/backend-express
RUN pnpm --filter @agrotrace/contracts bundle \
 && mkdir -p /out/swagger-ui /out/fonts \
 && cp -r "$(dirname "$(cd backend-express && node -p "require.resolve('swagger-ui-dist/package.json')")")"/. /out/swagger-ui/ \
 && cp -r "$(dirname "$(cd backend-express && node -p "require.resolve('@fontsource/onest/package.json')")")"/files /out/fonts/onest

FROM python:3.12-slim
# Pango/HarfBuzz for WeasyPrint (QR label PDF, Task 6).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
 && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/backend-django
COPY backend-django/requirements.txt backend-django/requirements-dev.txt ./
RUN pip install -r requirements.txt -r requirements-dev.txt
RUN groupadd -r agrotrace && useradd -r -g agrotrace -d /app agrotrace
COPY --from=node /repo/contracts/dist/openapi.json /app/contracts/dist/openapi.json
COPY --from=node /out/swagger-ui /app/assets/swagger-ui
COPY --from=node /out/fonts /app/assets/fonts
COPY contracts/rules /app/contracts/rules
COPY contracts/events /app/contracts/events
COPY infra/rabbitmq/definitions.json /app/infra/rabbitmq/definitions.json
COPY packages/i18n/locales /app/packages/i18n/locales
COPY backend-django /app/backend-django
ENV DJANGO_SETTINGS_MODULE=agrotrace.settings \
    AGROTRACE_ROOT=/app
USER agrotrace
EXPOSE 8000
CMD ["python", "-m", "agrotrace.serve"]
