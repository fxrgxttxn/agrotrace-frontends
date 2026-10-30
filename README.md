# AgroTrace

AgroTrace is a traceability system that follows agricultural products from field to shelf. It
links every participant of the food chain — farms, labs, processors, retailers, inspectors — into
one batch graph, and can recall unsafe product across that whole graph automatically. It is built
as three interchangeable frontends and three interchangeable backends over one shared PostgreSQL
schema and API contract, so the same product can be built and compared three different ways.

## Architecture: 3×3

- **Frontends** (SPA): React, Angular, Svelte.
- **Backends** (REST API + worker + scheduler): Express, Django, Laravel.
- Any frontend talks to any backend through the same OpenAPI contract
  (`contracts/openapi.yaml`) — 9 combinations in total, all running at once against the same
  database.
- An nginx **gateway** picks the combination by hostname
  (`{react,angular,svelte}-{express,django,laravel}.localhost`) and serves a start page at
  `http://localhost:${GATEWAY_PORT}/` linking to all 9.
- A shared **design system** (`packages/design-system`), served at `/_ds/`, and shared TypeScript
  packages (`domain`, `validation`, `i18n`, `api-client`) keep business rules and UI consistent
  across every implementation.

## Repository layout


```
agrotrace/
  contracts/          OpenAPI contract (openapi.yaml), BR-01…BR-11 rule vectors, event schemas
  db/
    migrations/        SQL migrations (dbmate)
    schema.sql         generated from the migrations — never edited by hand
    seed/               demo-world generator (./at.sh seed / seed:test)
  packages/
    domain/  validation/  i18n/  api-client/  design-system/
  gateway/             nginx routing, start page, gwtest stub upstream
  mercury-mock/        emulator of the external «Меркурий» veterinary system
  backend-express/     Express backend: api, worker, scheduler from one image
  backend-django/      Django backend: api (uvicorn), worker (Celery), beat
  backend-laravel/     Laravel backend: api (Octane/FrankenPHP), worker, scheduler
  frontend-react/  frontend-angular/  frontend-svelte/   the three SPAs
  tests/
    api/  cross/  e2e/  at/  db/  ds/  gateway/   shared suites: tests/api — the HTTP contract suite for every
                       backend; tests/cross — two backends on one DB; tests/e2e — Playwright on every front × backend
  infra/               postgres/rabbitmq/minio init and config
  docs/                spec, deploy guide, demo accounts, plans (docs/superpowers/plans/)
  .github/             CI (ci.yml) and its local composite actions
  docker-compose.yml  at  at.sh  at.cmd  at.ps1  .env.example
```

## Quick start

Requires only **Docker Desktop** and **Git** — no Node, pnpm, Python, PHP or make on the host.
Every command below runs inside Docker Compose via `./at.sh` (`./at` is the same script; on Windows —
`at.cmd` or `./at.ps1`, which run `at.sh` with Git Bash resolved from `git`, never WSL).

```bash
git clone <repo-url> && cd agrotrace
./at.sh install       # pnpm install (creates .env from .env.example on first run)
./at.sh up infra      # postgres, redis, rabbitmq, minio, mailpit, mercury-mock
./at.sh db:migrate    # applies db/migrations
./at.sh seed          # loads the demo world (accounts: docs/demo-accounts.md)
./at.sh up all        # builds the three frontends, starts the three backends and the gateway
```

Then open **http://localhost:${GATEWAY_PORT}/** (`${GATEWAY_PORT}` defaults to `80`; see
`.env`) — the start page links to all nine combinations:

| | Express | Django | Laravel |
|---|---|---|---|
| **React** | `react-express.localhost` | `react-django.localhost` | `react-laravel.localhost` |
| **Angular** | `angular-express.localhost` | `angular-django.localhost` | `angular-laravel.localhost` |
| **Svelte** | `svelte-express.localhost` | `svelte-django.localhost` | `svelte-laravel.localhost` |

All nine share one database: data entered through any of them is seen by all. `./at.sh reset` restores the demo
world. The design-system showcase is at `/_ds/`. One combination only: `./at.sh up <front> <back>`.

Tests across the matrix: `./at.sh e2e <front> <back>` (the shared Playwright suite against a real backend),
`./at.sh e2e:matrix` (all nine, each after a reset), `./at.sh cross:test <a> <b>` (two backends on one DB).
Known limitations of the final system: **[docs/known-limitations.md](docs/known-limitations.md)**.

For every other command (`test`, `lint`, `typecheck`, `db:test`, `seed:test`, `ds:test`,
`gw:test`, `reset`, `down`, …), service ports, environment variables and troubleshooting, see
**[docs/deploy.md](docs/deploy.md)**.

## Database benchmark (PostgreSQL vs Redis)

`benchmark/` is a stand-alone stand (compose project `agrotrace-bench`, no published ports; it never
touches the main stack) for the "Types of databases" lab (spec §13). One command reproduces it:

```bash
./at bench          # = ./at bench all (Windows: at.cmd bench / ./at.ps1 bench); about 90 minutes
```

It generates the data and runs the benchmark in 4 configurations × 3 repetitions from clean volumes.
The CSVs are published to `docs/reports/data/`, and the plots and the report tables are regenerated.
`./at bench help` lists the subcommands; `plot`, `report` and `lint` work without the stand up.
The report, in Russian: **[docs/reports/databases.md](docs/reports/databases.md)**.

## Documentation

- [Technical specification](docs/tz-agrotrace-v2.md) (`docs/tz-agrotrace-v2.md`) — the single
  source of truth for requirements and business rules.
- [Implementation plans](docs/superpowers/plans/) — one file per plan, in the order they're built.
- [Demo accounts and data](docs/demo-accounts.md) — generated by `./at.sh seed:docs`; every demo login,
  organization and the objects the defense scenario walks through.
- [Deployment guide](docs/deploy.md) — prerequisites, environment variables, all `./at.sh`
  commands, service URLs, troubleshooting.
- [Known limitations](docs/known-limitations.md) — what the final system deliberately leaves as is, and why.
