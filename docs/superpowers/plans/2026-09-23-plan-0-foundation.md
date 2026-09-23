# План 0 «Основа» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить общий фундамент AgroTrace, на который встанут 3 backend- и 3 frontend-реализации: репозиторий и инструменты в Docker, инфраструктура Compose, схема PostgreSQL, контракты (OpenAPI, правила, события), общие TS-пакеты, дизайн-система «Поле», эмулятор «Меркурия», seed, шлюз на 9 комбинаций, CI.

**Architecture:** Монорепозиторий pnpm. Всё выполняется в контейнерах через `./at <команда>`; на хосте нужны только Docker и Git. Схема БД — SQL-миграции dbmate. Контракты в `contracts/` — источник истины; `packages/domain` — эталонная TS-реализация бизнес-правил, проверяемая общими тест-векторами.

**Tech Stack:** Docker Compose, Node 22 + pnpm 9, TypeScript 5 (strict), Vitest, PostgreSQL 16, dbmate 2, Redis 7.4, RabbitMQ 3.13, MinIO, Mailpit, Nginx 1.27, Redocly CLI, openapi-typescript, openapi-fetch, Zod 3, Playwright + axe-core, sharp, argon2.

**Spec:** `docs/tz-agrotrace-v2.md`

## Global Constraints

- На хосте только Docker и Git; все команды — `./at <cmd>` (`at.sh`, `at.ps1`), выполняются в контейнерах.
- Node 22, pnpm 9.15.0, TypeScript `strict: true`, ESM (`"type": "module"`).
- PostgreSQL 16; миграции только dbmate в `db/migrations`; PK `uuid` через `gen_random_uuid()`; даты `timestamptz`; масса `numeric(12,3)`; статусы `varchar` + CHECK; soft delete `deleted_at`; `version integer` у batches, recall_tasks, recalls.
- Масса в JSON — строка с 3 знаками (`"12480.000"`); даты ISO 8601 с `Z`.
- Ошибки API — RFC 7807 с полями `code`, `rule`, `params`, `errors`.
- Хеш паролей — Argon2id PHC `$argon2id$v=19$m=65536,t=3,p=1$…`.
- Дизайн-система: только собственные CSS-классы `at-*`; UI-библиотеки запрещены; шрифты Geologica / Onest / JetBrains Mono self-hosted woff2; без неона, свечений, градиентов на поверхностях; анимации 120–150 мс, отключаются при `prefers-reduced-motion`.
- Интерфейсные тексты — без пояснительных подзаголовков и маркетинга; заголовок экрана — существительное.
- Контраст WCAG AA в обеих темах.
- Коммиты — Conventional Commits, в конце сообщения строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Десятичные массы на границах** (`"0.001"`, `"999999999.999"`, потери `0.00%` и `100.00%`) — баланс масс и расхождение должны считаться в целых граммах без ошибок округления; тесты в Task 7.
2. **Даты на границе суток и часовых поясов** — срок ожидания BR-01 при обработке в 23:30 UTC и отгрузке на следующий день; сравнение по датам UTC; тесты в Task 7.
3. **Повторная доставка `pg_notify` и транзакции** — уведомление, вставленное в откатившейся транзакции, не должно порождать NOTIFY; тест в Task 5.
4. **Пустые и вырожденные наборы** — анализ без показателей (FAIL нельзя, PASS нельзя → ошибка), отзыв без задач (закрывается сразу), переработка без выходов; тесты в Task 7.
5. **Отсутствующие сервисы за шлюзом** — хост комбинации, чей backend не запущен, должен отдавать frontend и 502 Problem JSON для `/api`, а не падать при старте nginx; тест в Task 21.

---

## Карта файлов

```
.gitignore .editorconfig .prettierrc.json .env.example
package.json pnpm-workspace.yaml tsconfig.base.json eslint.config.js
at.sh at.ps1
docker-compose.yml
tools/node.Dockerfile
infra/postgres/init/01-roles.sql
infra/minio/init.sh
db/migrations/2026092300000{1..6}_*.sql
db/seed/{package.json,tsconfig.json,src/*.ts,data/*.json,images/**,ATTRIBUTION.md}
contracts/openapi.yaml contracts/openapi/{paths,schemas}/*.yaml
contracts/rules/{state-machine.json,trust-rating.json,vector.schema.json,vectors/*.json}
contracts/events/*.schema.json
packages/domain/{package.json,src/*.ts,test/*.test.ts}
packages/api-client/{package.json,src/*.ts,test/*.test.ts}
packages/validation/{package.json,src/*.ts,test/*.test.ts}
packages/i18n/{package.json,src/*.ts,locales/{ru,en}.json,test/*.test.ts}
packages/design-system/{package.json,tokens.css,base.css,components/*.css,index.css,fonts/*,icons/*.svg,sprite.svg,illustrations/*.svg,showcase/index.html,scripts/*.ts,test/*.ts,README.md}
mercury-mock/{package.json,Dockerfile,src/*.ts,data/vsd.json,test/*.test.ts}
gateway/{Dockerfile,nginx.conf,start/index.html,placeholder/index.html}
tests/db/{package.json,vitest.config.ts,*.test.ts}
tests/ds/{package.json,playwright.config.ts,*.spec.ts}
tests/gateway/{package.json,*.test.ts}
.github/workflows/ci.yml
README.md docs/deploy.md docs/demo-accounts.md
```

---

### Task 1: Репозиторий и инструменты

**Files:**
- Create: `.gitignore`, `.editorconfig`, `.prettierrc.json`, `.env.example`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `at.sh`, `at.ps1`, `tools/node.Dockerfile`, `docker-compose.yml` (сервис `tools`), `README.md`

**Interfaces:**
- Produces: `./at install|sh|test|lint|fmt|<прочие добавляются в Task 2+>`; сервис Compose `tools` (рабочая папка `/repo`); `tsconfig.base.json` для всех TS-пакетов.

- [ ] **Step 1: git init и базовые файлы**

```bash
cd /c/project && git init -b main
```

`.gitignore`:
```
node_modules/
dist/
.svelte-kit/
.angular/
coverage/
*.log
.env
.superpowers/
test-results/
playwright-report/
benchmark/results/*.csv
!benchmark/results/.gitkeep
__pycache__/
.venv/
vendor/
storage/*.key
```

`.editorconfig`:
```
root = true
[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
[*.{py,php}]
indent_size = 4
[*.md]
trim_trailing_whitespace = false
```

`.gitattributes`:
```
* text=auto eol=lf
*.png binary
*.jpg binary
*.webp binary
*.woff2 binary
*.ps1 text eol=crlf
```

- [ ] **Step 2: tools-образ и Compose-сервис**

`tools/node.Dockerfile`:
```dockerfile
FROM node:22-alpine
RUN apk add --no-cache bash git postgresql16-client curl \
 && corepack enable && corepack prepare pnpm@9.15.0 --activate
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CHOKIDAR_USEPOLLING=1
WORKDIR /repo
```

`docker-compose.yml` (начальная версия):
```yaml
name: agrotrace
services:
  tools:
    build: { context: ., dockerfile: tools/node.Dockerfile }
    profiles: [tools]
    working_dir: /repo
    volumes:
      - .:/repo
      - pnpm-store:/pnpm/store
    env_file: [.env]
    networks: [at]
networks:
  at: {}
volumes:
  pnpm-store: {}
```

- [ ] **Step 3: `at.sh` / `at.ps1`**

`at.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
DC="docker compose"
T="$DC run --rm tools"
cmd="${1:-help}"; shift || true
case "$cmd" in
  install) $T pnpm install "$@" ;;
  sh)      $T bash ;;
  pnpm)    $T pnpm "$@" ;;
  test)    $T pnpm -r --workspace-concurrency=1 test "$@" ;;
  lint)    $T pnpm -r lint ;;
  fmt)     $T pnpm exec prettier --write . ;;
  help|*)  grep -E '^\s+[a-z:-]+\)' "$0" | sed 's/).*//' | tr -d ' ' ;;
esac
```

`at.ps1`:
```powershell
$ErrorActionPreference = 'Stop'
& bash "$PSScriptRoot/at.sh" @args
exit $LASTEXITCODE
```

- [ ] **Step 4: workspace и TS-база**

`package.json`:
```json
{
  "name": "agrotrace",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "scripts": { "lint": "eslint .", "fmt": "prettier --write ." },
  "devDependencies": {
    "typescript": "~5.6.3",
    "vitest": "^2.1.4",
    "eslint": "^9.14.0",
    "typescript-eslint": "^8.13.0",
    "prettier": "^3.3.3",
    "@types/node": "^22.9.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - db/seed
  - mercury-mock
  - tests/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": false,
    "esModuleInterop": true, "skipLibCheck": true, "resolveJsonModule": true,
    "declaration": true, "sourceMap": true, "isolatedModules": true, "verbatimModuleSyntax": true
  }
}
```

`eslint.config.js`:
```js
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.svelte-kit/**', '**/.angular/**', 'contracts/**'] },
  ...tseslint.configs.recommended,
);
```

`.prettierrc.json`: `{ "singleQuote": true, "printWidth": 110, "trailingComma": "all" }`

`.env.example`:
```
POSTGRES_USER=agrotrace_owner
POSTGRES_PASSWORD=owner_dev_pw
POSTGRES_DB=agrotrace
APP_DB_USER=agrotrace_app
APP_DB_PASSWORD=app_dev_pw
DATABASE_URL=postgres://agrotrace_owner:owner_dev_pw@postgres:5432/agrotrace?sslmode=disable
APP_DATABASE_URL=postgres://agrotrace_app:app_dev_pw@postgres:5432/agrotrace
REDIS_URL=redis://redis:6379/0
RABBITMQ_URL=amqp://agrotrace:rabbit_dev_pw@rabbitmq:5672/
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=agrotrace
S3_SECRET_KEY=minio_dev_pw
S3_BUCKET=agrotrace
SMTP_HOST=mailpit
SMTP_PORT=1025
JWT_SECRET=dev_only_change_me_32_bytes_minimum_xx
TELEGRAM_BOT_TOKEN=
DADATA_API_KEY=
YANDEX_MAPS_API_KEY=
MERCURY_URL=http://mercury-mock:8080
PUBLIC_BASE_URL=http://react-express.localhost
```

- [ ] **Step 5: Проверка**

Run: `./at install` → Expected: pnpm создаёт lockfile, без ошибок.
Run: `./at pnpm exec tsc -v` → Expected: `Version 5.6.x`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: bootstrap monorepo tooling in docker"
```

---

### Task 2: Инфраструктура Compose

**Files:**
- Modify: `docker-compose.yml`, `at.sh`
- Create: `infra/postgres/init/01-roles.sql`, `infra/minio/init.sh`, `infra/rabbitmq/definitions.json`, `infra/rabbitmq/rabbitmq.conf`

**Interfaces:**
- Produces: сервисы `postgres` (5432), `redis` (6379), `rabbitmq` (5672/15672), `minio` (9000/9001), `mailpit` (1025/8025), `dbmate`; роли БД `agrotrace_owner`, `agrotrace_app`; bucket `agrotrace`; vhost `/`, пользователь `agrotrace`; exchanges `agrotrace.express|django|laravel` (topic) и очереди `agrotrace.<impl>.jobs`.
- `./at up infra`, `./at down`, `./at db:migrate`, `./at db:rollback`, `./at db:new <name>`, `./at psql`, `./at check infra`.

- [ ] **Step 1: Роли БД**

`infra/postgres/init/01-roles.sql`:
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agrotrace_app') THEN
    CREATE ROLE agrotrace_app LOGIN PASSWORD 'app_dev_pw';
  END IF;
END $$;
GRANT CONNECT ON DATABASE agrotrace TO agrotrace_app;
GRANT USAGE ON SCHEMA public TO agrotrace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agrotrace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agrotrace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO agrotrace_app;
```

- [ ] **Step 2: Сервисы**

Добавить в `docker-compose.yml`:
```yaml
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes: [pgdata:/var/lib/postgresql/data, ./infra/postgres/init:/docker-entrypoint-initdb.d:ro]
    ports: ["5432:5432"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"], interval: 3s, retries: 20 }
    networks: [at]
  dbmate:
    image: ghcr.io/amacneil/dbmate:2
    profiles: [tools]
    environment: { DATABASE_URL: "${DATABASE_URL}", DBMATE_MIGRATIONS_DIR: /db/migrations, DBMATE_SCHEMA_FILE: /db/schema.sql }
    volumes: [./db:/db]
    depends_on: { postgres: { condition: service_healthy } }
    networks: [at]
  redis:
    image: redis:7.4-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports: ["6379:6379"]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 3s, retries: 20 }
    networks: [at]
  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    volumes:
      - ./infra/rabbitmq/rabbitmq.conf:/etc/rabbitmq/rabbitmq.conf:ro
      - ./infra/rabbitmq/definitions.json:/etc/rabbitmq/definitions.json:ro
    ports: ["5672:5672", "15672:15672"]
    healthcheck: { test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"], interval: 5s, retries: 30 }
    networks: [at]
  minio:
    image: minio/minio:RELEASE.2024-10-13T13-34-11Z
    command: server /data --console-address :9001
    environment: { MINIO_ROOT_USER: "${S3_ACCESS_KEY}", MINIO_ROOT_PASSWORD: "${S3_SECRET_KEY}" }
    volumes: [miniodata:/data]
    ports: ["9000:9000", "9001:9001"]
    healthcheck: { test: ["CMD", "mc", "ready", "local"], interval: 3s, retries: 20 }
    networks: [at]
  minio-init:
    image: minio/mc:RELEASE.2024-10-08T09-37-26Z
    entrypoint: ["/bin/sh", "/init.sh"]
    environment: { S3_ACCESS_KEY: "${S3_ACCESS_KEY}", S3_SECRET_KEY: "${S3_SECRET_KEY}", S3_BUCKET: "${S3_BUCKET}" }
    volumes: [./infra/minio/init.sh:/init.sh:ro]
    depends_on: { minio: { condition: service_healthy } }
    networks: [at]
  mailpit:
    image: axllent/mailpit:v1.21
    ports: ["8025:8025", "1025:1025"]
    networks: [at]
```
и тома `pgdata`, `miniodata`.

`infra/minio/init.sh`:
```sh
set -e
mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
mc mb --ignore-existing "local/$S3_BUCKET"
mc anonymous set none "local/$S3_BUCKET"
```

