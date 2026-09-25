# Deployment guide

Local/dev deployment of AgroTrace. Every command runs inside Docker Compose through `./at.sh`
(bash) or `./at.ps1` (PowerShell, forwards to `at.sh`) — nothing needs to be installed on the host
beyond the two prerequisites below.

## Prerequisites

- **Docker Desktop** (or a compatible Docker Engine + Compose v2). `docker compose version`
  should report Compose v2.
- **Git**.

No Node.js, pnpm, Python, PHP or make is required on the host; all of that lives inside the
`tools` image (`tools/node.Dockerfile`: node:22-alpine + pnpm 9.15) and the other service images.

## First run

```bash
git clone <repo-url> && cd agrotrace
./at.sh install       # also creates .env from .env.example, if .env doesn't exist yet
./at.sh up infra      # postgres, redis, rabbitmq, minio (+ minio-init), mailpit
./at.sh db:migrate
./at.sh seed
./at.sh up gateway
```

Open **http://localhost:${GATEWAY_PORT}/** (`GATEWAY_PORT` defaults to `80`, see below).

## `.env` variables

`.env` is created once, automatically, from `.env.example` (`./at.sh` does this on first
invocation: `[ -f .env ] || cp .env.example .env`) and is git-ignored — edit your local copy
freely, it's never committed.

| Variable                          | Meaning                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`                   | Superuser Postgres starts with (`postgres` service `POSTGRES_USER`) — also the dbmate/owner role, `agrotrace_owner`. Owns the schema and runs migrations.                                                                                                                                             |
| `POSTGRES_PASSWORD`               | Password for `POSTGRES_USER`.                                                                                                                                                                                                                                                                         |
| `POSTGRES_DB`                     | Name of the default (dev) database Postgres creates on first start: `agrotrace`.                                                                                                                                                                                                                      |
| `APP_DB_USER`                     | Documents the least-privilege application role name (`agrotrace_app`, `SELECT/INSERT/UPDATE/DELETE` + sequence/function grants — see `infra/postgres/init/01-roles.sql`). Not read by any script directly; kept in sync by hand with the hardcoded password in that file and with `APP_DATABASE_URL`. |
| `APP_DB_PASSWORD`                 | Same role as above, for the password.                                                                                                                                                                                                                                                                 |
| `DATABASE_URL`                    | Owner connection string (`agrotrace_owner`) — used by dbmate for migrations and by `./at.sh` for admin operations (`recreate_db`, `dump_schema`).                                                                                                                                                     |
| `APP_DATABASE_URL`                | App-role connection string (`agrotrace_app`) — what a backend service (added by later plans) or a test suite connects with at runtime, least-privilege.                                                                                                                                               |
| `REDIS_URL`                       | Redis connection string: session/idempotency cache, rate limits, public-page cache. Also flushed by `./at.sh seed`.                                                                                                                                                                                   |
| `RABBITMQ_URL`                    | AMQP connection string (user/vhost from `infra/rabbitmq/definitions.json`) — queue a later plan's worker/scheduler will consume.                                                                                                                                                                      |
| `S3_ENDPOINT`                     | MinIO's S3-compatible API endpoint, used for all file storage (avatars, logos, product photos, lab protocols, QR codes, reports).                                                                                                                                                                     |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | MinIO credentials (`minio` service `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`; also used to sign requests to `S3_ENDPOINT`).                                                                                                                                                                             |
| `S3_BUCKET`                       | Bucket name `minio-init` creates and everything else uploads into: `agrotrace`.                                                                                                                                                                                                                       |
| `SMTP_HOST` / `SMTP_PORT`         | Mailpit's SMTP listener — where a later plan's backend sends mail; view what was sent at the Mailpit web UI (below).                                                                                                                                                                                  |
| `JWT_SECRET`                      | Symmetric secret for signing access/refresh tokens (a later plan's auth). The example value is dev-only — replace it for anything beyond a local demo.                                                                                                                                                |
| `TELEGRAM_BOT_TOKEN`              | Reserved for a later plan's Telegram notification channel. Empty by default (feature disabled).                                                                                                                                                                                                       |
| `DADATA_API_KEY`                  | Reserved for a later plan's DaData address/INN lookup integration. Empty by default.                                                                                                                                                                                                                  |
| `YANDEX_MAPS_API_KEY`             | Reserved for a later plan's field-map view (Yandex Maps). Empty by default.                                                                                                                                                                                                                           |
| `MERCURY_URL`                     | Where a later plan's backend reaches the `mercury-mock` emulator of the external «Меркурий» veterinary system.                                                                                                                                                                                        |
| `PUBLIC_BASE_URL`                 | Base URL the seed generator (and later, backends) use to build absolute links (e.g. a batch's public QR page). Defaults to one of the 9 combinations, `http://react-express.localhost`.                                                                                                               |
| `GATEWAY_PORT`                    | Host port the gateway's nginx (container port 80) is published on, and the value it reports back to clients as `X-Forwarded-Port`. Default `80`; override when 80 is already taken (see Troubleshooting).                                                                                             |

## `./at.sh` commands

