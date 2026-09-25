# syntax=docker/dockerfile:1
# One image, three processes (spec 8.1): the command picks the entrypoint —
#   node dist/main-api.js | node dist/main-worker.js | node dist/main-scheduler.js
# Build context: the repository root (workspace packages @agrotrace/domain, @agrotrace/validation and the contract are
# bundled into dist/ by build.mjs); Dockerfile.dockerignore next to this file trims the context.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
# Non-interactive pnpm (no "remove modules directories?" prompt).
ENV CI=true
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
# Tarballs from the lockfile alone, cached across builds (.npmrc: store-dir=/pnpm/store).
RUN --mount=type=cache,id=agrotrace-pnpm-store,target=/pnpm/store pnpm fetch

FROM base AS build
COPY . .
RUN --mount=type=cache,id=agrotrace-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@agrotrace/backend-express..."
RUN pnpm --filter @agrotrace/backend-express build

# Production dependencies only, exactly as locked: the npm packages dist/ imports (esbuild keeps them external).
FROM base AS prod-deps
COPY . .
RUN --mount=type=cache,id=agrotrace-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --prod --filter @agrotrace/backend-express

FROM node:22-alpine
RUN addgroup -S agrotrace && adduser -S agrotrace -G agrotrace
WORKDIR /app
# backend-express/node_modules links into /app/node_modules/.pnpm — the same layout as in the repo.
COPY --from=prod-deps /repo/node_modules /app/node_modules
COPY --from=prod-deps /repo/backend-express/node_modules /app/backend-express/node_modules
COPY --from=prod-deps /repo/backend-express/package.json /app/backend-express/package.json
COPY --from=build /repo/backend-express/dist /app/backend-express/dist
WORKDIR /app/backend-express
ENV NODE_ENV=production \
    PORT=8000
USER agrotrace
EXPOSE 8000
CMD ["node", "--enable-source-maps", "dist/main-api.js"]