`infra/rabbitmq/rabbitmq.conf`:
```
load_definitions = /etc/rabbitmq/definitions.json
```

`infra/rabbitmq/definitions.json` — пользователь `agrotrace`/`rabbit_dev_pw` (tag administrator; `password_hash` генерируется `rabbitmqctl hash_password` при выполнении шага и вставляется), vhost `/`, permissions `.*`, exchanges `agrotrace.express`, `agrotrace.django`, `agrotrace.laravel` (type `topic`, durable), очереди `agrotrace.express.jobs`, `agrotrace.django.jobs`, `agrotrace.laravel.jobs` (durable, `x-queue-type: quorum`) + dead-letter очереди `*.dlq`, bindings `#` exchange → своя очередь.

- [ ] **Step 3: Команды `at`**

Добавить в `at.sh`:
```bash
  up)
    case "${1:-all}" in
      infra) $DC up -d --wait postgres redis rabbitmq minio mailpit && $DC up minio-init ;;
      *) $DC up -d --wait ;;
    esac ;;
  down)        $DC down "$@" ;;
  db:migrate)  $DC run --rm dbmate --wait up ;;
  db:rollback) $DC run --rm dbmate rollback ;;
  db:new)      $DC run --rm dbmate new "$1" ;;
  psql)        $DC exec postgres psql -U agrotrace_owner agrotrace ;;
  check)
    $DC exec -T postgres pg_isready -U agrotrace_owner && \
    $DC exec -T redis redis-cli ping && \
    $DC exec -T rabbitmq rabbitmq-diagnostics -q check_running && \
    $T sh -c 'curl -fsS http://minio:9000/minio/health/live && curl -fsS http://mailpit:8025/livez' && echo "infra ok" ;;
```

- [ ] **Step 4: Проверка**

Run: `./at up infra && ./at check infra`
Expected: последняя строка `infra ok`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(infra): postgres, redis, rabbitmq, minio, mailpit in compose"
```

---

### Task 3: Миграции — функции, справочники, файлы, IAM

**Files:**
- Create: `db/migrations/20260923000001_helpers.sql`, `…000002_dictionaries.sql`, `…000003_iam.sql`
- Create: `tests/db/package.json`, `tests/db/vitest.config.ts`, `tests/db/helpers.ts`, `tests/db/iam.test.ts`
- Modify: `at.sh` (`db:test`)

**Interfaces:**
- Produces: таблицы `regions, products, substances, indicators, norms, files, organizations, users, roles, user_roles, refresh_tokens`; функция `touch_updated_at()`; тестовый helper `withTx(fn)` (открывает транзакцию под `agrotrace_app`, откатывает после теста), `q(sql, params)`.

- [ ] **Step 1: Тестовый харнесс**

`tests/db/package.json`:
```json
{ "name": "@agrotrace/tests-db", "private": true, "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": { "pg": "^8.13.1", "@types/pg": "^8.11.10", "vitest": "^2.1.4" } }
```

`tests/db/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { fileParallelism: false, testTimeout: 15000 } });
```

`tests/db/helpers.ts`:
```ts
import pg from 'pg';
export const appPool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
export const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL?.replace('?sslmode=disable', '') });

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

export async function expectPgError(p: Promise<unknown>, code: string) {
  try { await p; } catch (e) { if ((e as { code?: string }).code === code) return; throw e; }
  throw new Error(`expected pg error ${code}`);
}

export async function insertOrg(c: pg.PoolClient, type = 'FARM', inn = String(Date.now()).slice(-10)) {
  const r = await c.query(
    `INSERT INTO organizations(type, name, inn, region_id, status)
     VALUES ($1, 'Тест', $2, (SELECT id FROM regions LIMIT 1), 'ACTIVE') RETURNING id`, [type, inn]);
  return r.rows[0].id as string;
}
```

`at.sh`: `db:test) $T pnpm --filter @agrotrace/tests-db test ;;`

- [ ] **Step 2: Написать падающие тесты**

`tests/db/iam.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { withTx, expectPgError, insertOrg } from './helpers';

describe('iam schema', () => {
  it('generates uuid and timestamps for organizations', () => withTx(async (c) => {
    const id = await insertOrg(c);
    const r = await c.query('SELECT id, created_at, updated_at, trust_rating, deleted_at FROM organizations WHERE id=$1', [id]);
    expect(r.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.rows[0].trust_rating).toBe(80);
    expect(r.rows[0].deleted_at).toBeNull();
  }));

  it('rejects unknown organization type', () => withTx(async (c) => {
    await expectPgError(insertOrg(c, 'BANK'), '23514');
  }));

  it('enforces unique inn', () => withTx(async (c) => {
    await insertOrg(c, 'FARM', '3300000001');
    await expectPgError(insertOrg(c, 'LAB', '3300000001'), '23505');
  }));

  it('touches updated_at on update', () => withTx(async (c) => {
    const id = await insertOrg(c);
    await c.query(`UPDATE organizations SET updated_at = '2000-01-01Z' WHERE id=$1`, [id]);
    await c.query(`UPDATE organizations SET name='Другое' WHERE id=$1`, [id]);
    const r = await c.query('SELECT updated_at = now() AS touched FROM organizations WHERE id=$1', [id]);
    expect(r.rows[0].touched).toBe(true);
  }));

  it('enforces case-insensitive unique email', () => withTx(async (c) => {
    const org = await insertOrg(c);
    const ins = (email: string) => c.query(
      `INSERT INTO users(organization_id, email, password_hash, full_name, status) VALUES ($1,$2,'x','Иванов И.И.','ACTIVE')`, [org, email]);
    await ins('A@b.ru');
    await expectPgError(ins('a@B.ru'), '23505');
  }));

  it('seeds 6 roles', () => withTx(async (c) => {
    const r = await c.query('SELECT code FROM roles ORDER BY code');
    expect(r.rows.map((x) => x.code)).toEqual(['ADMIN', 'FARMER', 'INSPECTOR', 'LAB', 'PROCESSOR', 'RETAILER']);
  }));

  it('keeps norms unique per product and indicator', () => withTx(async (c) => {
    const p = (await c.query(`INSERT INTO products(name, category, loss_norm_percent) VALUES ('Тест','GRAIN',2.5) RETURNING id`)).rows[0].id;
    const i = (await c.query(`INSERT INTO indicators(name, unit) VALUES ('Тест','мг/кг') RETURNING id`)).rows[0].id;
    await c.query('INSERT INTO norms(product_id, indicator_id, max_value) VALUES ($1,$2,0.05)', [p, i]);
    await expectPgError(c.query('INSERT INTO norms(product_id, indicator_id, max_value) VALUES ($1,$2,0.1)', [p, i]), '23505');
  }));

  it('rejects loss norm outside 0..100', () => withTx(async (c) => {
    await expectPgError(c.query(`INSERT INTO products(name, category, loss_norm_percent) VALUES ('X','GRAIN',101)`), '23514');
  }));
});
```

- [ ] **Step 3: Запустить — падает**

Run: `./at db:test` → Expected: FAIL (`relation "organizations" does not exist`).

- [ ] **Step 4: Миграции**

`db/migrations/20260923000001_helpers.sql`:
```sql
-- migrate:up
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
-- migrate:down
DROP FUNCTION IF EXISTS touch_updated_at();
```

`db/migrations/20260923000002_dictionaries.sql`:
```sql
-- migrate:up
CREATE TABLE regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  code varchar(8) NOT NULL UNIQUE
);
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket varchar(63) NOT NULL,
  object_key varchar(512) NOT NULL,
  original_name varchar(255) NOT NULL,
  mime varchar(127) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  variants jsonb NOT NULL DEFAULT '{}'::jsonb,
  kind varchar(24) NOT NULL CHECK (kind IN ('AVATAR','LOGO','PRODUCT_IMAGE','LAB_PROTOCOL','QR','REPORT')),
  owner_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  category varchar(24) NOT NULL CHECK (category IN ('GRAIN','VEGETABLE','FRUIT','DAIRY','MEAT','OILSEED','PROCESSED')),
  loss_norm_percent numeric(5,2) NOT NULL CHECK (loss_norm_percent BETWEEN 0 AND 100),
  image_file_id uuid REFERENCES files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE substances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL UNIQUE,
  type varchar(16) NOT NULL CHECK (type IN ('PESTICIDE','FERTILIZER')),
  waiting_period_days integer NOT NULL CHECK (waiting_period_days >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE indicators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL UNIQUE,
  unit varchar(24) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE norms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  indicator_id uuid NOT NULL REFERENCES indicators(id),
  max_value numeric(14,6) NOT NULL CHECK (max_value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, indicator_id)
);
CREATE TRIGGER t_products_touch BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_substances_touch BEFORE UPDATE ON substances FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_indicators_touch BEFORE UPDATE ON indicators FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_norms_touch BEFORE UPDATE ON norms FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
INSERT INTO regions(name, code) VALUES
 ('Владимирская область','33'),('Московская область','50'),('Ивановская область','37'),
 ('Нижегородская область','52'),('Ярославская область','76'),('Рязанская область','62');
-- migrate:down
DROP TABLE norms, indicators, substances, products, files, regions;
```

`db/migrations/20260923000003_iam.sql`:
```sql
-- migrate:up
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar(16) NOT NULL CHECK (type IN ('FARM','PROCESSOR','LAB','RETAILER','AUTHORITY','PLATFORM')),
  name varchar(255) NOT NULL,
  inn varchar(12) NOT NULL UNIQUE CHECK (inn ~ '^[0-9]{10}([0-9]{2})?$'),
  address varchar(500),
  region_id uuid NOT NULL REFERENCES regions(id),
  trust_rating integer NOT NULL DEFAULT 80 CHECK (trust_rating BETWEEN 0 AND 100),
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','MANUAL_CHECK','ACTIVE','REJECTED','SUSPENDED')),
  logo_file_id uuid REFERENCES files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  deleted_at timestamptz
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email citext NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  full_name varchar(255) NOT NULL,
  phone varchar(32),
  is_org_admin boolean NOT NULL DEFAULT false,
  totp_secret varchar(64),
  totp_enabled boolean NOT NULL DEFAULT false,
  telegram_chat_id bigint,
  notification_channels jsonb NOT NULL DEFAULT '{"email": true, "telegram": false}'::jsonb,
  avatar_file_id uuid REFERENCES files(id),
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  status varchar(16) NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED','ACTIVE','BLOCKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  deleted_at timestamptz
);
CREATE TABLE roles (
  id smallserial PRIMARY KEY,
  code varchar(16) NOT NULL UNIQUE CHECK (code IN ('FARMER','PROCESSOR','LAB','RETAILER','INSPECTOR','ADMIN')),
  name varchar(64) NOT NULL
);
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role_id smallint NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_tokens_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_users_org ON users(organization_id) WHERE deleted_at IS NULL;
CREATE TRIGGER t_organizations_touch BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
INSERT INTO roles(code, name) VALUES
 ('FARMER','Фермер'),('PROCESSOR','Переработчик'),('LAB','Лаборант'),
 ('RETAILER','Сотрудник магазина'),('INSPECTOR','Инспектор'),('ADMIN','Администратор');
-- migrate:down
DROP TABLE refresh_tokens, user_roles, roles, users, organizations;
```

Примечание: тип `PLATFORM` — организация администратора платформы (ТЗ п. 4.1, «Платформа»).

- [ ] **Step 5: Применить и проверить**

Run: `./at db:migrate && ./at db:test` → Expected: 8 passed.
Run: `./at db:rollback && ./at db:rollback && ./at db:rollback && ./at db:migrate` → Expected: без ошибок (down-миграции корректны).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(db): helpers, dictionaries, files and IAM schema"
```

---

### Task 4: Миграции — производство (поля, партии, граф, накладные)

**Files:**
- Create: `db/migrations/20260923000004_production.sql`, `tests/db/production.test.ts`

**Interfaces:**
- Produces: таблицы `fields, treatments, batches, batch_links, batch_status_history, waybills, waybill_items`; последовательность `batch_code_seq`; функция `next_batch_code() RETURNS varchar` → `AT-<год UTC>-<6+ цифр>`; последовательность `waybill_number_seq`, функция `next_waybill_number()` → `WB-<год>-<6+ цифр>`.
- Константа статусов партии (порядок значим для CHECK): `Created, OnTest, Approved, InTransit, Accepted, Processed, OnSale, Sold, Blocked, Recalled, WrittenOff`.

- [ ] **Step 1: Падающие тесты**

`tests/db/production.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { withTx, expectPgError, insertOrg } from './helpers';

async function product(c: pg.PoolClient) {
  return (await c.query(`INSERT INTO products(name, category, loss_norm_percent) VALUES ('Пшеница','GRAIN',2) RETURNING id`)).rows[0].id as string;
}
async function batch(c: pg.PoolClient, org: string, p: string, mass = '100.000', status = 'Created') {
  return (await c.query(
    `INSERT INTO batches(public_code, product_id, origin_org_id, holder_org_id, kind, mass_kg, harvested_at, status)
     VALUES (next_batch_code(), $1, $2, $2, 'RAW', $3, now(), $4) RETURNING id, public_code`, [p, org, mass, status])).rows[0];
}

describe('production schema', () => {
  it('generates sequential batch codes AT-YYYY-NNNNNN', () => withTx(async (c) => {
    const org = await insertOrg(c); const p = await product(c);
    const a = await batch(c, org, p); const b = await batch(c, org, p);
    const year = new Date().getUTCFullYear();
    expect(a.public_code).toMatch(new RegExp(`^AT-${year}-\\d{6,}$`));
    expect(Number(b.public_code.split('-')[2])).toBe(Number(a.public_code.split('-')[2]) + 1);
  }));

  it('rejects non-positive mass', () => withTx(async (c) => {
    const org = await insertOrg(c); const p = await product(c);
    await expectPgError(batch(c, org, p, '0.000'), '23514');
  }));

  it('stores mass exactly with 3 decimals', () => withTx(async (c) => {
    const org = await insertOrg(c); const p = await product(c);
    const b = await batch(c, org, p, '999999999.999');
    const r = await c.query('SELECT mass_kg::text AS m FROM batches WHERE id=$1', [b.id]);
    expect(r.rows[0].m).toBe('999999999.999');
  }));

  it('rejects unknown batch status', () => withTx(async (c) => {
    const org = await insertOrg(c); const p = await product(c);
    await expectPgError(batch(c, org, p, '1.000', 'Lost'), '23514');
  }));

  it('forbids self-loop edges', () => withTx(async (c) => {
    const org = await insertOrg(c); const p = await product(c);
    const a = await batch(c, org, p);
    await expectPgError(c.query('INSERT INTO batch_links(parent_batch_id, child_batch_id, mass_used_kg) VALUES ($1,$1,1)', [a.id]), '23514');
  }));

  it('has index on batch_links(child_batch_id)', () => withTx(async (c) => {
    const r = await c.query(`SELECT indexdef FROM pg_indexes WHERE tablename='batch_links'`);
    expect(r.rows.some((x) => /\(child_batch_id\)/.test(x.indexdef))).toBe(true);
  }));

  it('generates waybill numbers', () => withTx(async (c) => {
    const r = await c.query('SELECT next_waybill_number() AS n');
    expect(r.rows[0].n).toMatch(/^WB-\d{4}-\d{6,}$/);
  }));

  it('rejects waybill to self', () => withTx(async (c) => {
    const org = await insertOrg(c);
    await expectPgError(c.query(
      `INSERT INTO waybills(number, sender_org_id, receiver_org_id, status) VALUES (next_waybill_number(), $1, $1, 'DRAFT')`, [org]), '23514');
  }));
});
```