`./at` is the same script (`./at up react django`); on Windows use `at.cmd` (cmd.exe) or `./at.ps1` (PowerShell) — both run `at.sh` with Git Bash resolved from `git` itself, never the WSL `bash`.

| Command                 | What it does                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./at.sh install`       | `pnpm install` inside the `tools` container (creates `.env` on first run).                                                                                                                                                                                                                                                         |
| `./at.sh sh`            | Opens an interactive shell in the `tools` container.                                                                                                                                                                                                                                                                               |
| `./at.sh pnpm <args…>`  | Runs an arbitrary `pnpm` command in the `tools` container, e.g. `./at.sh pnpm --filter @agrotrace/domain test`.                                                                                                                                                                                                                    |
| `./at.sh test` | Unit tests of every workspace package outside `tests/*` (contracts, domain, api-client, validation, i18n, design-system, mercury-mock, backend-express, and the seed's unit suite). The `tests/*` packages need live services and run only through their own commands (`db:test`, `gw:test`, `ds:test`, `api:test`). |
| `./at.sh at:test` | Tests of the command wrappers (`tests/at`): `./at`, `at.cmd`, `at.ps1`, `help`, and `up <front> <back>` in `AT_DRY_RUN=1` mode. |
| `./at.sh test:all` | Everything in dependency order: `test` → `at:test` → `up infra` → `db:test` → `db:migrate` → `seed:test` → `api:test express --reset` → `api:test express --ratelimits` → `up gateway` → `gw:test` → `docs:test express` → `ds:test`. |
| `./at.sh lint`          | Runs the repo-wide ESLint flat config (`eslint .`) once — it already covers every package in one pass.                                                                                                                                                                                                                             |
| `./at.sh typecheck`     | `pnpm -r typecheck` — `tsc --noEmit` in every package that defines that script.                                                                                                                                                                                                                                                    |
| `./at.sh fmt`           | Formats the whole repo with Prettier.                                                                                                                                                                                                                                                                                              |
| `./at.sh up` / `up all` | Builds (see below) and starts every service.                                                                                                                                                                                                                                                                                       |
| `./at.sh up infra`      | Builds and starts postgres, redis, rabbitmq, minio, mailpit and mercury-mock, then runs `minio-init` (creates the `agrotrace` bucket).                                                                                                                                                                                                              |
| `./at.sh up gateway`    | Builds and starts just the gateway, then prints the URL to open. The gateway needs no backend running — it resolves `api-<backend>` at request time.                                                                                                                                                                               |
| `./at.sh up <front> <back>` | One combination (spec §14.4), e.g. `./at up react django`: `up infra`, then the backend's services (`api-*`, `worker-*`, and `beat-django` / `scheduler-laravel`) plus the gateway; prints `http://<front>-<back>.localhost:<GATEWAY_PORT>/`. Fails with a clear message while a backend's services are not in `docker-compose.yml` yet; `AT_DRY_RUN=1` prints the docker commands instead. |
| `./at.sh up <back>` | `up infra`, then one backend's three processes without the gateway, e.g. `./at up express` → `api-express` (port 8000 inside the `at` network, healthcheck `/api/v1/health/live`), `worker-express`, `scheduler-express` — one image, three commands. |
| `./at.sh api:test [back] [--reset] [--ratelimits] [vitest args…]` | Runs `tests/api` — the HTTP contract suite shared by the three backends — against `api-<back>` (default `express`; `API_URL`/`API_BACKEND` are set for it). Starts infra and the backend first; `--reset` reloads the demo data (`./at.sh reset`) before the run. Every response is validated against the bundled contract. By default `api-<back>` runs for the suite with the api-test overrides (`docker-compose.api-test.yml`: `RATE_LIMIT_OVERRIDES`, P10) and is restored afterwards; the `[ratelimit]` tests are skipped. `--ratelimits` runs only those tests, against the backend without overrides. |
| `./at.sh gen:db-types` | Regenerates the Express backend's Kysely types (`backend-express/src/db/types.generated.ts`, kysely-codegen) from a freshly migrated `agrotrace_test`; `db:test` fails while the committed file is stale. |
| `./at.sh down [-v]`     | `docker compose down`; `-v` also removes this project's named volumes (`agrotrace_pgdata`, `agrotrace_miniodata`, `agrotrace_pnpm-store`) — never another project's.                                                                                                                                                               |
| `./at.sh db:migrate`    | Applies every pending migration (dbmate) to the dev database, then regenerates `db/schema.sql` from a throwaway database that replays all migrations from scratch (never from the dev database's own possibly-drifted state).                                                                                                      |
| `./at.sh db:rollback`   | Rolls back the dev database's most recent migration.                                                                                                                                                                                                                                                                               |
| `./at.sh db:new <name>` | Scaffolds a new dbmate migration file under `db/migrations/`.                                                                                                                                                                                                                                                                      |
| `./at.sh db:test`       | Recreates `agrotrace_test` from scratch, migrates it, and runs `tests/db`. `tests/db` refuses any database whose name does not end in `_test`.                                                                                                                                                                                                                                                         |
| `./at.sh seed` | Loads the demo world into the dev database + MinIO + Redis. Idempotent for a given `SEED_NOW` (env, ISO minute; defaults to now). Never writes tracked files. |
| `./at.sh seed:docs` | Regenerates `docs/demo-accounts.md` from the demo story at its fixed REFERENCE_NOW (codes of that year; the header explains the launch-year codes). No database needed. |
| `./at.sh seed:test`     | Seeds with `SEED_NOW` pinned, checks the result (Postgres + MinIO), seeds again with the same `SEED_NOW` and asserts the second run is byte-identical.                                                                                                                                                                             |
| `./at.sh reset`         | Rolls the dev database back to zero migrations, migrates back up, then seeds — a clean slate without recreating the database/containers.                                                                                                                                                                                           |
| `./at.sh ds:test`       | Runs the design-system showcase's Playwright suite (visual + accessibility) inside the `playwright` Compose service.                                                                                                                                                                                                               |
| `./at.sh docs:test [back]` | Starts the backend (default `express`) and the gateway, then checks in the `playwright` service (Chromium, network `at`) that `http://react-<back>.localhost/api/v1/docs` renders Swagger UI under the gateway's CSP with no console error, CSP violation or request to another origin (`tests/ds/api-docs`). |
| `./at.sh gw:test`       | Brings up the `gwtest`-profile stub backend (a running `api-express` is stopped for the run and started again), checks the gateway's _loaded_ nginx config (`nginx -T`) for a couple of invariants, runs `tests/gateway`, then tears the stub down — pass or fail. Requires `./at.sh up gateway` first.                                                                                               |
| `./at.sh psql`          | Opens `psql` against the dev database as `agrotrace_owner`.                                                                                                                                                                                                                                                                        |
| `./at.sh check`         | Quick liveness check of postgres, redis, rabbitmq and the minio, mailpit and mercury-mock HTTP endpoints.                                                                                                                                                                                                                                                |

`./at.sh up` (any form) always passes `--build`, so a stale image is never silently reused —
harmless for services without a `build:` key (postgres, redis, rabbitmq, minio, mailpit).

## Service URLs and ports

| Service                | URL                                                                                 | Notes                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Gateway / start page   | `http://localhost:${GATEWAY_PORT}/`                                                 | All 9 frontend×backend combinations, linked from the start page.                                                                   |
| Design-system showcase | `http://localhost:${GATEWAY_PORT}/_ds/`                                             | Tokens, components, icons, illustrations.                                                                                          |
| A specific combination | `http://{react,angular,svelte}-{express,django,laravel}.localhost:${GATEWAY_PORT}/` | `*.localhost` resolves to 127.0.0.1 without any hosts-file edit on every major OS/browser.                                         |
| Mailpit (web UI)       | `http://localhost:8025/`                                                            | Every email a backend sends lands here — nothing leaves the machine. SMTP itself is on `1025`.                                     |
| MinIO console          | `http://localhost:9001/`                                                            | Log in with `S3_ACCESS_KEY` / `S3_SECRET_KEY` from `.env`. S3 API itself is on `9000`.                                             |
| RabbitMQ management UI | `http://localhost:15672/`                                                           | Log in with the user from `infra/rabbitmq/definitions.json` (`agrotrace`) and `RABBITMQ_URL`'s password. AMQP itself is on `5672`. |
| Postgres               | `localhost:5432`                                                                    | `./at.sh psql`, or any client with `DATABASE_URL`/`APP_DATABASE_URL`.                                                              |
| Redis                  | `localhost:6379`                                                                    |                                                                                                                                    |

## Troubleshooting

**Port 80 is already in use.** Something else on the host (IIS, Skype, another gateway, …) is
often already bound to 80. Set `GATEWAY_PORT` in `.env` to a free port (e.g. `GATEWAY_PORT=8088`)
and re-run `./at.sh up gateway` — the start page URL it prints, and `X-Forwarded-Port` on every
proxied request, follow automatically.

**File changes aren't picked up on Windows.** Docker Desktop's bind mount of the repo into Linux
containers (9p on WSL2, or an older virtiofs/osxfs-style backend) can miss filesystem change
events that Linux-native file watchers rely on. A later plan's frontend dev servers therefore
watch in polling mode on Windows (`CHOKIDAR_USEPOLLING=1`, Vite's `server.watch.usePolling`,
Angular CLI's `--poll`, uvicorn's `WATCHFILES_FORCE_POLLING`) — see §14 of
[the spec](tz-agrotrace-v2.md). If a watcher still seems stuck, restarting the affected container
is the fallback.

**Changes don't show up after rebuilding.** `./at.sh up` (any form) always rebuilds
(`--build`), so this is rarely a stale-image problem — but if a container was started by hand
with plain `docker compose up` (no `--build`), do `./at.sh up <target>` once to force a rebuild,
or `./at.sh down` first for a clean start.

**Starting over.** `./at.sh down -v` removes this project's containers, network and named volumes
(`pgdata`, `miniodata`, `pnpm-store`) — never another project's, since they're all namespaced
under the `agrotrace` Compose project name. Follow it with the _First run_ steps above.