- [ ] **Step 2: Запустить — падает**

Run: `./at db:test` → Expected: FAIL (`function next_batch_code() does not exist`).

- [ ] **Step 3: Миграция**

`db/migrations/20260923000004_production.sql`:
```sql
-- migrate:up
CREATE TABLE fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(160) NOT NULL,
  area_ha numeric(10,2) NOT NULL CHECK (area_ha > 0),
  geometry jsonb,
  region_id uuid NOT NULL REFERENCES regions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz
);
CREATE TABLE treatments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES fields(id),
  substance_id uuid NOT NULL REFERENCES substances(id),
  dose numeric(10,3) NOT NULL CHECK (dose > 0),
  dose_unit varchar(16) NOT NULL DEFAULT 'л/га',
  applied_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz
);
CREATE INDEX ix_treatments_field_applied ON treatments(field_id, applied_at);

CREATE SEQUENCE batch_code_seq;
CREATE FUNCTION next_batch_code() RETURNS varchar LANGUAGE sql VOLATILE AS $$
  SELECT 'AT-' || extract(year FROM now() AT TIME ZONE 'UTC')::int || '-' || lpad(nextval('batch_code_seq')::text, 6, '0')
$$;
CREATE SEQUENCE waybill_number_seq;
CREATE FUNCTION next_waybill_number() RETURNS varchar LANGUAGE sql VOLATILE AS $$
  SELECT 'WB-' || extract(year FROM now() AT TIME ZONE 'UTC')::int || '-' || lpad(nextval('waybill_number_seq')::text, 6, '0')
$$;

CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code varchar(32) NOT NULL UNIQUE,
  product_id uuid NOT NULL REFERENCES products(id),
  origin_org_id uuid NOT NULL REFERENCES organizations(id),
  holder_org_id uuid REFERENCES organizations(id),
  field_id uuid REFERENCES fields(id),
  kind varchar(8) NOT NULL CHECK (kind IN ('RAW','DERIVED')),
  mass_kg numeric(12,3) NOT NULL CHECK (mass_kg > 0),
  harvested_at timestamptz,
  produced_at timestamptz,
  status varchar(16) NOT NULL DEFAULT 'Created' CHECK (status IN
    ('Created','OnTest','Approved','InTransit','Accepted','Processed','OnSale','Sold','Blocked','Recalled','WrittenOff')),
  test_required boolean NOT NULL DEFAULT false,
  test_reason varchar(24) CHECK (test_reason IN ('NEW_FARM','LOW_RATING','RECENT_PESTICIDE','SAMPLED','NONE')),
  qr_generated_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  CHECK ((kind = 'RAW' AND harvested_at IS NOT NULL) OR (kind = 'DERIVED' AND produced_at IS NOT NULL))
);
CREATE INDEX ix_batches_status ON batches(status) WHERE deleted_at IS NULL;
CREATE INDEX ix_batches_holder ON batches(holder_org_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_batches_origin ON batches(origin_org_id);

CREATE TABLE batch_links (
  parent_batch_id uuid NOT NULL REFERENCES batches(id),
  child_batch_id uuid NOT NULL REFERENCES batches(id),
  mass_used_kg numeric(12,3) NOT NULL CHECK (mass_used_kg > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_batch_id, child_batch_id),
  CHECK (parent_batch_id <> child_batch_id)
);
CREATE INDEX ix_batch_links_child ON batch_links(child_batch_id);

CREATE TABLE batch_status_history (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id),
  from_status varchar(16),
  to_status varchar(16) NOT NULL,
  changed_by uuid REFERENCES users(id),
  reason varchar(500),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_bsh_batch ON batch_status_history(batch_id, changed_at);

CREATE TABLE waybills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number varchar(32) NOT NULL UNIQUE,
  sender_org_id uuid NOT NULL REFERENCES organizations(id),
  receiver_org_id uuid NOT NULL REFERENCES organizations(id),
  status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED')),
  reject_reason varchar(500),
  sent_at timestamptz,
  accepted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  CHECK (sender_org_id <> receiver_org_id)
);
CREATE INDEX ix_waybills_receiver ON waybills(receiver_org_id, status);
CREATE INDEX ix_waybills_sender ON waybills(sender_org_id, status);
CREATE TABLE waybill_items (
  waybill_id uuid NOT NULL REFERENCES waybills(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  mass_declared_kg numeric(12,3) NOT NULL CHECK (mass_declared_kg > 0),
  mass_actual_kg numeric(12,3) CHECK (mass_actual_kg >= 0),
  discrepancy_act varchar(2000),
  PRIMARY KEY (waybill_id, batch_id)
);
CREATE TRIGGER t_fields_touch BEFORE UPDATE ON fields FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_treatments_touch BEFORE UPDATE ON treatments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_batches_touch BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_waybills_touch BEFORE UPDATE ON waybills FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
-- migrate:down
DROP TABLE waybill_items, waybills, batch_status_history, batch_links, batches, treatments, fields;
DROP FUNCTION next_waybill_number(); DROP SEQUENCE waybill_number_seq;
DROP FUNCTION next_batch_code(); DROP SEQUENCE batch_code_seq;
```

- [ ] **Step 4: Проверка**

Run: `./at db:migrate && ./at db:test` → Expected: все тесты PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): fields, treatments, batches, graph and waybills"
```

---

### Task 5: Миграции — качество, отзыв, служебные таблицы

**Files:**
- Create: `db/migrations/20260923000005_quality.sql`, `…000006_service.sql`, `tests/db/quality.test.ts`, `tests/db/service.test.ts`

**Interfaces:**
- Produces: `lab_tests, lab_results, recalls, recall_batches, recall_tasks, complaints, notifications, audit_log`; триггер `t_notifications_notify` → канал `notifications`, payload `{"id": "<uuid>", "user_id": "<uuid>"}`; частичный уникальный индекс `ux_recalls_open_source`.

- [ ] **Step 1: Падающие тесты**

`tests/db/service.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { appPool, withTx, expectPgError, insertOrg } from './helpers';

async function user(c: pg.PoolClient) {
  const org = await insertOrg(c);
  return (await c.query(
    `INSERT INTO users(organization_id, email, password_hash, full_name, status)
     VALUES ($1, gen_random_uuid()::text || '@t.ru', 'x', 'Тест', 'ACTIVE') RETURNING id`, [org])).rows[0].id as string;
}

describe('service schema', () => {
  it('app role cannot update or delete audit_log', () => withTx(async (c) => {
    await c.query(`INSERT INTO audit_log(action, entity_type, entity_id, diff, backend) VALUES ('create','batch',gen_random_uuid(),'{}','express')`);
    await c.query('SAVEPOINT s');
    await expectPgError(c.query(`UPDATE audit_log SET action='x'`), '42501');
    await c.query('ROLLBACK TO SAVEPOINT s');
    await expectPgError(c.query(`DELETE FROM audit_log`), '42501');
  }));

  it('rejects unknown backend in audit_log', () => withTx(async (c) => {
    await expectPgError(c.query(`INSERT INTO audit_log(action, entity_type, entity_id, diff, backend) VALUES ('a','b',gen_random_uuid(),'{}','rails')`), '23514');
  }));

  it('emits pg_notify on committed notification only', async () => {
    const listener = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await listener.connect();
    const got: string[] = [];
    listener.on('notification', (m) => got.push(m.payload ?? ''));
    await listener.query('LISTEN notifications');

    const c = await appPool.connect();
    let uid = '';
    try {
      await c.query('BEGIN');
      uid = await user(c);
      await c.query(`INSERT INTO notifications(user_id, type, payload) VALUES ($1,'RECALL','{}')`, [uid]);
      await c.query('ROLLBACK');
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toHaveLength(0);

      await c.query('BEGIN');
      uid = await user(c);
      const n = (await c.query(`INSERT INTO notifications(user_id, type, payload) VALUES ($1,'RECALL','{}') RETURNING id`, [uid])).rows[0].id;
      await c.query('COMMIT');
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toHaveLength(1);
      expect(JSON.parse(got[0]!)).toEqual({ id: n, user_id: uid });
    } finally {
      c.release();
      await listener.end();
      // cleanup committed rows
      const o = await import('./helpers');
      await o.ownerPool.query('DELETE FROM notifications WHERE user_id=$1', [uid]);
      await o.ownerPool.query('DELETE FROM users WHERE id=$1', [uid]);
    }
  });
});
```

`tests/db/quality.test.ts`:
```ts
import { describe, it } from 'vitest';
import type pg from 'pg';
import { withTx, expectPgError, insertOrg } from './helpers';

async function rawBatch(c: pg.PoolClient) {
  const org = await insertOrg(c);
  const p = (await c.query(`INSERT INTO products(name, category, loss_norm_percent) VALUES ('П','GRAIN',1) RETURNING id`)).rows[0].id;
  return (await c.query(`INSERT INTO batches(public_code, product_id, origin_org_id, holder_org_id, kind, mass_kg, harvested_at)
    VALUES (next_batch_code(), $1, $2, $2, 'RAW', 10, now()) RETURNING id`, [p, org])).rows[0].id as string;
}

describe('quality schema', () => {
  it('allows only one OPEN recall per source batch', () => withTx(async (c) => {
    const b = await rawBatch(c);
    const ins = () => c.query(`INSERT INTO recalls(source_batch_id, trigger, reason, status) VALUES ($1,'INSPECTOR','x','OPEN')`, [b]);
    await ins();
    await expectPgError(ins(), '23505');
  }));

  it('allows a new recall after the previous one closed', () => withTx(async (c) => {
    const b = await rawBatch(c);
    await c.query(`INSERT INTO recalls(source_batch_id, trigger, reason, status, closed_at) VALUES ($1,'INSPECTOR','x','CLOSED', now())`, [b]);
    await c.query(`INSERT INTO recalls(source_batch_id, trigger, reason, status) VALUES ($1,'INSPECTOR','y','OPEN')`, [b]);
  }));

  it('rejects conclusion outside PASS/FAIL', () => withTx(async (c) => {
    const b = await rawBatch(c);
    const lab = await insertOrg(c, 'LAB', '3311111111');
    await expectPgError(c.query(`INSERT INTO lab_tests(batch_id, lab_org_id, reason, status, conclusion, due_at)
      VALUES ($1,$2,'RISK','DONE','MAYBE', now())`, [b, lab]), '23514');
  }));
});
```

- [ ] **Step 2: Запустить — падает**

Run: `./at db:test` → Expected: FAIL (`relation "recalls" does not exist`).

- [ ] **Step 3: Миграции**

`db/migrations/20260923000005_quality.sql`:
```sql
-- migrate:up
CREATE TABLE lab_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  lab_org_id uuid NOT NULL REFERENCES organizations(id),
  reason varchar(16) NOT NULL CHECK (reason IN ('PLANNED','RISK','COMPLAINT','INSPECTOR')),
  status varchar(16) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SAMPLED','DONE','ESCALATED','CANCELLED')),
  conclusion varchar(8) CHECK (conclusion IN ('PASS','FAIL')),
  sampled_at timestamptz,
  completed_at timestamptz,
  due_at timestamptz NOT NULL,
  escalated_at timestamptz,
  protocol_file_id uuid REFERENCES files(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  CHECK ((status = 'DONE') = (conclusion IS NOT NULL))
);
CREATE INDEX ix_lab_tests_queue ON lab_tests(lab_org_id, status, due_at);
CREATE INDEX ix_lab_tests_batch ON lab_tests(batch_id);
CREATE TABLE lab_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_test_id uuid NOT NULL REFERENCES lab_tests(id),
  indicator_id uuid NOT NULL REFERENCES indicators(id),
  value numeric(14,6) NOT NULL CHECK (value >= 0),
  norm_value_snapshot numeric(14,6),
  is_exceeded boolean NOT NULL,
  UNIQUE (lab_test_id, indicator_id)
);
CREATE TABLE recalls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_batch_id uuid NOT NULL REFERENCES batches(id),
  trigger varchar(16) NOT NULL CHECK (trigger IN ('LAB','INSPECTOR','COMPLAINT')),
  reason varchar(1000) NOT NULL,
  status varchar(8) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  lab_test_id uuid REFERENCES lab_tests(id),
  complaint_id uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX ux_recalls_open_source ON recalls(source_batch_id) WHERE status = 'OPEN';
CREATE TABLE recall_batches (
  recall_id uuid NOT NULL REFERENCES recalls(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  direction varchar(8) NOT NULL CHECK (direction IN ('SOURCE','DOWN','UP')),
  depth integer NOT NULL CHECK (depth >= 0),
  status_before varchar(16) NOT NULL,
  PRIMARY KEY (recall_id, batch_id)
);
CREATE TABLE recall_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recall_id uuid NOT NULL REFERENCES recalls(id),
  holder_org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  due_at timestamptz NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED','OVERDUE')),
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  escalated_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recall_id, batch_id),
  CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);
CREATE INDEX ix_recall_tasks_status_due ON recall_tasks(status, due_at);
CREATE INDEX ix_recall_tasks_holder ON recall_tasks(holder_org_id, status);
CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  text varchar(2000) NOT NULL CHECK (length(text) >= 10),
  contact varchar(255),
  status varchar(16) NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','IN_REVIEW','DECIDED')),
  decision varchar(16) CHECK (decision IN ('REJECT','LAB_TEST','RECALL')),
  decision_comment varchar(1000),
  inspector_id uuid REFERENCES users(id),
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((status = 'DECIDED') = (decision IS NOT NULL))
);
ALTER TABLE recalls ADD CONSTRAINT fk_recalls_complaint FOREIGN KEY (complaint_id) REFERENCES complaints(id);
CREATE TRIGGER t_lab_tests_touch BEFORE UPDATE ON lab_tests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_recalls_touch BEFORE UPDATE ON recalls FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_recall_tasks_touch BEFORE UPDATE ON recall_tasks FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_complaints_touch BEFORE UPDATE ON complaints FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
-- migrate:down
ALTER TABLE recalls DROP CONSTRAINT fk_recalls_complaint;
DROP TABLE complaints, recall_tasks, recall_batches, recalls, lab_results, lab_tests;
```

`db/migrations/20260923000006_service.sql`:
```sql
-- migrate:up
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  type varchar(32) NOT NULL CHECK (type IN
    ('LAB_ASSIGNED','LAB_RESULT','WAYBILL_INCOMING','RECALL','RECALL_TASK','OVERDUE','COMPLAINT','LAB_OVERDUE')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel varchar(16) NOT NULL DEFAULT 'IN_APP' CHECK (channel IN ('IN_APP','EMAIL','TELEGRAM')),
  delivery_status varchar(16) NOT NULL DEFAULT 'DELIVERED' CHECK (delivery_status IN ('PENDING','DELIVERED','FAILED','NOT_CONFIGURED')),
  attempts integer NOT NULL DEFAULT 0,
  is_read boolean NOT NULL DEFAULT false,
  seq bigserial UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_user ON notifications(user_id, is_read, created_at DESC) WHERE channel = 'IN_APP';
CREATE FUNCTION notify_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel = 'IN_APP' THEN
    PERFORM pg_notify('notifications', json_build_object('id', NEW.id, 'user_id', NEW.user_id)::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER t_notifications_notify AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notify_notification();

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  action varchar(64) NOT NULL,
  entity_type varchar(64) NOT NULL,
  entity_id uuid,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  backend varchar(8) NOT NULL CHECK (backend IN ('express','django','laravel','seed','system')),
  request_id varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX ix_audit_created ON audit_log(created_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM agrotrace_app;
GRANT SELECT, INSERT ON audit_log TO agrotrace_app;
-- migrate:down
DROP TABLE audit_log;
DROP TRIGGER t_notifications_notify ON notifications; DROP FUNCTION notify_notification();
DROP TABLE notifications;
```

`notifications.seq` — монотонный номер для SSE `Last-Event-ID` (ТЗ п. 8.4).

- [ ] **Step 4: Проверка**

Run: `./at db:migrate && ./at db:test` → Expected: все PASS. Проверить, что `db/schema.sql` сгенерирован dbmate и закоммичен.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): quality, recall, complaints, notifications with pg_notify, audit_log"
```

---

### Task 6: Контракты правил — автомат статусов и тест-векторы

**Files:**
- Create: `contracts/rules/state-machine.json`, `contracts/rules/trust-rating.json`, `contracts/rules/vector.schema.json`, `contracts/rules/vectors/{state-machine,BR-01,BR-02,BR-03,BR-04,BR-05,BR-07,BR-08,BR-09,BR-10,BR-11,batch-code,working-days,treatment-edit}.json`, `contracts/package.json`, `contracts/test/vectors.test.ts`

**Interfaces:**
- Produces: формат вектора `{ "rule": string, "fn": string, "cases": [{ "name": string, "input": object, "expected": object }] }`. Имя `fn` — каноническое имя функции, одинаковое во всех реализациях (camelCase в TS, snake_case в Python, camelCase в PHP — маппинг механический).
- `state-machine.json`: `{ "statuses": string[], "transitions": [{ "from": string, "to": string, "action": string }] }`.

- [ ] **Step 1: state-machine.json**

```json
{
  "statuses": ["Created","OnTest","Approved","InTransit","Accepted","Processed","OnSale","Sold","Blocked","Recalled","WrittenOff"],
  "transitions": [
    { "from": "Created",   "to": "OnTest",     "action": "sendToLab" },
    { "from": "Created",   "to": "Approved",   "action": "approveWithoutTest" },
    { "from": "OnTest",    "to": "Approved",   "action": "labPass" },
    { "from": "OnTest",    "to": "Blocked",    "action": "labFail" },
    { "from": "Approved",  "to": "InTransit",  "action": "ship" },
    { "from": "Accepted",  "to": "InTransit",  "action": "ship" },
    { "from": "InTransit", "to": "Accepted",   "action": "accept" },
    { "from": "InTransit", "to": "Approved",   "action": "reject" },
    { "from": "Accepted",  "to": "Processed",  "action": "process" },
    { "from": "Approved",  "to": "Processed",  "action": "process" },
    { "from": "Accepted",  "to": "OnSale",     "action": "putOnSale" },
    { "from": "OnSale",    "to": "Sold",       "action": "sell" },
    { "from": "Created",   "to": "Recalled",   "action": "recall" },
    { "from": "OnTest",    "to": "Recalled",   "action": "recall" },
    { "from": "Approved",  "to": "Recalled",   "action": "recall" },
    { "from": "InTransit", "to": "Recalled",   "action": "recall" },
    { "from": "Accepted",  "to": "Recalled",   "action": "recall" },
    { "from": "OnSale",    "to": "Recalled",   "action": "recall" },
    { "from": "Blocked",   "to": "Recalled",   "action": "recall" },
    { "from": "Recalled",  "to": "WrittenOff", "action": "writeOff" }
  ]
}
```

`Approved → Processed` следует из BR-05 («в переработку допускаются Допущена или Принята») и отражён в диаграмме ТЗ п. 5.1.

- [ ] **Step 2: trust-rating.json**

```json
{ "initial": 80, "min": 0, "max": 100,
  "deltas": { "LAB_PASS": 2, "LAB_FAIL": -15, "RECALL_SOURCE": -10 } }
```

- [ ] **Step 3: vector.schema.json + тест валидности всех векторов**

`contracts/package.json`:
```json
{ "name": "@agrotrace/contracts", "private": true, "type": "module",
  "scripts": { "test": "vitest run", "lint:openapi": "redocly lint openapi.yaml" },
  "devDependencies": { "ajv": "^8.17.1", "ajv-formats": "^3.0.1", "vitest": "^2.1.4", "@redocly/cli": "^1.25.11" } }
```
Добавить `contracts` в `pnpm-workspace.yaml`.

`contracts/rules/vector.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["rule", "fn", "cases"],
  "additionalProperties": false,
  "properties": {
    "rule": { "type": "string" },
    "fn": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]+$" },
    "description": { "type": "string" },
    "cases": {
      "type": "array", "minItems": 10,
      "items": {
        "type": "object", "required": ["name", "input", "expected"], "additionalProperties": false,
        "properties": { "name": { "type": "string" }, "input": { "type": "object" }, "expected": { "type": "object" } }
      }
    }
  }
}
```

`contracts/test/vectors.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020';

const dir = new URL('../rules/vectors/', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('../rules/vector.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true }).compile(schema);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('rule vectors', () => {
  it('cover every business rule', () => {
    for (const r of ['BR-01','BR-02','BR-03','BR-04','BR-05','BR-07','BR-08','BR-09','BR-10','BR-11','state-machine'])
      expect(files).toContain(`${r}.json`);
  });
  for (const f of files) {
    it(`${f} matches schema and has unique case names`, () => {
      const v = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      expect(validate(v), JSON.stringify(validate.errors)).toBe(true);
      const names = v.cases.map((c: { name: string }) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });
  }
});
```

BR-06 проверяется векторами `state-machine.json` (переходы из Blocked/Recalled в accept/ship/process запрещены) — в тесте выше это покрыто присутствием state-machine.

- [ ] **Step 4: Векторы**

Для каждого файла — ≥ 10 случаев, включая граничные. Сигнатуры (TS-имена; вход и выход — ровно объекты `input`/`expected`):

| Файл | `fn` | input | expected |
|---|---|---|---|
| `state-machine.json` | `canTransition` | `{ from, to }` | `{ allowed: boolean }` — все 121 пары статусов генерируются скриптом `contracts/scripts/gen-sm-vectors.ts` из state-machine.json (единожды, результат коммитится) |
| `BR-01.json` | `checkWaitingPeriod` | `{ shipDate: "YYYY-MM-DD", treatments: [{ substance, appliedAt: ISO, waitingPeriodDays }] }` | `{ ok: true }` или `{ ok: false, until: "YYYY-MM-DD", substance }` — `until = UTC-дата(appliedAt) + waitingPeriodDays`; отгрузка разрешена, если `shipDate >= until`; среди нескольких обработок блокирует та, у которой `until` позже |
| `BR-02.json` | `concludeLabTest` | `{ results: [{ indicatorId, value: string, maxValue: string\|null }] }` | `{ conclusion: "PASS"\|"FAIL", exceeded: string[] }` или `{ error: "NO_RESULTS" }` при пустом списке; `value > maxValue` строго; `maxValue: null` — не нормируется |
| `BR-03.json` | `requiresLabTest` | `{ publicCode, farmBatchCount, trustRating, pesticideTreatmentsLast30Days }` | `{ required: boolean, reason }` — порядок проверки: NEW_FARM (<5), LOW_RATING (<70), RECENT_PESTICIDE (>0), SAMPLED (sha256(publicCode)[0..4] BE uint32 mod 100 < 20), иначе NONE |
| `BR-04.json` | `checkMassBalance` | `{ inputs: [{ massUsedKg: string, lossNormPercent: string }], outputs: [{ massKg: string }] }` | `{ ok, inputKg, allowedKg, outputKg }` (строки, 3 знака) или `{ error: "NO_INPUTS"\|"NO_OUTPUTS" }`; расчёт в граммах: `allowed = Σ floor(g_i × (10000 − bp_i) / 10000)`, `bp = lossNormPercent × 100` |
| `BR-05.json` | `canUseAsInput` | `{ status }` | `{ allowed }` — Approved, Accepted |
| `BR-07.json` | `checkDiscrepancy` | `{ declaredKg, actualKg }` | `{ percent: "N.NN", actRequired }` — `percent = round_half_up(|a−d|/d × 100, 2)`; `actRequired = |a−d| × 100 > 2 × d` (точно, в граммах) |
| `BR-08.json` | `recallTaskDueAt` / `isOverdue` | `{ openedAt }` / `{ dueAt, now }` | `{ dueAt }` = openedAt + 24 ч / `{ overdue: now > dueAt }` (два файла-раздела объединяются: поле `fn` = `recallTaskDueAt`, а `isOverdue`-случаи — в `BR-08-overdue.json`) |
| `BR-09.json` | `nextTrustRating` | `{ current, event }` | `{ rating }` — по trust-rating.json, clamp [0,100] |
| `BR-10.json` | `shouldCloseRecall` | `{ taskStatuses: string[] }` | `{ close }` — все CONFIRMED (пустой список → true) |
| `BR-11.json` | `idempotencyDecision` | `{ key, stored: { fingerprint } \| null, fingerprint }` | `{ decision: "EXECUTE"\|"REPLAY"\|"CONFLICT"\|"INVALID_KEY" }` — ключ `^[A-Za-z0-9_-]{8,128}$` |
| `batch-code.json` | `formatBatchCode` | `{ year, seq }` | `{ code }` — `AT-2026-000123`; seq ≥ 1 000 000 → без обрезки |
| `working-days.json` | `addWorkingDays` | `{ from: ISO, days }` | `{ result: ISO }` — пропуск Сб/Вс по UTC, время сохраняется (эскалация лаборатории, БП-2) |
| `treatment-edit.json` | `canEditTreatment` | `{ createdAt, now }` | `{ allowed }` — `now − createdAt <= 24 ч` (FR-PROD-02) |

Обязательные граничные случаи (Review Focus 1, 2, 4):
- BR-01: обработка `2026-09-10T23:30:00Z`, срок 14 → until `2026-09-24`; отгрузка `2026-09-24` → ok; `2026-09-23` → нет.
- BR-04: вход `"0.001"` с потерями `"0.00"`, выход `"0.001"` → ok; потери `"100.00"` → allowed `"0.000"`; вход `"999999999.999"`; выходы ровно равны allowed → ok; на 1 г больше → нет.
- BR-07: declared `"100.000"`, actual `"102.000"` → percent `"2.00"`, act false; actual `"102.001"` → act true; actual `"0.000"` → percent `"100.00"`, act true.
- BR-02: пустые results → `NO_RESULTS`; value равно max → PASS.
- BR-03: вектор с публичным кодом, для которого хеш даёт ровно 19 и ровно 20 (подобрать скриптом при генерации).

Векторы BR-03 SAMPLED генерируются скриптом `contracts/scripts/find-sample-codes.ts` (перебор `AT-2026-000001…`), который печатает коды с `mod 100` = 0, 19, 20, 99; коды вписываются в файл вручную вместе с ожидаемым результатом.

- [ ] **Step 5: Проверка**

Run: `./at pnpm --filter @agrotrace/contracts test` → Expected: PASS для всех файлов.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(contracts): state machine, trust rating and business rule vectors"
```

---

### Task 7: `packages/domain` — эталонная реализация правил

**Files:**
- Create: `packages/domain/{package.json,tsconfig.json}`, `packages/domain/src/{index.ts,decimal.ts,state-machine.ts,rules.ts,dates.ts,idempotency.ts}`, `packages/domain/test/vectors.test.ts`

**Interfaces:**
- Consumes: `contracts/rules/*.json`.
- Produces (экспорт `@agrotrace/domain`):
  - `type BatchStatus = 'Created'|'OnTest'|'Approved'|'InTransit'|'Accepted'|'Processed'|'OnSale'|'Sold'|'Blocked'|'Recalled'|'WrittenOff'`
  - `BATCH_STATUSES: readonly BatchStatus[]`
  - `canTransition(i: {from: BatchStatus; to: BatchStatus}): {allowed: boolean}`
  - `availableActions(from: BatchStatus): {action: string; to: BatchStatus}[]`
  - `checkWaitingPeriod`, `concludeLabTest`, `requiresLabTest`, `checkMassBalance`, `canUseAsInput`, `checkDiscrepancy`, `recallTaskDueAt`, `isOverdue`, `nextTrustRating`, `shouldCloseRecall`, `idempotencyDecision`, `formatBatchCode`, `addWorkingDays`, `canEditTreatment` — сигнатуры ровно как в таблице Task 6.
  - `kgToGrams(s: string): bigint`, `gramsToKg(g: bigint): string`.

- [ ] **Step 1: Тест, прогоняющий все векторы**

`packages/domain/test/vectors.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as domain from '../src/index';

const dir = new URL('../../../contracts/rules/vectors/', import.meta.url);
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const v = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  describe(`${v.rule} (${f})`, () => {
    const fn = (domain as Record<string, unknown>)[v.fn] as (i: unknown) => unknown;
    it('function is exported', () => expect(typeof fn).toBe('function'));
    for (const c of v.cases) it(c.name, () => expect(fn(c.input)).toEqual(c.expected));
  });
}
```

- [ ] **Step 2: Запустить — падает**

Run: `./at pnpm --filter @agrotrace/domain test` → Expected: FAIL (`function is exported`).

- [ ] **Step 3: Реализация**

`packages/domain/src/decimal.ts`:
```ts
export function kgToGrams(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid mass: ${s}`);
  return BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
}
export function gramsToKg(g: bigint): string {
  const neg = g < 0n; const a = neg ? -g : g;
  return `${neg ? '-' : ''}${a / 1000n}.${(a % 1000n).toString().padStart(3, '0')}`;
}
export function percentToBasisPoints(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid percent: ${s}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}
/** round half up of n/d to 2 decimals, returns "N.NN" */
export function ratioPercent2(n: bigint, d: bigint): string {
  const scaled = (n * 10000n * 2n + d) / (2n * d); // percent*100, half-up
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, '0')}`;
}
```

`packages/domain/src/state-machine.ts`:
```ts
import sm from '../../../contracts/rules/state-machine.json' with { type: 'json' };
export type BatchStatus = 'Created'|'OnTest'|'Approved'|'InTransit'|'Accepted'|'Processed'|'OnSale'|'Sold'|'Blocked'|'Recalled'|'WrittenOff';
export const BATCH_STATUSES = sm.statuses as readonly BatchStatus[];
const T = sm.transitions as { from: BatchStatus; to: BatchStatus; action: string }[];
export function canTransition(i: { from: BatchStatus; to: BatchStatus }) {
  return { allowed: T.some((t) => t.from === i.from && t.to === i.to) };
}
export function availableActions(from: BatchStatus) {
  return T.filter((t) => t.from === from).map(({ action, to }) => ({ action, to }));
}
```

`packages/domain/src/dates.ts`:
```ts
const DAY = 86_400_000;
export const utcDate = (iso: string) => iso.slice(0, 10);
export function addDaysToDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
export function addWorkingDays(i: { from: string; days: number }) {
  const d = new Date(i.from);
  let left = i.days;
  while (left > 0) {
    d.setTime(d.getTime() + DAY);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return { result: d.toISOString() };
}
export function recallTaskDueAt(i: { openedAt: string }) {
  return { dueAt: new Date(Date.parse(i.openedAt) + DAY).toISOString() };
}
export function isOverdue(i: { dueAt: string; now: string }) {
  return { overdue: Date.parse(i.now) > Date.parse(i.dueAt) };
}
export function canEditTreatment(i: { createdAt: string; now: string }) {
  return { allowed: Date.parse(i.now) - Date.parse(i.createdAt) <= DAY };
}
```

`packages/domain/src/rules.ts`:
```ts
import { createHash } from 'node:crypto';
import tr from '../../../contracts/rules/trust-rating.json' with { type: 'json' };
import { kgToGrams, gramsToKg, percentToBasisPoints, ratioPercent2 } from './decimal';
import { utcDate, addDaysToDate } from './dates';
import type { BatchStatus } from './state-machine';

export function checkWaitingPeriod(i: { shipDate: string; treatments: { substance: string; appliedAt: string; waitingPeriodDays: number }[] }) {
  let worst: { until: string; substance: string } | null = null;
  for (const t of i.treatments) {
    const until = addDaysToDate(utcDate(t.appliedAt), t.waitingPeriodDays);
    if (i.shipDate < until && (!worst || until > worst.until)) worst = { until, substance: t.substance };
  }
  return worst ? { ok: false, ...worst } : { ok: true };
}

export function concludeLabTest(i: { results: { indicatorId: string; value: string; maxValue: string | null }[] }) {
  if (i.results.length === 0) return { error: 'NO_RESULTS' };
  const exceeded = i.results
    .filter((r) => r.maxValue !== null && Number(r.value) > Number(r.maxValue))
    .map((r) => r.indicatorId);
  return { conclusion: exceeded.length ? 'FAIL' : 'PASS', exceeded };
}

export function sampleBucket(publicCode: string): number {
  return createHash('sha256').update(publicCode, 'utf8').digest().readUInt32BE(0) % 100;
}
export function requiresLabTest(i: { publicCode: string; farmBatchCount: number; trustRating: number; pesticideTreatmentsLast30Days: number }) {
  if (i.farmBatchCount < 5) return { required: true, reason: 'NEW_FARM' };
  if (i.trustRating < 70) return { required: true, reason: 'LOW_RATING' };
  if (i.pesticideTreatmentsLast30Days > 0) return { required: true, reason: 'RECENT_PESTICIDE' };
  if (sampleBucket(i.publicCode) < 20) return { required: true, reason: 'SAMPLED' };
  return { required: false, reason: 'NONE' };
}

export function checkMassBalance(i: { inputs: { massUsedKg: string; lossNormPercent: string }[]; outputs: { massKg: string }[] }) {
  if (i.inputs.length === 0) return { error: 'NO_INPUTS' };
  if (i.outputs.length === 0) return { error: 'NO_OUTPUTS' };
  let input = 0n, allowed = 0n, output = 0n;
  for (const x of i.inputs) {
    const g = kgToGrams(x.massUsedKg);
    input += g;
    allowed += (g * (10000n - percentToBasisPoints(x.lossNormPercent))) / 10000n;
  }
  for (const o of i.outputs) output += kgToGrams(o.massKg);
  return { ok: output <= allowed, inputKg: gramsToKg(input), allowedKg: gramsToKg(allowed), outputKg: gramsToKg(output) };
}

export function canUseAsInput(i: { status: BatchStatus }) {
  return { allowed: i.status === 'Approved' || i.status === 'Accepted' };
}

export function checkDiscrepancy(i: { declaredKg: string; actualKg: string }) {
  const d = kgToGrams(i.declaredKg), a = kgToGrams(i.actualKg);
  const diff = a > d ? a - d : d - a;
  return { percent: ratioPercent2(diff, d), actRequired: diff * 100n > 2n * d };
}

export function nextTrustRating(i: { current: number; event: keyof typeof tr.deltas }) {
  return { rating: Math.min(tr.max, Math.max(tr.min, Math.round(i.current + tr.deltas[i.event]))) };
}

export function shouldCloseRecall(i: { taskStatuses: string[] }) {
  return { close: i.taskStatuses.every((s) => s === 'CONFIRMED') };
}

export function formatBatchCode(i: { year: number; seq: number }) {
  return { code: `AT-${i.year}-${String(i.seq).padStart(6, '0')}` };
}
```

`packages/domain/src/idempotency.ts`:
```ts
export function idempotencyDecision(i: { key: string; stored: { fingerprint: string } | null; fingerprint: string }) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(i.key)) return { decision: 'INVALID_KEY' };
  if (!i.stored) return { decision: 'EXECUTE' };
  return { decision: i.stored.fingerprint === i.fingerprint ? 'REPLAY' : 'CONFLICT' };
}
```

`packages/domain/src/index.ts`: реэкспорт всех модулей.

`BR-02` сравнение через `Number` допустимо: значения показателей `numeric(14,6)` умещаются в double без потери порядка при сравнении с max той же точности; вектор с `value: "0.050001"`, `maxValue: "0.05"` → FAIL фиксирует это.

- [ ] **Step 4: Проверка**

Run: `./at pnpm --filter @agrotrace/domain test` → Expected: все векторы PASS. `./at pnpm --filter @agrotrace/domain exec vitest run --coverage` → ≥ 90% строк.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): reference TS implementation of business rules"
```

---

### Task 8: OpenAPI — общая часть, auth, профиль, пользователи, организации, файлы, публичное, health, SSE

**Files:**
- Create: `contracts/openapi.yaml` (корень: info, servers `/api/v1`, security, tags, `$ref` на пути), `contracts/openapi/schemas/{common,auth,users,organizations,files,public,notifications}.yaml`, `contracts/openapi/paths/{auth,me,users,organizations,files,public,health,events}.yaml`, `contracts/redocly.yaml`

**Interfaces:**
- Produces (имена схем, используются всеми реализациями и `api-client`):
  - `Problem { type, title, status, detail?, code, rule?, params?, errors? }`, `Page<T>` как `{ items, page, size, total }` (для каждого списка — отдельная схема `XxxPage`), `Mass` (`string`, pattern `^\d{1,9}\.\d{3}$`), `Uuid`, `DateTime`, `Date`.
  - `LoginRequest { email, password }`, `LoginResponse { accessToken, expiresIn, user: Me } | { twoFactorRequired: true, challengeId }`, `TwoFactorVerifyRequest { challengeId, code }`, `RegisterOrganizationRequest { inn, type, name?, regionCode, admin: { email, fullName, password } }`, `RegisterOrganizationResponse { organizationId, status }`, `ForgotPasswordRequest { email }`, `ResetPasswordRequest { token, password }`, `AcceptInviteRequest { token, fullName, password }`.
  - `Me { id, email, fullName, phone, avatarUrl, roles: RoleCode[], organization: OrganizationRef, isOrgAdmin, totpEnabled, channels: { email, telegram, telegramLinked } }`, `MeUpdate { fullName?, phone? }`, `ChannelsUpdate { email, telegram }`, `TelegramCode { code, expiresAt, botUsername }`.
  - `RoleCode` enum `FARMER|PROCESSOR|LAB|RETAILER|INSPECTOR|ADMIN`.
  - `User { id, email, fullName, phone, avatarUrl, roles, isOrgAdmin, status, organization }`, `UserInvite { email, fullName, roles, isOrgAdmin }`, `UserPatch { roles?, isOrgAdmin?, status? }`.
  - `OrganizationRef { id, name, type, logoUrl }`, `Organization { …Ref, inn, address, region: Region, trustRating, status }`, `Region { code, name }`.
  - `FileRef { id, url, mime, sizeBytes, originalName }` (url — относительный `/api/v1/files/{id}` или `/api/v1/public/files/{id}`).
  - `PublicBatch { publicCode, product: { name, category, imageUrl }, origin: { farmName, logoUrl, region }, harvestedAt, producedAt, status, safety: 'SAFE'|'RECALLED'|'BLOCKED'|'UNKNOWN', path: [{ orgName, orgType, logoUrl, from, to }], labSummary: { total, passed, lastConclusion, lastDate } }`, `PublicComplaintRequest { text, contact?, altcha }`, `AltchaChallenge` (формат библиотеки ALTCHA: `algorithm, challenge, salt, signature, maxnumber`).
  - `Notification { id, seq, type, payload, isRead, createdAt }`.
  - Health: `{ status: 'ok'|'fail', checks: { db, redis, rabbitmq, s3 } }`.
- Пути ровно из ТЗ п. 8.5 для модулей Auth, Profile, Users, Organizations, Files, Public, Health, Events; загрузки — `multipart/form-data` с полем `file`; ответы 413/415 — `Problem`.
- Все защищённые операции — `security: [bearer: []]`; `operationId` в camelCase уникальны (`login`, `refreshToken`, `logout`, `getMe`, `updateMe`, `uploadMyAvatar`, …) — используются как имена методов в клиентах.

- [ ] **Step 1: Линтер и правила**

`contracts/redocly.yaml`:
```yaml
extends: [recommended]
rules:
  operation-operationId: error
  operation-4xx-response: error
  no-unused-components: warn
  operation-summary: error
```

- [ ] **Step 2: Запустить линт — падает (файла нет)**

Run: `./at pnpm --filter @agrotrace/contracts lint:openapi` → Expected: FAIL.

- [ ] **Step 3: Написать YAML**

Правила для каждой операции: `operationId`, `summary` (русский), `tags`, все коды ответов (200/201/204, 400, 401, 403, 404, 409, 413, 415, 422, 429 — какие применимы), `Problem` для ошибок, пример (`example`) для каждой схемы тела запроса/ответа. Параметры пагинации — общие `components.parameters.Page`, `Size`, `Sort`, `Q`. Заголовки — `components.parameters.IdempotencyKey` (для операций BR-11), `components.headers.XBackend`, `XRequestId`, `IdempotentReplayed`. SSE-операция `GET /events/stream` — `responses.200.content.text/event-stream` с описанием событий `notification|unread|ping|reauth` и параметрами `access_token` (query) и `Last-Event-ID` (header).

- [ ] **Step 4: Проверка**

Run: `./at pnpm --filter @agrotrace/contracts lint:openapi` → Expected: `Woohoo! Your API description is valid.` (warnings допустимы только `no-unused-components` до Task 10).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): openapi core, auth, profile, users, orgs, files, public"
```

---

### Task 9: OpenAPI — производство

**Files:**
- Create: `contracts/openapi/schemas/{dictionaries-ref,fields,batches,waybills,processing}.yaml`, `contracts/openapi/paths/{fields,treatments,batches,processing,waybills}.yaml`
- Modify: `contracts/openapi.yaml`

**Interfaces:**
- Produces:
  - `Field { id, name, areaHa: string, region, geometry: GeoJsonPolygon|null, lastTreatmentAt, treatmentsCount }`, `FieldInput { name, areaHa, regionCode, geometry? }`, `GeoJsonPolygon { type: 'Polygon', coordinates: number[][][] }`.
  - `Treatment { id, fieldId, substance: SubstanceRef, dose: string, doseUnit, appliedAt, editableUntil }`, `TreatmentInput { substanceId, dose, doseUnit, appliedAt }`.
  - `BatchStatus` enum (11 значений), `BatchListItem { id, publicCode, product: ProductRef, massKg, status, kind, holder: OrganizationRef, origin: OrganizationRef, harvestedAt, producedAt, updatedAt }`, `Batch { …ListItem, field: {id,name}|null, testRequired, testReason, version, actions: BatchAction[], qrGeneratedAt }`, `BatchAction { action, to }` (из `availableActions`, отфильтровано по правам текущего пользователя).
  - `BatchCreate { fieldId, productId, massKg, harvestedAt }` → 201 `Batch` (с решением риск-модели).
  - `BatchGraph { nodes: [{ id, publicCode, product, status, holder, depth }], edges: [{ parent, child, massUsedKg }] }` — `?depth=1..5`, по умолчанию 2.
  - `StatusHistoryItem { from, to, changedAt, reason, changedBy: { fullName, avatarUrl } | null }`, `PathStep { org: OrganizationRef, from, to, waybillNumber }`.
  - `ProcessingRequest { inputs: [{ batchId, massUsedKg }], outputs: [{ productId, massKg }] }` → 201 `{ outputs: Batch[], balance: { inputKg, allowedKg, outputKg } }`; 422 `BR-04`/`BR-05`/`BR-06`.
  - `Waybill { id, number, status, sender: OrganizationRef, receiver: OrganizationRef, items: [{ batch: BatchListItem, massDeclaredKg, massActualKg, discrepancyPercent, discrepancyAct }], sentAt, acceptedAt, rejectReason, version }`, `WaybillCreate { receiverOrgId, items: [{ batchId, massDeclaredKg }] }` (создаётся сразу в SENT; 422 BR-01 с `params.until`, `params.substance`, `params.publicCode`), `WaybillAccept { items: [{ batchId, massActualKg, discrepancyAct? }] }` (422 BR-07 при отсутствии акта), `WaybillReject { reason }`.
  - `QrRequest {}` → 201 `{ publicUrl, pngUrl, pdfUrl }`; `GET /batches/{id}/qr?format=png|pdf` — бинарный ответ.
  - Фильтры списка партий: `status` (multi), `productId`, `holder=me|all`, `kind`, `from`, `to`, `q` (по коду).

- [ ] **Step 1–4:** как в Task 8 (линт падает → YAML → линт проходит). Каждая операция изменения партии/накладной возвращает 409 `Problem` с `code: 'INVALID_TRANSITION'` или `'VERSION_CONFLICT'`; операции с `If-Match: <version>` для PATCH/переходов.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): openapi production module"
```

---

### Task 10: OpenAPI — качество, отзывы, жалобы, уведомления, аналитика, админ; события очереди

**Files:**
- Create: `contracts/openapi/schemas/{lab,recalls,complaints,analytics,admin}.yaml`, `contracts/openapi/paths/{lab,recalls,recall-tasks,complaints,notifications,analytics,reports,admin,dictionaries,audit}.yaml`, `contracts/events/{recall.requested,notification.dispatch,lab.escalate,rating.recalculate}.schema.json`, `contracts/test/openapi.test.ts`
- Modify: `contracts/openapi.yaml`

**Interfaces:**
- Produces:
  - `LabTest { id, batch: BatchListItem, lab: OrganizationRef, reason, status, conclusion, dueAt, overdue, results: LabResult[], protocol: FileRef|null, norms: [{ indicatorId, name, unit, maxValue }] }`, `LabResult { indicatorId, name, unit, value, normValue, isExceeded }`, `LabResultsInput { results: [{ indicatorId, value }] }` → 200 `LabTest` (conclusion выставлен; при FAIL — `recallId`).
  - `Recall { id, sourceBatch: BatchListItem, trigger, reason, status, openedAt, closedAt, progress: { confirmed, total }, batches: [{ batch, direction, depth, statusBefore }], tasks: RecallTask[] }`, `RecallCreate { sourceBatchId, reason, blockUpstream: boolean }`.
  - `RecallTask { id, recallId, batch: BatchListItem, holder: OrganizationRef, dueAt, status, confirmedAt, confirmedBy }`, `POST /recall-tasks/{id}/confirm` с `Idempotency-Key`.
  - `Complaint { id, batch: BatchListItem, text, contact, status, decision, decisionComment, createdAt }`, `ComplaintDecision { decision: 'REJECT'|'LAB_TEST'|'RECALL', comment, labOrgId? }`.
  - `Dashboard` — `oneOf` по `scope`: `InspectorDashboard { batchesTotal, rejectedShare: [{ key, name, share }] (byProduct, byFarm), activeRecalls, avgRecallHours, violationsByRegion: [{ code, name, count }] }`, `OrgDashboard { byStatus: [{ status, count }], labResults: { pass, fail }, openTasks }`, `LabDashboard { queue, overdue, avgHours }`.
  - `ReportType` enum `batches|recalls|recall|lab-tests|complaints|org`; `GET /reports/{type}?format=xlsx|pdf&from&to&id` — бинарный ответ.
  - Admin: `OrganizationAdmin`, `DictionaryName` enum `products|substances|indicators|norms|regions`, схемы строк справочников, `ImportReport { created, updated, errors: [{ row, message }] }`, `AuditEntry { id, actor, action, entityType, entityId, diff, ip, backend, createdAt }`.
  - События очереди (JSON Schema, общее поле `{ id, type, occurredAt, backend, requestId, data }`).
- `contracts/test/openapi.test.ts` — бандлит (`@redocly/openapi-core` `bundle`) и проверяет: каждый путь из таблицы ТЗ п. 8.5 присутствует (список путей зашит в тест), все `operationId` уникальны, у каждой операции изменения есть 401/403.

- [ ] **Step 1: Тест полноты**

```ts
import { describe, it, expect } from 'vitest';
import { bundle, loadConfig } from '@redocly/openapi-core';

const REQUIRED: [string, string][] = [
  ['post','/auth/login'],['post','/auth/refresh'],['post','/auth/logout'],['post','/auth/register-organization'],
  ['post','/auth/2fa/verify'],['post','/auth/2fa/setup'],['post','/auth/password/forgot'],['post','/auth/password/reset'],['post','/auth/accept-invite'],
  ['get','/me'],['patch','/me'],['put','/me/avatar'],['delete','/me/avatar'],['get','/me/channels'],['put','/me/channels'],['post','/me/telegram-code'],
  ['get','/users'],['post','/users'],['patch','/users/{id}'],['get','/users/{id}/avatar'],
  ['get','/organizations/{id}'],['put','/organizations/{id}/logo'],['get','/organizations/{id}/logo'],
  ['get','/fields'],['post','/fields'],['get','/fields/{id}'],['put','/fields/{id}'],['delete','/fields/{id}'],
  ['get','/fields/{id}/treatments'],['post','/fields/{id}/treatments'],['put','/treatments/{id}'],
  ['get','/batches'],['post','/batches'],['get','/batches/{id}'],['get','/batches/{id}/graph'],['get','/batches/{id}/history'],
  ['get','/batches/{id}/path'],['post','/batches/{id}/qr'],['get','/batches/{id}/qr'],['post','/batches/{id}/on-sale'],['post','/batches/{id}/sold'],
  ['post','/processing'],
  ['get','/waybills'],['post','/waybills'],['get','/waybills/{id}'],['post','/waybills/{id}/accept'],['post','/waybills/{id}/reject'],
  ['get','/lab-tests'],['get','/lab-tests/{id}'],['post','/lab-tests/{id}/results'],['put','/lab-tests/{id}/protocol'],['get','/lab-tests/{id}/protocol'],
  ['get','/recalls'],['post','/recalls'],['get','/recalls/{id}'],['get','/recalls/{id}/graph'],
  ['get','/recall-tasks'],['post','/recall-tasks/{id}/confirm'],
  ['get','/complaints'],['get','/complaints/{id}'],['post','/complaints/{id}/decision'],
  ['get','/notifications'],['post','/notifications/read'],['get','/events/stream'],
  ['get','/analytics/dashboard'],['get','/reports/{type}'],
  ['get','/admin/organizations'],['patch','/admin/organizations/{id}'],['post','/admin/organizations/{id}/approve'],
  ['get','/dictionaries/{name}'],['post','/dictionaries/{name}'],['put','/dictionaries/{name}/{id}'],['delete','/dictionaries/{name}/{id}'],
  ['post','/dictionaries/{name}/import'],['put','/dictionaries/products/{id}/image'],
  ['get','/audit-log'],['get','/files/{id}'],
  ['get','/public/batches/{publicCode}'],['post','/public/batches/{publicCode}/complaints'],['get','/public/captcha'],['get','/public/files/{id}'],
  ['get','/health/live'],['get','/health/ready'],
];

describe('openapi contract', async () => {
  const { bundle: b } = await bundle({ ref: new URL('../openapi.yaml', import.meta.url).pathname, config: await loadConfig() });
  const doc = b.parsed as { paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown>; security?: unknown[] }>> };
  it.each(REQUIRED)('%s %s exists', (m, p) => expect(doc.paths[p]?.[m], `${m} ${p}`).toBeDefined());
  it('operationIds are unique', () => {
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('mutating secured operations declare 401 and 403', () => {
    for (const [path, ops] of Object.entries(doc.paths))
      for (const [m, o] of Object.entries(ops))
        if (['post','put','patch','delete'].includes(m) && !path.startsWith('/public') && !path.startsWith('/auth'))
          expect(Object.keys(o.responses), `${m} ${path}`).toEqual(expect.arrayContaining(['401','403']));
  });
});
```

- [ ] **Step 2: Запустить — падает** (пути модулей QA/Admin отсутствуют).
- [ ] **Step 3: Написать YAML и JSON Schema событий.**
- [ ] **Step 4: Проверка** — `./at pnpm --filter @agrotrace/contracts test && ./at pnpm --filter @agrotrace/contracts lint:openapi` → PASS, линт без warnings.
- [ ] **Step 5: Commit** — `feat(contracts): openapi quality, recalls, analytics, admin and queue events`.

---

### Task 11: `packages/api-client`

**Files:**
- Create: `packages/api-client/{package.json,tsconfig.json}`, `src/{index.ts,schema.d.ts (generated),client.ts,session.ts,problem.ts,sse.ts}`, `test/client.test.ts`

**Interfaces:**
- Consumes: `contracts/openapi.yaml`.
- Produces:
  - `createApi(opts: { baseUrl?: string; session: TokenStore; onAuthLost?: () => void }): Api` — `Api` = `openapi-fetch` `Client<paths>` с middleware: подстановка `Authorization`, `X-Request-Id` (uuid), при 401 — один `POST /auth/refresh` (credentials `include`), повтор исходного запроса; при повторном 401 — `onAuthLost()`. Параллельные 401 ждут один общий refresh.
  - `interface TokenStore { get(): string | null; set(token: string | null): void; subscribe(fn: (t: string | null) => void): () => void }`, `createMemoryTokenStore(): TokenStore`.
  - `class ApiProblem extends Error { status; code; rule?; params?; errors? }`; `unwrap<T>(r: { data?: T; error?: unknown; response: Response }): T` бросает `ApiProblem`.
  - `openEventStream(opts: { baseUrl?: string; token: () => string | null; onEvent: (e: { type: 'notification'|'unread'|'reauth'; data: unknown; id?: string }) => void; onError?: (e: Event) => void }): { close(): void }` — переподключение с `Last-Event-ID`, при `reauth` — вызывает refresh через переданный api и переоткрывает поток.
  - `export type { paths, components } from './schema'`; удобные алиасы `type Batch = components['schemas']['Batch']` и т.д. для всех схем Task 8–10.
  - Скрипт `pnpm gen` → `openapi-typescript ../../contracts/openapi.yaml -o src/schema.d.ts`.

- [ ] **Step 1: Падающие тесты** (`test/client.test.ts`, fetch подменяется `vi.fn`):
  - подставляет Bearer из store;
  - на 401 вызывает refresh ровно один раз для трёх параллельных запросов и повторяет все три;
  - при неудачном refresh вызывает `onAuthLost` и очищает store;
  - `unwrap` бросает `ApiProblem` с `rule: 'BR-01'` и `params.until` из тела `application/problem+json`;
  - `X-Request-Id` присутствует и уникален.
- [ ] **Step 2: Запустить — падает.**
- [ ] **Step 3: Реализовать** `client.ts` через `createClient<paths>()` + `client.use(middleware)`; refresh-мьютекс — общий `Promise` в замыкании.
- [ ] **Step 4: Проверка** — `./at pnpm --filter @agrotrace/api-client test` PASS; `tsc --noEmit` без ошибок.
- [ ] **Step 5: Commit** — `feat(api-client): typed fetch client with refresh and SSE`.

---

### Task 12: `packages/validation`

**Files:**
- Create: `packages/validation/{package.json,tsconfig.json}`, `src/{index.ts,common.ts,auth.ts,fields.ts,batches.ts,waybills.ts,processing.ts,lab.ts,recalls.ts,complaints.ts,admin.ts,profile.ts}`, `test/schemas.test.ts`

**Interfaces:**
- Produces Zod-схемы, по одной на каждое тело запроса из Task 8–10, с именем `<Schema>Schema` (например `BatchCreateSchema`, `WaybillCreateSchema`, `LabResultsInputSchema`, `PublicComplaintRequestSchema`, `RegisterOrganizationRequestSchema`, `LoginRequestSchema`), и тип `z.infer` с тем же именем без суффикса.
- Общие примитивы в `common.ts`: `massKg` (строка `^\d{1,9}(\.\d{1,3})?$`, > 0, нормализуется в 3 знака через `.transform`), `inn` (10/12 цифр + контрольная сумма ФНС), `email`, `password` (≥ 10 символов), `uuid`, `isoDate`, `isoDateTime`, `percent`.
- Сообщения ошибок — ключи i18n (`'validation.mass.format'`, `'validation.password.min'` …), не тексты.
- Экспорт `toFieldErrors(e: z.ZodError): Record<string, string[]>` — тот же формат, что `Problem.errors`.

- [ ] **Step 1: Падающие тесты:** для каждой схемы — один валидный пример (берётся из `example` в OpenAPI через бандл контракта, чтобы схемы и контракт не разошлись) и 2–3 невалидных; `inn` — контрольные суммы (валидный `7707083893`, невалидный `7707083894`); `massKg` `"12"` → `"12.000"`, `"0"` → ошибка, `"1.2345"` → ошибка; `toFieldErrors` для вложенного пути `items.0.massDeclaredKg`.
- [ ] **Step 2: Запустить — падает.**
- [ ] **Step 3: Реализовать.** Контрольная сумма ИНН:
```ts
const W10 = [2,4,10,3,5,9,4,6,8];
const W11 = [7,2,4,10,3,5,9,4,6,8];
const W12 = [3,7,2,4,10,3,5,9,4,6,8];
const ctrl = (d: number[], w: number[]) => (w.reduce((s, k, i) => s + k * d[i]!, 0) % 11) % 10;
export function isValidInn(s: string): boolean {
  if (!/^\d{10}(\d{2})?$/.test(s)) return false;
  const d = [...s].map(Number);
  if (d.length === 10) return ctrl(d, W10) === d[9];
  return ctrl(d, W11) === d[10] && ctrl(d, W12) === d[11];
}
```
- [ ] **Step 4: Проверка** — тесты PASS.
- [ ] **Step 5: Commit** — `feat(validation): shared zod schemas aligned with openapi`.

---

### Task 13: `packages/i18n`

**Files:**
- Create: `packages/i18n/{package.json,tsconfig.json}`, `locales/{ru,en}.json`, `src/{index.ts,format.ts,problem.ts}`, `test/i18n.test.ts`

**Interfaces:**
- Produces:
  - `createT(locale: 'ru'|'en'): (key: string, params?: Record<string, string|number>) => string` — подстановка `{name}`, плюрализация `{count, plural, one {…} few {…} many {…} other {…}}` через `Intl.PluralRules`.
  - `formatMass(kg: string, locale): string` → `"12 480,000 кг"`; `formatDate(iso, locale)` → `"14.08.2026"`; `formatDateTime`; `formatPercent`.
  - `problemMessage(p: { code: string; rule?: string; params?: Record<string, unknown> }, t): string` — ключи `rules.BR-01` = `«Отгрузка возможна после {until}: срок ожидания препарата {substance}»` (дата форматируется), `errors.<code>`, фолбэк `errors.UNKNOWN`.
  - Словари: `nav.*`, `status.batch.<Status>`, `status.waybill.*`, `status.labTest.*`, `status.recall.*`, `status.task.*`, `role.*`, `action.*` (глаголы-результаты: «Отгрузить», «Принять», «Запустить отзыв», «Изъято»), `field.*` (подписи полей), `empty.*` (одна строка на пустое состояние), `rules.BR-01…BR-11`, `errors.*` (все `code` из контракта), `validation.*` (все ключи из Task 12), `notification.<TYPE>`.
- Правило копирайта (Global Constraints): заголовки — существительные, никаких пояснительных подзаголовков; тест проверяет отсутствие ключей `*.subtitle`, `*.description`, `*.hint` в `nav` и `page`.

- [ ] **Step 1: Падающие тесты:**
  - паритет ключей ru/en (одинаковые множества);
  - каждый `code` из OpenAPI (перечисление `ProblemCode` в контракте) и каждый `rule` BR-01…BR-11 имеет перевод;
  - каждый ключ `validation.*`, используемый в `@agrotrace/validation` (статический сбор строк `'validation.` из исходников), есть в словаре;
  - `formatMass('12480.000','ru')` → `'12 480,000 кг'` (узкий неразрывный пробел U+202F заменяется на U+00A0 — зафиксировать);
  - `problemMessage({ code: 'BUSINESS_RULE', rule: 'BR-01', params: { until: '2026-09-25', substance: 'Хлорпирифос' } }, t)` → `'Отгрузка возможна после 25.09.2026: срок ожидания препарата Хлорпирифос'`;
  - плюрализация: 1 партия, 3 партии, 5 партий, 21 партия.
- [ ] **Step 2–4:** падает → реализовать → PASS.
- [ ] **Step 5: Commit** — `feat(i18n): ru/en dictionaries, formatters, problem messages`.

---

### Task 14: Дизайн-система — токены, шрифты, база, контраст

**Files:**
- Create: `packages/design-system/{package.json,tokens.css,base.css,fonts.css,index.css}`, `packages/design-system/fonts/*.woff2`, `packages/design-system/scripts/copy-fonts.ts`, `packages/design-system/test/contrast.test.ts`

**Interfaces:**
- Produces: CSS custom properties ровно из ТЗ п. 10.2–10.5 (`--c-*`, `--status-<group>-bg|fg`, `--font-display|body|mono`, `--fs-12…--fs-36`, `--lh-*`, `--sp-1…--sp-12` (4 px шаг: 1=4,2=8,3=12,4=16,5=20,6=24,8=32,12=48), `--r-s|m|l|pill`, `--shadow-1`, `--dur-fast: 120ms`, `--dur: 150ms`, `--ease: cubic-bezier(.2,.7,.2,1)`, `--bp-*` (как документация; в media используются числа)). Тёмная тема — `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` и `:root[data-theme="dark"] {…}`.
- `index.css` = fonts + tokens + base + components (components появятся в Task 15–17).

- [ ] **Step 1: Шрифты.** Зависимости `@fontsource/geologica`, `@fontsource/onest`, `@fontsource/jetbrains-mono`; скрипт `copy-fonts.ts` копирует `*-cyrillic-*` и `*-latin-*` woff2 нужных начертаний (Geologica 600/700, Onest 400/500/600, JetBrains Mono 400/500) в `fonts/` и генерирует `fonts.css` с `@font-face` (`font-display: swap`, `unicode-range` из fontsource). Шрифты коммитятся.

- [ ] **Step 2: Падающий тест контраста.** `test/contrast.test.ts` парсит `tokens.css` (регулярками по блокам `:root`, `:root[data-theme="dark"]`), вычисляет относительную яркость WCAG и проверяет пары (для обеих тем):
  - `--c-ink` / `--c-ground` ≥ 4.5; `--c-ink` / `--c-surface` ≥ 4.5; `--c-ink-muted` / `--c-surface` ≥ 4.5;
  - `--c-field-ink` / `--c-field` ≥ 4.5; `--c-clay` / `--c-surface` ≥ 3 (граница и иконка кнопки danger); текст danger-кнопки `--c-field-ink` / `--c-clay` ≥ 4.5;
  - каждый `--status-*-fg` / `--status-*-bg` ≥ 4.5;
  - `--c-focus` / `--c-ground` ≥ 3.
  Если пара из ТЗ не проходит — цвет корректируется в токенах минимально (сдвиг светлоты) и то же значение правится в ТЗ п. 10.2/10.3.

- [ ] **Step 3: `tokens.css`, `base.css`.** `base.css`: `box-sizing`, `body { background: var(--c-ground); color: var(--c-ink); font: 400 var(--fs-14)/var(--lh-14) var(--font-body); font-variant-numeric: tabular-nums; }`, заголовки Geologica с `text-wrap: balance`, `:focus-visible { outline: 2px solid var(--c-focus); outline-offset: 2px }`, `.at-mono`, `.at-visually-hidden`, `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }`, `::selection` на `--c-straw`.

- [ ] **Step 4: Проверка** — `./at pnpm --filter @agrotrace/design-system test` PASS.
- [ ] **Step 5: Commit** — `feat(design-system): tokens, fonts, base styles with contrast checks`.

---

### Task 15: Компоненты — формы и действия

**Files:**
- Create: `packages/design-system/components/{button,input,textarea,select,combobox,checkbox,radio,switch,date,file,field}.css`, `packages/design-system/showcase/{index.html,forms.html}`, раздел README «Формы»

**Interfaces:**
- Produces разметку (обязательна для всех фреймворков, описывается в README):
  - `<button class="at-button" data-variant="primary|secondary|ghost|danger" data-size="s|m" aria-busy="true?">` + `.at-button__icon` (svg `<use href="#i-…">`).
  - `.at-field` > `label.at-field__label` + контрол + `.at-field__error[role=alert]`; состояние ошибки — `.at-field[data-invalid]` и `aria-invalid="true"` на контроле, `aria-describedby` на id ошибки.
  - `input.at-input`, `textarea.at-textarea`, `select.at-select` (нативный, стилизованный), `.at-combobox` (input `role=combobox` + `ul[role=listbox].at-combobox__list` + `li[role=option][aria-selected]`), `label.at-check > input[type=checkbox] + span`, `.at-radio`, `button.at-switch[role=switch][aria-checked]`, `input[type=date].at-input`, `.at-file` (label-dropzone, `input[type=file]` скрыт, `.at-file__preview img`, `.at-file__progress`), `.at-input-group` с суффиксом (`кг`, `га`, `мг/кг`).
  - Состояния: hover, focus-visible, active, disabled, `[aria-busy]` (спиннер из 3 «борозд» — горизонтальных штрихов, без вращения), invalid. Размер нажатия ≥ 40 px (≥ 44 px при `max-width: 767px`).

- [ ] **Step 1:** Showcase-страница `forms.html` подключает `../index.css` и показывает каждый компонент во всех состояниях, в светлой и тёмной теме (две колонки с `data-theme`).
- [ ] **Step 2:** CSS по токенам; никаких literal-цветов вне `tokens.css` (проверяется тестом Task 17).
- [ ] **Step 3:** README-раздел с разметкой каждого компонента и клавиатурным поведением (combobox: ↑/↓, Enter, Esc, Home/End).
- [ ] **Step 4: Commit** — `feat(design-system): form controls`.

(Автоматическая проверка этих компонентов — в Task 17, где поднимается Playwright для всей витрины.)

---

### Task 16: Компоненты — данные и обратная связь

**Files:**
- Create: `packages/design-system/components/{card,chip,table,pagination,tabs,dialog,toast,stepper,timeline,empty,skeleton,avatar,metric,progress,graph}.css`, `showcase/data.html`, README-раздел

**Interfaces:**
- Produces:
  - `.at-card` (+ `__header`, `__body`, `__footer`), `.at-card[data-furrow]` — полоса борозд 36 px сверху (только для QR-страницы и входа).
  - `.at-chip[data-status="<BatchStatus>"]` → группа цвета по таблице ТЗ п. 10.3 (маппинг статус→группа в CSS через атрибутные селекторы); `.at-chip::before` — точка; `Recalled` — сплошная; `WrittenOff` — точка перечёркнута. Для прочих сущностей — `data-tone="neutral|attention|ok|move|danger|danger-solid"`.
  - `.at-table` (обёртка `.at-table-wrap` с `overflow-x:auto` на ≥ 768), `th[aria-sort]` с кнопкой сортировки; при `max-width: 767px` таблица с `data-cards` перестраивается: `tr` → карточка, `td::before { content: attr(data-label) }`.
  - `.at-pagination`, `.at-tabs` (`role=tablist`), `dialog.at-dialog` (нативный `<dialog>`, `::backdrop` на `rgb(26 24 19 / .45)`), `.at-toast-region[aria-live=polite]` + `.at-toast[data-tone]`, `.at-stepper` (`ol`, `li[aria-current=step]`), `.at-timeline`, `.at-empty` (иллюстрация + одна строка + кнопка), `.at-skeleton`, `.at-avatar[data-size="s|m|l"]` (img или инициалы на `--c-surface-sunk`), `.at-metric` (число Geologica 28, подпись, слот спарклайна), `.at-progress` (`<progress>` стилизованный + подпись «N из M»), `.at-graph` (контейнер Cytoscape, полноэкранный режим `[data-fullscreen]` на < 768).

- [ ] **Step 1–3:** как Task 15 (showcase `data.html`, CSS, README).
- [ ] **Step 4: Commit** — `feat(design-system): data display and feedback components`.

---

### Task 17: Компоненты — каркас приложения + автоматическая проверка витрины

**Files:**
- Create: `packages/design-system/components/{shell,sidebar,bottom-nav,topbar,bell,page}.css`, `showcase/shell.html`, `tests/ds/{package.json,playwright.config.ts,showcase.spec.ts}`, `packages/design-system/test/no-literal-colors.test.ts`
- Modify: `docker-compose.yml` (сервис `playwright`), `at.sh` (`ds:test`)

**Interfaces:**
- Produces:
  - `.at-shell` (grid: sidebar | main; на 768–1023 свёрнутый sidebar 72 px; < 768 — `.at-bottom-nav` fixed снизу с `padding-bottom: env(safe-area-inset-bottom)`), `.at-sidebar` (`nav` + `a[aria-current=page]`), `.at-topbar` (организация + `.at-bell` со счётчиком `.at-bell__count` + `.at-avatar`), `.at-page` (`h1.at-page__title` + `.at-page__actions`, без подзаголовков), `.at-page__toolbar` (поиск + фильтры, на < 768 фильтры в `<details>`).
  - Сервис Compose `playwright` (`mcr.microsoft.com/playwright:v1.48.2-jammy`, профиль tools, монтирует репо).
  - `./at ds:test` — прогон `tests/ds`.

- [ ] **Step 1: Падающие тесты**

`tests/ds/showcase.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const pages = ['index.html', 'forms.html', 'data.html', 'shell.html'];
for (const p of pages) for (const theme of ['light', 'dark'] as const) {
  test(`${p} ${theme} has no a11y violations`, async ({ page }) => {
    await page.goto(`/showcase/${p}?theme=${theme}`);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
  test(`${p} ${theme} screenshot`, async ({ page }) => {
    await page.goto(`/showcase/${p}?theme=${theme}`);
    await expect(page).toHaveScreenshot(`${p}-${theme}.png`, { fullPage: true, maxDiffPixelRatio: 0.01 });
  });
}
test('no horizontal scroll at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  for (const p of pages) {
    await page.goto(`/showcase/${p}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, p).toBeLessThanOrEqual(0);
  }
});
test('table turns into cards below 768px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/showcase/data.html');
  const display = await page.locator('.at-table[data-cards] tbody tr').first().evaluate((el) => getComputedStyle(el).display);
  expect(display).not.toBe('table-row');
});
```
`playwright.config.ts`: `webServer` — `npx http-server packages/design-system -p 4173 -s`, `baseURL: http://localhost:4173`, проекты `desktop` (1280×800) и `mobile` (360×780). Витрина читает `?theme=` и ставит `data-theme` на `<html>`.

`packages/design-system/test/no-literal-colors.test.ts` — ни один файл `components/*.css` и `base.css` не содержит `#[0-9a-f]{3,8}`, `rgb(`, `hsl(` вне `var(`-выражений (кроме разрешённого `::backdrop`, который берёт `--c-backdrop` — добавить токен).

- [ ] **Step 2: Запустить — падает** (`shell.html` отсутствует).
- [ ] **Step 3: Реализовать** CSS каркаса и `shell.html` (полный экран кабинета фермера со списком партий, сайдбаром и шапкой на реальных данных из seed-примеров).
- [ ] **Step 4: Проверка** — `./at ds:test --update-snapshots` один раз, затем `./at ds:test` → PASS; скриншоты коммитятся.
- [ ] **Step 5: Commit** — `feat(design-system): app shell and showcase checks`.

---

### Task 18: Иконки и иллюстрации

**Files:**
- Create: `packages/design-system/icons/*.svg` (40 шт.), `icons/manifest.json`, `scripts/build-sprite.ts`, `sprite.svg` (генерируемый, коммитится), `illustrations/*.svg` (12 шт.), `test/icons.test.ts`, `showcase/icons.html`

**Interfaces:**
- Produces: символы спрайта `#i-<name>`; список имён (manifest): `field, batch, waybill, flask, recall, qr, graph, scale, truck, factory, store, shield, alert, check, close, plus, minus, search, filter, sort, chevron-left, chevron-right, chevron-down, bell, user, users, building, map, calendar, clock, upload, download, file-pdf, image, logout, settings, menu, more, eye, trash`. Иллюстрации: `empty-fields, empty-batches, empty-waybills, empty-lab, empty-recalls, empty-complaints, empty-notifications, empty-search, not-found, forbidden, login, recall-warning`.
- Правила иконок: `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.75"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, только `path|circle|rect|line|polyline`. Иллюстрации: 240×160, цвета только через `var(--c-…)` в атрибутах `style="fill: var(--c-field)"` (чтобы работали в обеих темах при инлайне) — при использовании через `<img>` используется светлая версия; поэтому фреймворки инлайнят иллюстрации как компоненты.

- [ ] **Step 1: Падающий тест** `icons.test.ts`: каждый файл из manifest существует; атрибуты соответствуют правилам; `sprite.svg` содержит ровно manifest-символы; иллюстрации не содержат literal-цветов и `<script>`, `<foreignObject>`.
- [ ] **Step 2–3:** нарисовать SVG вручную (сетка 24, скругления, геометрия по мотивам предмета: колба, весы, грузовик, борозды на `field`), собрать спрайт скриптом.
- [ ] **Step 4:** `./at pnpm --filter @agrotrace/design-system test && ./at ds:test --update-snapshots` (добавлен `icons.html` в список страниц showcase-теста).
- [ ] **Step 5: Commit** — `feat(design-system): icon sprite and illustrations`.

---

### Task 19: Эмулятор ФГИС «Меркурий»

**Files:**
- Create: `mercury-mock/{package.json,tsconfig.json,Dockerfile}`, `src/{server.ts,store.ts}`, `data/vsd.json`, `test/server.test.ts`
- Modify: `docker-compose.yml` (сервис `mercury-mock`, порт 8080 внутри сети)

**Interfaces:**
- Produces REST (формат, упрощённый от ВетИС API, JSON):
  - `GET /api/v1/vsd?productCode=&senderInn=&dateFrom=&dateTo=` → `{ items: Vsd[] }`
  - `GET /api/v1/vsd/{uuid}` → `Vsd` | 404 `{ error: 'NOT_FOUND' }`
  - `GET /health` → `{ status: 'ok' }`
  - `Vsd { uuid, number, issueDate, status: 'CONFIRMED'|'WITHDRAWN'|'UTILIZED', product: { code, name }, volume: { value, unit }, consignor: { inn, name }, consignee: { inn, name }, vetInspection: { result: 'HEALTHY', date, doctor } }`
  - Режимы отказа для проверки адаптеров: заголовок `X-Mock-Fail: 500|timeout` → 500 или задержка 30 с; переменная `MOCK_FAIL_RATE` (0..1).
- Реализация на `node:http` без фреймворков.

- [ ] **Step 1: Падающие тесты** (сервер стартует на случайном порту в `beforeAll`): фильтр по `senderInn`; 404 для неизвестного uuid; `X-Mock-Fail: 500` → 500; health.
- [ ] **Step 2–4:** падает → реализовать → PASS; `docker compose up -d mercury-mock` + `curl http://mercury-mock:8080/health` из tools → ok.
- [ ] **Step 5: Commit** — `feat(mercury-mock): vet documents emulator`.

---

### Task 20: Начальное наполнение (seed)

**Files:**
- Create: `db/seed/{package.json,tsconfig.json}`, `src/{seed.ts,data.ts,files.ts,passwords.ts,scenario.ts}`, `data/{products,substances,indicators,norms,organizations,users,fields}.json`, `images/products/*.jpg` (15), `images/logos/*.svg` (12), `images/avatars/*.jpg` (6), `ATTRIBUTION.md`, `test/seed.test.ts`, `docs/demo-accounts.md`
- Modify: `at.sh` (`seed`, `reset`)

**Interfaces:**
- Consumes: схема Task 3–5, `@agrotrace/domain` (коды, правила), MinIO.
- Produces: `./at seed` (идемпотентен: `TRUNCATE … RESTART IDENTITY CASCADE` всех таблиц, кроме `roles`, `regions`, затем вставка; объекты в MinIO с префиксом `seed/` пересоздаются); `./at reset` = `db:rollback` до нуля + `db:migrate` + `seed`.
- Состав (ТЗ п. 7.8): 15 продуктов с фото, 20 препаратов, 12 показателей, нормативы (каждый продукт × 3–5 показателей), 12 организаций (3 FARM, 2 PROCESSOR, 2 LAB, 3 RETAILER, 1 AUTHORITY, 1 PLATFORM) с логотипами, по 2 пользователя на роль (сотрудник, руководитель) — пароль всех демо-пользователей `agrotrace-demo` (Argon2id PHC `m=65536,t=3,p=1`), 6 полей с контурами GeoJSON во Владимирской области, обработки, 40 партий с графом глубиной 4, накладные, анализы (включая 1 FAIL), 1 закрытый и 1 открытый отзыв с задачами, 2 жалобы, уведомления, `batch_status_history` для каждой партии, согласованная с автоматом (`canTransition` проверяется при генерации — seed падает при невалидной цепочке).
- Фото продуктов — Wikimedia Commons (лицензии CC BY / CC BY-SA / CC0), авторы и ссылки в `ATTRIBUTION.md`; при загрузке фото обрабатываются так же, как в FR-FILE-04 (WebP 96 и 480 через `sharp`), в `files.variants` — `{"96": "<key>", "480": "<key>"}`.
- Логотипы — простые SVG-монограммы в палитре (генерируются скриптом из названий, не импортированы).

- [ ] **Step 1: Падающий тест** `test/seed.test.ts` (запускается после `./at seed`):
  - количества сущностей равны указанным;
  - для каждой партии последовательность `batch_status_history` проходит `canTransition`;
  - для каждой производной партии выполняется `checkMassBalance` по её входам;
  - каждый `files` из seed существует в MinIO (`HeadObject`) для всех вариантов;
  - вход демо-пользователя: `argon2.verify(hash, 'agrotrace-demo')` → true для всех;
  - открытый отзыв: все партии вниз по графу в статусе Recalled, задачи на держателей существуют;
  - `docs/demo-accounts.md` перечисляет всех пользователей из `users.json`.
- [ ] **Step 2–4:** падает → реализовать → `./at seed && ./at pnpm --filter @agrotrace/seed test` PASS; повторный `./at seed` даёт тот же результат.
- [ ] **Step 5: Commit** — `feat(seed): demo data with images, graph and recall scenario`.

---

### Task 21: Шлюз на 9 комбинаций

**Files:**
- Create: `gateway/{Dockerfile,nginx.conf,start/index.html,start/start.js,placeholder/index.html,problem-502.json}`, `tests/gateway/{package.json,gateway.test.ts}`
- Modify: `docker-compose.yml` (сервис `gateway`, порт 80; тома `./frontend-*/dist` → `/srv/<front>` c фолбэком на placeholder), `at.sh` (`gw:test`)

**Interfaces:**
- Consumes: сервисы `api-express`, `api-django`, `api-laravel` (порт 8000 каждый; появятся в следующих планах).
- Produces:
  - `http://{react|angular|svelte}-{express|django|laravel}.localhost/` → статика `/srv/<front>` (SPA fallback на `index.html`);
  - `/api/…` → `http://api-<back>:8000/api/…`, резолв через `resolver 127.0.0.11 valid=10s` и переменную в `proxy_pass` (nginx стартует без запущенных backend);
  - при недоступном backend — 502 `application/problem+json` `{ "type": "about:blank", "title": "Backend unavailable", "status": 502, "code": "BACKEND_UNAVAILABLE", "params": { "backend": "<back>" } }`;
  - `/api/v1/events/` — `proxy_buffering off; proxy_read_timeout 1h;`;
  - заголовки: `X-Frontend: <front>` в ответах статики; `client_max_body_size 12m`;
  - `http://localhost/` — стартовая страница: таблица 3×3 ссылок + статус каждого backend (JS опрашивает `http://localhost/_health/<back>`, который проксирует на `api-<back>:8000/api/v1/health/live`), оформлена токенами дизайн-системы;
  - `http://localhost/_ds/` — витрина дизайн-системы.

`gateway/nginx.conf` (ключевая часть):
```nginx
map $host $front { ~^(?<f>react|angular|svelte)-(express|django|laravel)\.localhost$ $f; default ""; }
map $host $back  { ~^(react|angular|svelte)-(?<b>express|django|laravel)\.localhost$ $b; default ""; }

server {
  listen 80;
  server_name ~^(react|angular|svelte)-(express|django|laravel)\.localhost$;
  resolver 127.0.0.11 valid=10s ipv6=off;
  client_max_body_size 12m;
  root /srv/$front;

  location /api/v1/events/ {
    proxy_pass http://api-$back:8000;
    proxy_http_version 1.1; proxy_set_header Connection "";
    proxy_buffering off; proxy_cache off; proxy_read_timeout 1h;
    proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_intercept_errors on; error_page 502 503 504 = @backend_down;
  }
  location /api/ {
    proxy_pass http://api-$back:8000;
    proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_intercept_errors on; error_page 502 503 504 = @backend_down;
  }
  location @backend_down {
    default_type application/problem+json;
    return 502 '{"type":"about:blank","title":"Backend unavailable","status":502,"code":"BACKEND_UNAVAILABLE","params":{"backend":"$back"}}';
  }
  location / {
    add_header X-Frontend $front always;
    try_files $uri $uri/ /index.html;
  }
}

server {
  listen 80 default_server;
  server_name localhost;
  resolver 127.0.0.11 valid=10s ipv6=off;
  root /srv/start;
  location ~ ^/_health/(express|django|laravel)$ {
    set $b $1;
    proxy_pass http://api-$b:8000/api/v1/health/live;
    proxy_intercept_errors on; error_page 502 503 504 = @down;
  }
  location @down { default_type application/json; return 503 '{"status":"fail"}'; }
  location /_ds/ { alias /srv/ds/; }
}
```

`proxy_intercept_errors on` перехватывает и 502, отданные самим backend. Чтобы не маскировать бизнес-ответы, backend-реализации не используют 502–504 (зафиксировать в README контракта).

- [ ] **Step 1: Падающие тесты** `tests/gateway/gateway.test.ts` (fetch к `http://gateway` с заголовком `Host`):
  - для всех 9 хостов `GET /` → 200, `X-Frontend` = имя фронта, тело содержит `<div id="app">` placeholder'а;
  - `GET /batches/123` (глубокий SPA-маршрут) → 200 `index.html`;
  - `GET /api/v1/health/live` при незапущенных backend → 502, `content-type: application/problem+json`, `params.backend` = имя из хоста;
  - `http://localhost/` → 200, содержит 9 ссылок `*.localhost`;
  - неизвестный хост `foo.localhost` → стартовая страница (default_server).
- [ ] **Step 2–4:** падает → реализовать → `./at up gateway && ./at gw:test` PASS.
- [ ] **Step 5: Commit** — `feat(gateway): nginx routing for 9 front/back combinations`.

---

### Task 22: CI и документация фундамента

**Files:**
- Create: `.github/workflows/ci.yml`, `docs/deploy.md`
- Modify: `README.md`

**Interfaces:**
- Produces: workflow `ci` с jobs: `lint` (pnpm lint + tsc по пакетам), `contracts` (lint:openapi + vectors), `packages` (domain, api-client, validation, i18n, design-system unit), `db` (service postgres 16 → dbmate up → tests/db → seed → seed tests; MinIO как service), `ds` (Playwright-контейнер, showcase), `gateway` (docker compose up gateway + tests/gateway). Последующие планы добавляют jobs `api`, `cross`, `e2e` с матрицей.

- [ ] **Step 1:** написать `ci.yml` (Node 22 + pnpm cache; job `db` использует `services: postgres, minio`; job `ds` — `container: mcr.microsoft.com/playwright:v1.48.2-jammy`).
- [ ] **Step 2:** `docs/deploy.md`: требования (Docker Desktop, Git), `./at install`, `./at up infra`, `./at db:migrate`, `./at seed`, `./at up`, адреса сервисов (Mailpit 8025, MinIO 9001, RabbitMQ 15672, стартовая страница `http://localhost`), переменные `.env`.
- [ ] **Step 3:** `README.md`: одна страница — что это, структура репозитория (из ТЗ п. 15.1), быстрый старт (5 команд), ссылки на ТЗ и планы.
- [ ] **Step 4: Проверка локально** — прогнать все команды из `docs/deploy.md` на чистом клоне (`git clone . /tmp/at-check` внутри tools-контейнера не требуется — достаточно `./at down -v && ./at up infra && ./at db:migrate && ./at seed && ./at test && ./at ds:test && ./at gw:test`) → всё PASS.
- [ ] **Step 5: Commit** — `ci: foundation pipeline and deploy docs`.

---

## Последующие планы (пишутся по завершении Плана 0)

| План | Содержание | Опирается на |
|---|---|---|
| 1. Express | Весь API по контракту, worker, scheduler, SSE, файлы; общие наборы `tests/api`, `tests/cross` (харнесс) | План 0 |
| 2. React | Все экраны п. 9.4–9.6; общий набор `tests/e2e` | Планы 0–1 |
| 3. Django | Реализация по контракту; прохождение `tests/api`, `tests/cross` | Планы 0–1 |
| 4. Angular | Прохождение `tests/e2e` на Express и Django | Планы 0–3 |
| 5. Laravel | Прохождение `tests/api`, `tests/cross` | Планы 0–1 |
| 6. Svelte | Прохождение `tests/e2e` на 9 комбинациях | Планы 0–5 |
| 7. Бенчмарк | Раздел 13 ТЗ (10 000 записей на сущность) | План 0 (может идти параллельно 3–6) |
| 8. Стабилизация и отчёты | k6, ZAP, визуальные сравнения, мониторинг, три отчёта | Все |
