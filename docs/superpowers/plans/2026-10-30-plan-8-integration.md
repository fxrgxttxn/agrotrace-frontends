# План 8 «Интеграция 3×3 и стабилизация» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Все 9 комбинаций frontend × backend работают одновременно через один шлюз против настоящих backend (без моков), общий e2e-набор `tests/e2e` зелёный на всех 9, накопленный межреализационный backlog разобран (исправлен или задокументирован), CI гоняет матрицу 3×3, документация описывает итоговую систему.

**Architecture:** Новых сервисов приложения нет. Меняются:
- шлюз `gateway` — отдаёт три production-сборки фронтов на 9 хостах `{front}-{back}.localhost` (символьные ссылки на смонтированные каталоги фронтов, решение PL2), gzip, кеш `/assets/` только для 200;
- `docker-compose.yml` — одноразовый сервис `fronts` (сборка трёх фронтов), чтобы `docker compose up` поднимал всю матрицу (PL3);
- `at.sh` — `up all` без пересоздания инфраструктуры, `e2e` против настоящего backend через главный шлюз с профилем `docker-compose.e2e.yml`, `e2e:matrix`;
- точечные исправления в `packages/api-client`, `packages/design-system`, `packages/validation`, `packages/mock-api`, трёх backend и в контракте — каждое сразу во всех затронутых реализациях.

Порядок: Task 1 поднимает матрицу и записывает фактические отказы (базовая линия) → Task 2 (Laravel 12, по решению пользователя) → Tasks 3–7 исправления по областям → Task 8 CI → Task 9 документация → Task 10 полная проверка.

**Tech Stack:** nginx 1.27-alpine (шлюз), Docker Compose v2 (на стенде v5.5.1), Playwright 1.48.2 (`mcr.microsoft.com/playwright:v1.48.2-jammy`), Vitest (tests/api, tests/cross, tests/gateway, tests/at, пакеты), Express/TypeScript, Django 5 (uvicorn, Celery), Laravel 11→12 (Octane/FrankenPHP, Pest), React/Angular/SvelteKit, GitHub Actions.

**Spec:** `docs/tz-agrotrace-v2.md`:
- §14.1 (таблица видов тестов: «Кросс-backend — все 6 упорядоченных пар», «E2E — 9 комбинаций»);
- §14.3 (CI: «E2E матрица 3×3»);
- §14.4 («Все 9 комбинаций одновременно — `docker compose up`», стартовая страница 3×3);
- §15.5 (критерии приёмки: e2e на 9 комбинациях, покрытие домена ≥ 70 % в каждой backend-реализации, «Система разворачивается одной командой `docker compose up`», 360/768/1280 px).

**Contract (binding):** `contracts/openapi.yaml` + `contracts/openapi/**`, `contracts/rules/*.json`, `contracts/events/*.schema.json`, `infra/rabbitmq/definitions.json`. В этом плане контракт **может** уточняться (PL6) — только вместе со всеми тремя backend (и `packages/mock-api`, если операция у него есть) в одной задаче.

**Rulings:** `docs/superpowers/rulings.md` (R1–R93); решения P1–P61 (`.superpowers/sdd/2026-09-25-plan-1-express/progress.md`); `docs/superpowers/plans/port-globals.md`; решения Q* журналов Планов 3 и 5 (`C:/project-wt/plan-3/.superpowers/sdd/2026-10-21-plan-3-django/progress.md`, `C:/project-wt/plan-5/.superpowers/sdd/2026-10-21-plan-5-laravel/progress.md`); межфреймворковые решения F1–F12 и FM1–FM37 фронтов (`C:/project-wt/plan-2/.superpowers/sdd/2026-09-25-plan-2-react/progress.md`, зеркально в plan-4, plan-6, mock-api). Собственные решения этого плана — PL1–PL16 ниже; контроллер переносит их в журнал SDD плана.

Порядок приоритета: пользователь → решения → ТЗ → планы.

## Рабочее место и общий стенд

- Worktree `C:/project-wt/plan-8`, ветка `feat/plan-8-integration` от `main` (5dbc562). Создаётся по навыку superpowers:using-git-worktrees: `git worktree add C:/project-wt/plan-8 -b feat/plan-8-integration main`. Локальный `.env` — копия `C:/project/.env` (там `GATEWAY_PORT=8088`).
- Журнал SDD: `C:/project-wt/plan-8/.superpowers/sdd/2026-10-30-plan-8-integration/` (не отслеживается git). Базовая линия Task 1 — файл `matrix-baseline.md` там же; Tasks 3–7 читают его.
- Стенд один: compose-проект `agrotrace` (сейчас подняты все три backend, шлюз смонтирован из `C:/project-wt/plan-5`). Этот план — единственный поток; секции SP3 (`# --- django (plan 3) ---` и т. п.) остаются, новые общие блоки идут в секции `# --- integration (plan 8) ---` … `# --- end integration ---`.
- Шлюз принадлежит этому плану: он пересоздаётся только командами `./at.sh up gateway`, `./at.sh up all`, `./at.sh up <front> <back>` (под замком). После пересоздания из worktree шлюз монтирует фронты worktree; после слияния пользователь пересоздаёт его из `C:/project`.

## Global Constraints

- **Чужие контейнеры не трогаются никогда:** всё вне compose-проекта `agrotrace` (`zagruzka-*`, `qa*`, `karkasproekt-*` и любые другие) — ни stop, ни restart, ни rm, ни exec.
- **Общая инфраструктура не перезапускается, не пересоздаётся и не очищается:** `postgres`, `redis`, `rabbitmq`, `minio`, `minio-init`, `mailpit`, `mercury-mock`. Запрещены `./at down`, `docker compose down`, `--remove-orphans`, `docker compose restart <инфраструктура>`, `rabbitmqctl purge_queue`, `FLUSHALL` вне `./at.sh reset`. Инфраструктура поднимается только через `infra_up` (`--no-recreate` для postgres/rabbitmq). Изменение `infra/rabbitmq/definitions.json` в этом плане не допускается.
- **Замок стенда:** каждая команда, меняющая стенд, идёт через `at.sh` и берёт замок сама (`api:test`, `cross:test`, `docs:test`, `gw:test`, `test:all`, `reset`, `seed*`, `db:*`, `up`, `e2e` против настоящего backend, новые `e2e:matrix` и `fe:build` без `--mock`); разовая команда на стенде вне списка — `./at.sh lock:run <команда…>`. `AT_NO_LOCK=1` не используется.
- **Бюджет соединений PostgreSQL (P61) не меняется:** Express 20, Django 20, Laravel 19 (таблица `port-globals.md` §8); `max_connections=100` не меняется; инструменты ≤ 30. Новые сервисы плана (`fronts`, Playwright) к БД не подключаются. `e2e:matrix` гоняет комбинации по одной.
- **Обязательства портов сохраняются:** Global Constraints Планов 3 и 5, `port-globals.md`, `.superpowers/sdd/2026-09-25-plan-1-express/plan-globals.md` — роль `agrotrace_app` через `APP_DATABASE_URL`, Redis без префикса, порядок блокировок R52/P57, время транзакции P43, маскирование секретов P8 (никакого `access_token`, `sig`, токена Telegram, привязок SQL в журналах), `X-Backend` на каждом ответе.
- **Контракт и общие наборы (PL6):** правка `contracts/**`, `tests/api`, `tests/cross` допустима, только если она backend-нейтральна (P58: без имён backend), и в той же задаче все три backend (и `packages/mock-api` для операций, которые он реализует) приведены к новому тексту. Задача закрывается только при зелёных `./at.sh api:test <back> <файл>` по изменённым файлам для каждого из трёх backend; `./at.sh pnpm --filter @agrotrace/contracts test` зелёный.
- **Правила фронтов (журналы Планов 2/4/6):** разметка компонентов — строго по `packages/design-system/README.md`; UI-библиотеки запрещены; без неона, свечения и текста-заполнителя; тексты только из `@agrotrace/i18n` с одинаковыми ключами во всех трёх фронтах; одинаковый DOM в трёх фреймворках; фокус на `h1.at-page__title` при смене пути (F4, FM7, FM10); селекторы `tests/e2e` — только роли и доступные имена; скриншоты 360 и 1280 px (таблицы — и 768) в светлой и тёмной теме просмотрены до коммита; эталоны `tests/e2e/__screenshots__` — снимки React на mock (обновляются только `./at e2e react mock visual.spec.ts --update-snapshots`); бюджеты публичной страницы (Angular 60 KB и др.) не превышаются; калибровка серьёзности ревью — FM31.
- **Копирайт:** интерфейс на русском; в шаблонах Telegram нет эмодзи (R92).
- **Коммиты:** Conventional Commits, LF; каждое сообщение заканчивается пустой строкой и `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Ничего не пушится; на `main` не коммитится (слияние делает пользователь).
- **Проверка в worktree:** `./at.sh at:test` в worktree даёт одну известную ошибку окружения («./at wrapper … 100755», решения Q3/Q6); она не считается провалом.

## Review Focus

1. **Сессия через шлюз на каждом из 9 хостов:** cookie `at_refresh` (host-only, `Path=/api/v1/auth`, `HttpOnly; Secure; SameSite=Strict`) выставляется и ротируется на `http://*.localhost`; перезагрузка страницы во время refresh не выкидывает пользователя молча — проверка в Task 1 (шаг 9), исправление в Task 3.
2. **Одно уведомление — один тост:** повтор SSE (окно 60 с P46, полный replay Laravel, переподключение после рестарта backend) не показывает тост дважды — `sse.test.ts` в Task 3 и e2e `scenarios.spec.ts` на 9 комбинациях.
3. **Большой replay:** пачка непрочитанных > 1 МиБ доходит до читающего клиента целиком и не зацикливает переподключения на всех трёх backend — tests/api в Task 4.
4. **Загрузки и скачивания через шлюз на каждом backend:** аватар, протокол 10 МБ, QR PDF, отчёты XLSX/PDF — тот же статус и то же имя файла в `Content-Disposition` — e2e `admin.spec.ts` (отчёты) и `matrix.spec.ts` (скачивание журнала аудита) на 9 комбинациях.
5. **Данные одной реализации глазами другой:** партия и статусы, записанные одним backend, одинаково показываются фронтом другого backend (одна БД; Moscow в браузере, UTC на backend) — `matrix.spec.ts` (Task 1) сверяет карточку демо-партии на 9 хостах.

## Решения плана (PL1–PL16)

- **PL1 — объём e2e.** Полный набор `tests/e2e` на **всех 9** комбинациях: локально в Task 10 (`./at.sh e2e:matrix`), в CI — 9 параллельных job (Task 8); плюс один прогон `matrix.spec.ts`, когда все 9 подняты одновременно. Обоснование: против настоящего backend набор — 21 тест (12 визуальных пропускаются вне mock), дефекты интеграции зависят от пары (SSE-обёртка фреймворка × поведение backend, cookie и лимиты backend), диагональ пропустила бы 6 из 9 пар. Запасное правило: если Task 1 измерит полный прогон одной комбинации дольше 20 мин, локальный прогон Task 10 — полный набор на диагонали (react×express, angular×django, svelte×laravel) + `scenarios.spec.ts` и `public.spec.ts` на остальных 6; CI остаётся полным 3×3.
- **PL2 — шлюз отдаёт сборки через символьные ссылки.** В шлюз монтируются каталоги фронтов целиком (`./frontend-<f>:/srv/src/<f>:ro`), а `/srv/<f>` — символьная ссылка на `/srv/src/<f>/<out>` (`dist` у React и Angular, `build` у Svelte) или на `/srv/placeholder`, если сборки нет. Причина: Angular (`deleteOutputPath`) и SvelteKit (adapter-static) удаляют выходной каталог целиком, и прямой bind mount `dist` после пересборки указывает в пустоту (бэклог Svelte «fresh build with running gateway fails»). Ссылка разрешается по пути при каждом запросе, поэтому пересборка видна сразу.
- **PL3 — `docker compose up` поднимает всё.** Одноразовый сервис `fronts` (образ `tools`) собирает три production-сборки; шлюз зависит от него с `condition: service_completed_successfully, required: false`. Команды `at.sh` поднимают шлюз с `--no-deps` и собирают фронты сами.
- **PL4 — профиль e2e.** `docker-compose.e2e.yml` задаёт для `api-<back>` только `RATE_LIMIT_OVERRIDES: '{"user":100000,"login-ip":100000,"complaint-ip":100000}'` и `DADATA_API_KEY: ''` (P34, P41, P31). На время прогона `e2e <front> <back>` api пересоздаётся с профилем, по выходу — возвращается к обычной конфигурации (как `api_test`).
- **PL5 — e2e против настоящего backend идёт только через главный шлюз** (`GATEWAY_HOST=gateway`, сервис `playwright` в сети `at`), стенды `gateway-react|angular|svelte` используются только для `mock`. Флаг `--reset` выполняет `./at.sh reset` перед прогоном; `e2e:matrix` делает reset перед каждой комбинацией.
- **PL6 — правки контракта и общих наборов** (см. Global Constraints).
- **PL7 — replay SSE.** Часть «поздних коммитов» (строки `seq < L`, непрочитанные, не старше 60 с до строки L) ограничена **100 строками с наибольшими `seq`** (выдаются по возрастанию `seq`). Весь replay пишется с обратным давлением: при буфере потока > 1 МиБ запись ждёт освобождения буфера до 10 с; нет прогресса 10 с — поток завершается. Правило «клиент не читает → > 1 МиБ в буфере → поток закрыт» остаётся для живых событий. Текст — в `contracts/openapi/paths/events.yaml`.
- **PL8 — `retry:` и лимиты потоков.** Каждый допущенный поток первым полем отправляет `retry: 3000` (все три backend). Реализация может ограничить число одновременных потоков (на процесс и на пользователя); поток сверх лимита получает `200 text/event-stream` с единственным полем `retry: <5000–15000>` и закрывается. Лимиты Laravel (200 на процесс, 10 на пользователя) записываются в контракт как пример.
- **PL9 — клиент отсекает повторы.** `openEventStream` (`packages/api-client/src/sse.ts`) не передаёт `notification`, чей `data.id` уже передавался этим экземпляром потока (также после переподключений); хранит не больше 1000 последних id (старые забываются первыми).
- **PL10 — uuid сравниваются без учёта регистра** (каноническая форма — нижний регистр): дубли элементов массивов (`noDuplicate`), `challengeId` 2FA, ключи по uuid.
- **PL11 — одиночный суррогат** (`\uD800–\uDFFF` без пары) в любой строке JSON-тела — тот же ответ, что и невалидный JSON: `400 VALIDATION`, `errors: {_root: ['validation.invalid']}`.
- **PL12 — граница календаря.** Значение `DateTime`/`Date` в **теле** запроса с годом `0000` → ошибка формата поля (`validation.dateTime.format` для `DateTime`; для `Date` — ключ проверки `Date` в `packages/validation/src/common.ts`). Даты в параметрах запроса (периоды отчётов и аналитики) прижимаются к `0000-01-01` … `9999-12-31` во всех трёх backend: подписи периода и имена файлов — всегда `YYYY-MM-DD`/`YYYY-MM`.
- **PL13 — остановка потребителя.** Сообщение, обработка которого прервана остановкой процесса, не отправляется в DLQ: оно остаётся неподтверждённым, брокер возвращает его в очередь при закрытии канала (поведение Laravel, решение Плана 5 по Task 6). Текст — в контракте рядом с правилом P56 (алгоритм повторов потребителя и очередь `.delay`).
- **PL14 — отчёты PDF.** Ячейка выше страницы продолжается на следующей странице, заголовок таблицы повторяется (все три backend). Ответ `503 BACKEND_UNAVAILABLE {reason: report-busy}` при превышении ресурсов остаётся ответом контракта; худший случай измеряется и записывается (Task 7).
- **PL15 — известные ограничения** собираются в новый документ `docs/known-limitations.md` (по-русски): каждый пункт корзины K из таблицы бэклога с обоснованием и наблюдаемым эффектом; ссылка из `README.md` и `docs/deploy.md`.
- **PL16 — Laravel 12.** Переход `laravel/framework` 11 → 12 (Task 2) — если пользователь согласен (см. «Решения пользователя»); иначе Task 2 пропускается, а пункт P17 уходит в K.

## Файловая структура (что меняется)

| Файл | Ответственность |
|---|---|
| `gateway/Dockerfile`, `gateway/40-fronts.sh` (новый), `gateway/placeholder/index.html` | символьные ссылки `/srv/<f>` (PL2), заглушка со ссылкой на `/assets/placeholder.js` |
| `gateway/nginx.conf.template` | gzip, `Cache-Control` для `/assets/` только при 200 |
| `docker-compose.yml` | монтирование фронтов в шлюз, сервис `fronts`, зависимость шлюза |
| `docker-compose.e2e.yml` (новый) | профиль e2e (PL4) |
| `at.sh`, `tests/at/at.test.ts` | `up all`, `up <front> <back>`, `fe:build`, `e2e`, `e2e:matrix`, `test:all`, список замка |
| `tests/e2e/matrix.spec.ts` (новый), `tests/e2e/*.spec.ts`, `tests/e2e/helpers.ts` | одновременная проверка 9 хостов; поправки по базовой линии |
| `tests/gateway/gateway.test.ts` | шлюз без допущения «всегда заглушка» |
| `packages/api-client/src/sse.ts`, `session.ts`/`client.ts` | PL9, Retry-After на refresh 429 |
| `packages/design-system/**`, фронты | таблица заявок на 768 px с MANUAL_CHECK (если базовая линия подтвердит) |
| `packages/mock-api/src/**` | дельты mock ↔ контракт (P18) |
| `packages/validation/src/common.ts` и схемы | PL10, PL12 |
| `contracts/openapi.yaml`, `contracts/openapi/paths/events.yaml` | PL7, PL8, PL10–PL13 |
| `tests/api/events.test.ts`, `contract-shape.test.ts`, `processing.test.ts`, `fields.test.ts`, `complaints.test.ts`, `reports.test.ts`, `auth.test.ts` | пины новых правил |
| `backend-express/src/**`, `backend-django/agrotrace/**`, `backend-laravel/app/**` | исправления паритета |
| `.github/workflows/ci.yml` | матрица e2e 3×3, smoke 9 хостов, пары django↔laravel, покрытие домена |
| `README.md`, `docs/deploy.md`, `docs/ИНСТРУКЦИЯ.md`, `docs/demo-accounts.md`, `docs/known-limitations.md` (новый) | документация итоговой системы |

---

### Task 1: Матрица 3×3 на одном шлюзе и базовая линия отказов

Поднять все 9 комбинаций через главный шлюз, дать команды для e2e против настоящих backend и записать фактические отказы. Продуктовые дефекты здесь **не исправляются** — только классифицируются для Tasks 3–7.

**Files:**
- Modify: `gateway/Dockerfile` (заглушка в `/srv/placeholder`, точки монтирования `/srv/src/{react,angular,svelte}`, `COPY 40-fronts.sh /docker-entrypoint.d/40-fronts.sh`)
- Create: `gateway/40-fronts.sh`
- Modify: `gateway/placeholder/index.html` (добавить `<script src="/assets/placeholder.js"></script>`)
- Modify: `gateway/nginx.conf.template` (gzip; `/assets/` кеш по статусу; SSE без gzip)
- Modify: `docker-compose.yml` (шлюз, сервис `fronts`)
- Create: `docker-compose.e2e.yml`
- Modify: `at.sh` (`up all`, `up_combo`, `fe_build`, `e2e`, `e2e:matrix`, список замка)
- Create: `tests/e2e/matrix.spec.ts`
- Modify: `tests/gateway/gateway.test.ts`, `tests/at/at.test.ts`
- Create (не отслеживается): `.superpowers/sdd/2026-10-30-plan-8-integration/matrix-baseline.md`

**Interfaces:**
- Consumes: существующие `infra_up`, `backend_services`, `quiet_schedulers`/`wake_schedulers`, `fe_build`, `reset` в `at.sh`; `signIn`, `watch`, `unexpected`, `settle`, `demoCode` из `tests/e2e/helpers.ts`.
- Produces (для Tasks 3–10):
  - `./at.sh up all` — infra (`--no-recreate`), `minio-init`, `fronts`, затем `up -d --build --no-deps --wait` девяти backend-сервисов и `gateway`; печатает 9 адресов `http://{front}-{back}.localhost:${GATEWAY_PORT}/`.
  - `./at.sh up <front> <back>` — как раньше, плюс `fe:build <front>` перед шлюзом (пропуск: `AT_SKIP_FE_BUILD=1`).
  - `./at.sh fe:build <front>` (без `--mock`) — под замком; если главный шлюз запущен, после сборки выполняет `docker compose exec -T gateway sh /docker-entrypoint.d/40-fronts.sh` и `nginx -s reload`.
  - `./at.sh e2e <front> <express|django|laravel> [--reset] [playwright args…]` — главный шлюз (PL5), профиль `docker-compose.e2e.yml` на `api-<back>` на время прогона (PL4), возврат по EXIT.
  - `./at.sh e2e:matrix [--smoke]` — без флага: для `back` в `express django laravel`, для `front` в `react angular svelte`: `reset`, `e2e front back`; итоговая таблица `front back rc seconds` в stdout и в `tests/e2e/test-results/matrix-summary.txt`; код выхода ≠ 0, если хоть одна комбинация упала. С `--smoke`: один прогон `matrix.spec.ts` с `MATRIX=1` против всех 9 одновременно (без профиля e2e, без reset).
  - `tests/e2e/matrix.spec.ts` — пропускается целиком без `MATRIX=1`.

- [ ] **Step 1: Написать падающие тесты `tests/at` (режим `AT_DRY_RUN=1`)**

```ts
it('up all: infra without recreate, the fronts builder, nine backend services and the gateway with --no-deps', () => {
  const out = dry('up all');
  expect(out).toMatch(/up -d --no-recreate --wait postgres rabbitmq/);
  expect(out).toMatch(/up --build --no-deps fronts|run --rm --no-deps fronts/);
  expect(out).toMatch(/up -d --build --no-deps --wait api-express worker-express scheduler-express api-django worker-django beat-django api-laravel worker-laravel scheduler-laravel gateway/);
  expect(out).not.toMatch(/--remove-orphans|\bdown\b/);
});
it('e2e svelte laravel: the main gateway, the e2e profile on api-laravel only, restored on exit', () => {
  const out = dry('e2e svelte laravel');
  expect(out).toMatch(/-f docker-compose\.yml -f docker-compose\.e2e\.yml up -d --no-build --no-deps --wait api-laravel/);
  expect(out).toMatch(/run --rm -e FRONT=svelte -e BACK=laravel -e GATEWAY_HOST=gateway .* playwright npx/);
  expect(out).not.toMatch(/playwright-svelte|gateway-svelte/);
});
it('e2e react mock still uses the stand gateway', () => { expect(dry('e2e react mock')).toMatch(/GATEWAY_HOST=gateway-react/); });
it('e2e:matrix resets before each of the nine combinations', () => {
  const out = dry('e2e:matrix');
  expect(out.match(/reset/g)?.length).toBe(9);
  for (const b of ['express', 'django', 'laravel']) for (const f of ['react', 'angular', 'svelte'])
    expect(out).toMatch(new RegExp(`FRONT=${f} -e BACK=${b}`));
});
it('e2e:matrix --smoke runs matrix.spec.ts once with MATRIX=1', () => {
  expect(dry('e2e:matrix --smoke')).toMatch(/-e MATRIX=1 .*playwright test matrix\.spec\.ts/);
});
it('fe:build react refreshes the running main gateway', () => {
  expect(dry('fe:build react', { AT_DRY_GATEWAY: '1' })).toMatch(/exec -T gateway sh \/docker-entrypoint\.d\/40-fronts\.sh/);
});
```

(`dry` — существующий помощник файла; если его нет — вызов `at.sh` с `AT_DRY_RUN=1` по образцу соседних тестов. `AT_DRY_GATEWAY=1` имитирует запущенный главный шлюз.)

- [ ] **Step 2: Написать падающие тесты шлюза** в `tests/gateway/gateway.test.ts`: заменить «serves the placeholder» на «serves the front's index (build or placeholder) with X-Frontend»; добавить:

```ts
it('an existing /assets/ file is immutable, a missing one is not (FM14)', async () => {
  const asset = firstAssetPath(await (await fetchAs('react-express.localhost', '/')).text()); // first src|href="/assets/…"
  expect((await fetchAs('react-express.localhost', asset)).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  const miss = await fetchAs('react-express.localhost', '/assets/does-not-exist.js');
  expect(miss.status).toBe(404);
  expect(miss.headers.get('cache-control')).toBe('no-store');
});
it('JS is gzip-encoded on request, the event stream never is', async () => {
  const js = await fetchAs('react-express.localhost', asset, { 'accept-encoding': 'gzip' });
  expect(js.headers.get('content-encoding')).toBe('gzip');
  const sse = await fetchAs('react-express.localhost', '/api/v1/events/stream?access_token=x', { 'accept-encoding': 'gzip' });
  expect(sse.headers.get('content-encoding')).toBeNull();
});
```

- [ ] **Step 3: Запустить и увидеть падение**

Run: `./at.sh at:test` и `./at.sh up gateway && ./at.sh gw:test`
Expected: новые тесты FAIL (нет `up all` с `--no-deps`, нет `e2e:matrix`, нет gzip, 404 с `immutable`).

- [ ] **Step 4: Реализовать шлюз**
  - `gateway/40-fronts.sh` (POSIX sh, идемпотентный): для пар `react:dist angular:dist svelte:build` — `ln -sfn /srv/src/<f>/<out> /srv/<f>`, если существует `/srv/src/<f>/<out>/index.html`, иначе `ln -sfn /srv/placeholder /srv/<f>`. Каталоги `/srv/<f>` из Dockerfile убрать (вместо них ссылки).
  - `nginx.conf.template`: в `http` — `gzip on; gzip_vary on; gzip_min_length 1024; gzip_types text/css application/javascript image/svg+xml application/json;`; в `location /api/v1/events/` — `gzip off;`; `map $status $assets_cache { 200 'public, max-age=31536000, immutable'; default 'no-store'; }` и в обоих `location /assets/` — `add_header Cache-Control $assets_cache always;`. Brotli не добавляется (модуля нет в nginx:alpine; K20).
  - `docker-compose.yml`, сервис `gateway`: тома `./frontend-react:/srv/src/react:ro`, `./frontend-angular:/srv/src/angular:ro`, `./frontend-svelte:/srv/src/svelte:ro` (рядом с `./packages/design-system:/srv/ds:ro`), `depends_on: { fronts: { condition: service_completed_successfully, required: false } }`. Комментарий о «plans that create those directories» заменить описанием PL2.
  - Сервис `fronts` (в секции `# --- integration (plan 8) ---`): `build` как у `tools`, без профиля, тома как у `tools`, `restart: "no"`, команда `sh -c 'pnpm install --frozen-lockfile && pnpm --filter @agrotrace/frontend-react build && pnpm --filter @agrotrace/frontend-angular build && pnpm --filter @agrotrace/frontend-svelte build'`, без сетей БД.

- [ ] **Step 5: Реализовать команды `at.sh`** по блоку Interfaces. `up all` больше не вызывает голый `$DC up -d --build --wait` (он пересоздаёт инфраструктуру при расхождении конфигурации). `e2e` для настоящего backend: `quiet_schedulers "$back"` как сейчас; `restore()` возвращает `api-<back>` (`up -d --no-build --no-deps --wait api-<back>`) и затем будит планировщики. `e2e:matrix` берёт замок один раз (вложенные вызовы — `AT_LOCK_HELD`). Добавить `e2e:matrix` и `fe:build` (без `--mock`) в список замка.

- [ ] **Step 6: Написать `tests/e2e/matrix.spec.ts`**

```ts
const ON = process.env.MATRIX === '1';
for (const back of ['express', 'django', 'laravel'] as const)
  for (const front of ['react', 'angular', 'svelte'] as const)
    test.describe(`${front}-${back}`, () => {
      test.skip(!ON, 'the matrix smoke runs only with MATRIX=1 (./at e2e:matrix --smoke)');
      test.use({ baseURL: `http://${front}-${back}.localhost` });
      test(`${front}-${back}: sign in, the live stream, the shared demo batch, the audit download, sign out`, async ({ page }) => {
        const w = await watch(page);
        const me = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/me');
        const stream = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/events/stream');
        await signIn(page, 'inspector@agrotrace.test', w);
        expect((await me).headers()['x-backend']).toBe(back);
        const s = await stream;
        expect(s.status()).toBe(200);
        expect(s.headers()['content-type']).toMatch(/^text\/event-stream/);
        // the demo batch of public.spec.ts (same demoCode number) shows the same status chip on every host
        // the audit log XLSX download: status 200, the same file name pattern as admin.spec.ts
        await signOut(page);
        expect(unexpected(w)).toEqual([]);
      });
      test(`${front}-${back}: the public QR page of the on-sale demo batch`, async ({ page }) => { /* /p/<demoCode>, h1, no unexpected */ });
    });
```

Номер демо-партии и ожидаемый текст статуса брать из `tests/e2e/public.spec.ts` (тот же `demoCode(n)`), имя файла аудита — из `tests/e2e/admin.spec.ts`. Без `MATRIX=1` все 18 тестов — skipped (mock-прогон: 33 passed, 18 skipped).

- [ ] **Step 7: Проверить**

Run: `./at.sh at:test` → PASS (кроме известной ошибки окружения worktree). `./at.sh up gateway && ./at.sh gw:test` → PASS (с заглушкой, сборок ещё нет). `./at.sh e2e react mock` (после `./at.sh fe:build react --mock && ./at.sh fe:gateway react`) → `33 passed, 18 skipped`.

- [ ] **Step 8: Commit**

```bash
git add gateway docker-compose.yml docker-compose.e2e.yml at.sh tests/at tests/gateway tests/e2e/matrix.spec.ts
git commit -m "feat(stand): the gateway serves the three builds on all nine hosts; e2e against real backends and e2e:matrix"
```

- [ ] **Step 9: Поднять матрицу и записать базовую линию** (каждый пункт — в `matrix-baseline.md`: команда, итог, для каждого отказа — тест/шаг, хост, ответ, область → номер задачи 3–7 или «дефект теста»)
  1. `./at.sh up all` → 9 адресов; `docker ps` — 9 backend-сервисов и `gateway` healthy; uptime postgres/redis/rabbitmq/minio/mailpit не изменился.
  2. `./at.sh gw:test` → PASS теперь уже со сборками.
  3. `./at.sh e2e:matrix --smoke` → 18 тестов; отказы записать.
  4. `./at.sh e2e:matrix` → таблица 9 строк с длительностью; применить запасное правило PL1 и записать решение.
  5. `./at.sh cross:test` для всех 6 упорядоченных пар (`express django`, `django express`, `express laravel`, `laravel express`, `django laravel`, `laravel django`) → итог каждой.
  6. Зонды через шлюз на каждом backend (Playwright one-off или `curl` из `tools` в сети `at`): атрибуты `Set-Cookie` входа и refresh; перезагрузка страницы во время `POST /auth/refresh` (React, затем остальные фронты на том backend, где воспроизвелось) — остаётся ли сессия; Laravel: 11-й поток одного пользователя → `200` с одним `retry:` и закрытие, поведение EventSource фронта после него; загрузка протокола 10 МБ и аватара; скачивание QR PDF и отчётов; время на экранах в Europe/Moscow.
  7. Скриншоты базовой линии таблиц 768/1024/1280 px (организации, заявки с MANUAL_CHECK) — отметить переполнения.

Результат задачи: зелёные `at:test`/`gw:test`/mock-e2e, коммит, заполненный `matrix-baseline.md`. Падения e2e против настоящих backend в этой задаче ожидаемы.

---

### Task 2: Laravel 12 (только при согласии пользователя, PL16)

**Files:**
- Modify: `backend-laravel/composer.json`, `backend-laravel/composer.lock`
- Modify: файлы `backend-laravel/bootstrap/**`, `backend-laravel/config/**`, `backend-laravel/app/**`, которых коснутся изменения API Laravel 12 (по `composer` и падающим тестам)

**Interfaces:**
- Consumes: стенд Task 1.
- Produces: `laravel/framework ^12`, `composer audit` без advisories; поведение по контракту не меняется (tests/api не правится).

- [ ] **Step 1: Зафиксировать исходное состояние**

Run: `./at.sh composer audit` → Expected: 5 advisories `laravel/framework` (TokenGuard, debug page XSS, temporary signed URL, 2 × CRLF в `email`).

- [ ] **Step 2: Обновить зависимости**

Run: `./at.sh composer require laravel/framework:^12.0 -W` (совместимые версии `laravel/octane`, `larastan/larastan`, `pestphp/pest` подтянуть тем же вызовом или отдельным `composer require … -W`).

- [ ] **Step 3: Привести код к 12.x** — только то, что требуют упавшие `laravel:test`/`laravel:lint`; конфигурация Redis без префикса (`REDIS_PREFIX=''`, `options.prefix=''`), `TrimStrings`/`ConvertEmptyStringsToNull` выключены, канал журнала `deprecations` объявлен — проверить, что сохранились.

- [ ] **Step 4: Проверить**

Run: `./at.sh laravel:test` → 0 failed; `./at.sh laravel:test --domain-coverage` → ≥ 70 %; `./at.sh laravel:lint` → чисто; `./at.sh laravel:stack` → как до обновления (8 passed, 2 skipped); `./at.sh api:test laravel --reset` → 0 failed, `operations 92/92 … 0 gaps`; `./at.sh cross:test express laravel` и `./at.sh cross:test laravel express` → 12/12; `./at.sh composer audit` → «No security vulnerability advisories found»; `./at.sh e2e react laravel --reset` → не хуже базовой линии.

- [ ] **Step 5: Commit**

```bash
git add backend-laravel
git commit -m "build(laravel): Laravel 12 (Laravel 11 security support ended; composer audit clean)"
```

---

### Task 3: Фронты ↔ настоящие backend (api-client, дизайн-система, e2e, mock-api)

**Files:**
- Modify: `packages/api-client/src/sse.ts`, `packages/api-client/src/sse.test.ts`
- Modify: `packages/api-client/src/session.ts` (или `client.ts` — там, где сейчас фиксированная пауза 10 с на refresh 429), его тест
- Modify (если базовая линия подтвердит): `packages/design-system/**` (таблица, чип), `packages/design-system/README.md`, три фронта
- Modify: `tests/e2e/*.spec.ts`, `tests/e2e/helpers.ts` — по отказам базовой линии с пометкой «дефект теста»
- Modify: `packages/mock-api/src/domain/production.ts`, `packages/mock-api/src/modules/*.ts` и их тесты (P18)

**Interfaces:**
- Consumes: `matrix-baseline.md` (области «фронт», «api-client», «e2e», «mock»).
- Produces: `openEventStream(opts)` — та же сигнатура; новое поведение PL9. `retryAfterMs(response)` используется и для refresh 429.

- [ ] **Step 1: Падающие тесты api-client**

```ts
it('drops a notification whose id was already forwarded, also after a reconnect (P46, PL9)', () => {
  // FakeEventSource: emit notification {id:'n1'}, reauth → reconnect, emit notification {id:'n1'} and {id:'n2'}
  expect(events.filter((e) => e.type === 'notification').map((e) => (e.data as { id: string }).id)).toEqual(['n1', 'n2']);
});
it('remembers at most 1000 notification ids, forgetting the oldest first', () => {
  // emit ids n0…n1000, then n0 again → forwarded; n1000 again → dropped
});
it('a refresh answered 429 waits Retry-After seconds, not a fixed 10 s (F9)', async () => {
  // Retry-After: 3 → the next refresh attempt starts after ≥ 3000 ms and < 10000 ms (fake timers)
});
```

- [ ] **Step 2: Run** `./at.sh pnpm --filter @agrotrace/api-client test` → Expected: FAIL на трёх новых тестах.

- [ ] **Step 3: Реализовать** множество id в замыкании `openEventStream` (`Set` + очередь для вытеснения, предел `1000`); `unread` и `reauth` не фильтруются. Refresh 429 — пауза `retryAfterMs(response)` (существующая функция `client.ts:100`), без заголовка — прежние 10 с.

- [ ] **Step 4: Run** `./at.sh pnpm --filter @agrotrace/api-client test` → PASS; `./at.sh test` → PASS.

- [ ] **Step 5: Commit** `fix(api-client): one toast per notification id across reconnects; refresh 429 honours Retry-After`

- [ ] **Step 6: Таблица заявок с MANUAL_CHECK на 768 px (P31)** — только если базовая линия показала отказ `admin.spec.ts` «table scroll at 768» или переполнение на скриншоте. Правка — в CSS/разметке дизайн-системы (одна для трёх фронтов) и в README раздела «Таблица»; проверка: `./at.sh e2e <front> laravel --reset admin.spec.ts` для react, angular, svelte (Laravel и Django без ключа DaData дают MANUAL_CHECK) → PASS; `./at.sh ds:test` → PASS; `./at.sh e2e react mock visual.spec.ts` → PASS (если эталон `organizations-*` изменился законно — обновить с `--update-snapshots` и приложить снимки к отчёту).

- [ ] **Step 7: Сессия при перезагрузке во время refresh (Review Focus 1)** — только если зонд Task 1 воспроизвёл выход. Падающий e2e в `tests/e2e/routes.spec.ts`: «a reload while the refresh is in flight keeps the session» (перехват `POST /api/v1/auth/refresh` с задержкой 1 с через `page.route`, `page.reload()` в это время, затем видна та же страница с `h1`, не «Вход»). Исправление — в `packages/api-client/src/session.ts` (общая логика для трёх фронтов); если причина в ротации refresh на backend (повторное предъявление старого токена после успешной ротации), это контрактный вопрос: остановиться и описать доказательства в отчёте (NEEDS_CONTEXT), без правки backend.

- [ ] **Step 8: Прочие отказы базовой линии областей «фронт», «e2e»** — по одному: падающий тест (существующий e2e-тест уже падает) → исправление в фронте/DS/тесте → `./at.sh e2e <front> <back> --reset <spec>` PASS на той комбинации, где падало, и на одной комбинации каждого другого фронта. Исправление теста допустимо только для дефекта теста (тест полагается на поведение mock, которого нет в контракте) — с доказательством в отчёте.

- [ ] **Step 9: Дельты mock-api (P18)** — падающие тесты в `packages/mock-api` и исправления:
  - `If-Match: 0` → `errors['If-Match'] = ['validation.min']`; нецелое — `validation.type` (P35);
  - дубли `items[i].batchId` / `inputs[i].batchId` сообщаются только на шаге контракта, а не на этапе схемы (P36), и uuid сравниваются без учёта регистра (PL10);
  - `decideComplaint` без `decision` → `validation.required`, ошибка шаблона `publicCode` — в той же карте 400 (P42);
  - порядок округления `rejectedShare` и числовые ячейки отчётов — как в Express (P47; эталон — `backend-express/src/modules/analytics`, `…/reports/sheets.ts`);
  - diff аудита при окончательном удалении перечисляет каждое непустое поле (включая `productId`, `indicatorId`).
  Регистрация в mock остаётся `PENDING` (mock эмулирует доступный DaData; P31 — UI и e2e принимают оба статуса).

Run: `./at.sh pnpm --filter @agrotrace/mock-api test` → PASS; `./at.sh e2e react mock`, `./at.sh e2e angular mock`, `./at.sh e2e svelte mock` → `33 passed, 18 skipped` каждый.

- [ ] **Step 10: Commit(s)** — отдельными коммитами по областям: `fix(design-system): …`, `fix(e2e): …`, `fix(mock-api): contract deltas P35/P36/P42/P47`.

---

### Task 4: SSE — одинаковое поведение трёх backend (PL7, PL8)

**Files:**
- Modify: `contracts/openapi/paths/events.yaml`
- Modify: `tests/api/events.test.ts` (и при необходимости `tests/api/lib/sse.ts` — доступ к сырому первому кадру)
- Modify: `backend-express/src/sse/hub.ts`, `backend-express/src/sse/hub.test.ts`
- Modify: потоковый модуль SSE Django (`backend-django/agrotrace/sse/stream.py`, `sse/hub.py`) и его тесты в `backend-django/tests/`
- Modify: `backend-laravel/app/Sse/Stream.php`, `backend-laravel/app/Http/Controllers/Sse/StreamController.php` и тесты `backend-laravel/tests/Unit/Sse*`

**Interfaces:**
- Consumes: sanctioned-фикстура многострочного `INSERT INTO notifications …` (`tests/api/lib/sanctioned.ts`), `openStream` из `tests/api/lib/sse.ts`.
- Produces: текст PL7/PL8 в контракте; константы `LATE_COMMIT_MAX_ROWS = 100`, `REPLAY_DRAIN_TIMEOUT_MS = 10000`, `ADMITTED_RETRY_MS = 3000` (одинаковые имена смысла в трёх backend).

- [ ] **Step 1: Текст контракта** в `events.yaml` (описание операции `streamEvents`): PL7 (100 строк поздних коммитов с наибольшими `seq`, по возрастанию; обратное давление 10 с; правило 1 МиБ — для живых событий), PL8 (`retry: 3000` первым полем; ответ сверх лимита потоков; пример лимитов Laravel 200/10). Run: `./at.sh pnpm --filter @agrotrace/contracts test` → PASS.

- [ ] **Step 2: Падающие тесты tests/api** (`events.test.ts`)

```ts
it('a replay larger than 1 MiB reaches a reading client whole, in seq order (PL7)', async () => {
  // fresh user; one sanctioned multi-row INSERT of 3000 unread IN_APP rows (payloads sized so that the frames total ≥ 1.5 MiB)
  // openStream({ lastEventId: seq of the first row })
  expect(ids).toHaveLength(2999);
  expect(ids).toEqual([...ids].sort(bySeq));            // strictly increasing seq
  expect(rawBytesBeforeUnread).toBeGreaterThanOrEqual(1_572_864);
  expect(firstUnreadAfterReplay.data).toEqual({ count: 3000 });
});
it('the late-commit part of a replay holds at most the 100 highest seqs below L (PL7)', async () => {
  // same burst; openStream({ lastEventId: max seq })
  expect(replayed.length).toBeLessThanOrEqual(100);
  expect(replayed.every((n) => n.seq < L && n.isRead === false)).toBe(true);
  expect(replayed.map((n) => n.seq)).toEqual(highestBelow(L, replayed.length));
});
it('an admitted stream starts with retry: 3000 (PL8)', async () => {
  expect(firstRawField).toBe('retry: 3000');
});
```

Run: `./at.sh api:test express events.test.ts`, то же для `django`, `laravel` → Expected: FAIL (Express/Django — обрыв на 1 МиБ и `retry` нет; Laravel — нет `retry: 3000`, поздних коммитов > 100).

- [ ] **Step 3: Реализовать в трёх backend**
  - Запрос replay: часть `seq < L` — `ORDER BY seq DESC LIMIT 100`, затем по возрастанию, объединённая с `seq > L`; без предела для `seq > L` (P53).
  - Запись replay: Express — ждать `'drain'` (`once(res, 'drain')` с таймаутом 10 с), пока `writableLength > 1 MiB`; Django — аналог для своего потока (await очистки буфера ASGI-отправки); Laravel — уже меряет очереди сокетов; привести таймаут к 10 с. Нет прогресса 10 с → поток завершается.
  - Первым кадром каждого допущенного потока — `retry: 3000\n\n`. Laravel: ответ сверх лимита (`StreamAdmission`) оставить `200` + `retry: <5000–15000>` и закрытие.
  - Юнит-тесты: Express `hub.test.ts` «replay waits for drain instead of ending the stream»; Django `test_replay_waits_for_drain`; Laravel — тест `StreamAdmission`/`Stream` на `retry: 3000` у допущенного потока.

- [ ] **Step 4: Проверить**

Run: для каждого `back` в `express django laravel`: `./at.sh api:test <back> events.test.ts notifications.test.ts` → PASS; модульные наборы `./at.sh test` (Express), `./at.sh django:test`, `./at.sh laravel:test` → 0 failed; `./at.sh cross:test express django`, `./at.sh cross:test django laravel`, `./at.sh cross:test laravel express` → PASS; `./at.sh e2e react laravel --reset scenarios.spec.ts` → PASS.

- [ ] **Step 5: Commit** `fix(sse): replay with back-pressure, late commits ≤ 100, retry: 3000 on express, django, laravel (P46)` (контракт и tests/api — в том же коммите или в предшествующем `docs(contract): …` / `test(api): …`)

---

### Task 5: Входные данные — одинаковые ответы трёх backend (PL10–PL12)

**Files:**
- Modify: `contracts/openapi.yaml` (info.description: общие правила тела — PL10, PL11, PL12; правило календаря отчётов)
- Modify: `packages/validation/src/common.ts` (`noDuplicate` — нижний регистр для uuid; год 0000 для `isoDateTime` и даты), тесты пакета
- Modify: `tests/api/contract-shape.test.ts`, `tests/api/complaints.test.ts`, `tests/api/processing.test.ts`, `tests/api/fields.test.ts`, `tests/api/reports.test.ts`, `tests/api/auth.test.ts`
- Modify: декодер JSON-тела и периоды отчётов Express (`backend-express/src/http/body.ts`, `backend-express/src/modules/reports/service.ts`), Django (`backend-django/agrotrace/core/body.py`), Laravel (`backend-laravel/app/Http/Middleware/RequestContextMw.php` и декодер JSON-тела)
- Modify: обработка загрузок Express (`backend-express/src/modules/files/service.ts` или модуль растров)

**Interfaces:**
- Consumes: существующий ответ невалидного JSON (`contract-shape.test.ts:103`: `errors: {_root: ['validation.invalid']}`).
- Produces: `noDuplicate(field)` — та же сигнатура, сравнивает `String(v).toLowerCase()` для значений формата uuid.

- [ ] **Step 1: Падающие тесты tests/api**

```ts
// contract-shape.test.ts
it('a lone surrogate in a JSON string → the malformed-JSON 400 (PL11)', async () => {
  const res = await api().post('/auth/login', '{"email":"a@b.ru","password":"\\ud800"}', { headers: { 'content-type': 'application/json' } });
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({ code: 'VALIDATION', errors: { _root: ['validation.invalid'] } });
});
it('malformed JSON without credentials on a protected operation → 401 first (FM5)', async () => {
  expect((await api().post('/fields', '{"name":', { headers: { 'content-type': 'application/json' } })).status).toBe(401);
});
// complaints.test.ts — the public complaint with text "\ud800" → 400 validation.invalid at _root, never 500
// fields.test.ts — a treatment with appliedAt '0000-06-01T00:00:00Z' → 400 errors.appliedAt = ['validation.dateTime.format']
// processing.test.ts — inputs [{batchId: X}, {batchId: X.toUpperCase()}] → 400 errors['inputs[1].batchId'] = ['validation.duplicate']
// reports.test.ts — from=9999-12-31 only → 200, Content-Disposition file name matches /_9999-12-31_9999-12-31\./ ; to=0000-01-01 only → /_0000-01-01_0000-01-01\./
// auth.test.ts — the 2FA challengeId in upper case is the same challenge (same answer as lower case)
```

Run: `./at.sh api:test express contract-shape.test.ts complaints.test.ts processing.test.ts fields.test.ts reports.test.ts auth.test.ts`, то же для `django`, `laravel` → Expected: FAIL там, где backend отвечает 500 или иначе (по бэклогу: суррогат — все три; год 0000 — все три; регистр дубля и календарь — Express).

- [ ] **Step 2: Реализовать**
  - Суррогаты: после разбора JSON (или в самом декодере) обход строк тела; одиночный суррогат → тот же `400` невалидного JSON. Express: `body.ts`; Django: `core/body.py read_json_body`; Laravel: декодер тела (у `json_decode` PHP одиночный `\ud800` даёт ошибку декодирования или U+FFFD в зависимости от флагов — довести до того же 400).
  - Год 0000: `packages/validation` (Express и mock используют пакет), Django и Laravel — их порты схем (тест-фикстуры `tests/Fixtures/zod/*.json` Laravel обновить генератором, если он есть).
  - Дубли uuid: `noDuplicate` — нижний регистр для uuid; Express `processing` отвечает 400 вместо 500 (`batch_links` unique).
  - Календарь отчётов Express: прижать `from/to` к `0000-01-01`/`9999-12-31` до форматирования подписей и имени файла, как Django/Laravel.
  - Laravel `RequestContextMw.php:63`: префикс `::ffff:` — с учётом регистра, как Express (`request-id.ts:25`), чтобы один клиент давал один bucket `rl:complaint-ip:` (P5). Юнит-тест Pest: `::FFFF:1.2.3.4` остаётся как есть.
  - Express, усечённый JPEG (P6): декодирование проверки растра детерминированное — `sharp(…, { failOn: 'truncated' })` или эквивалент в месте проверки; юнит-тест: файл, обрезанный на 90 %, 20 раз подряд → каждый раз 415 (как Django/Laravel).

- [ ] **Step 3: Проверить**

Run: те же файлы tests/api на трёх backend → PASS; `./at.sh pnpm --filter @agrotrace/validation test` → PASS; `./at.sh test`, `./at.sh django:test`, `./at.sh laravel:test` → 0 failed; `./at.sh pnpm --filter @agrotrace/contracts test` → PASS.

- [ ] **Step 4: Commit** `fix(validation): lone surrogates and year 0000 → 400, case-insensitive uuid duplicates, clamped report periods, deterministic JPEG check` (по одному коммиту на правило допустимо)

---

### Task 6: Процессы — события при остановке, коды 503/499, журналы

**Files:**
- Modify: контракт — текст PL13 рядом с правилом P56 (найти по «delay» / «vsd.import» в `contracts/openapi.yaml` и `contracts/events/`)
- Modify: `backend-express/src/infra/consumer.ts` + тест; Django — потребитель Celery (`backend-django/agrotrace/events/tasks.py`/`handlers`) + тест
- Modify: `backend-express/src/http/problem.ts` (класс 08 и обрыв соединения с БД → 503), тест
- Modify: метрики Express (`backend-express/src/infra/metrics.ts` или middleware наблюдения) + тест
- Modify: `backend-django/agrotrace/core/middleware.py` (разбор JSON вне event loop), `backend-django/agrotrace/core/logging.py` (`_plain` для UUID/datetime/Decimal/Enum), `backend-django/agrotrace/core/lifecycle.py` (SIGINT как SIGTERM) + тесты
- Modify: `backend-laravel/docker/Caddyfile` (журнал без `request>uri`)
- Modify: `backend-express/src/modules/auth/service.ts` (resetPassword: advisory `refresh:` до строки `users`) + тест; проверить тот же порядок в Django

**Interfaces:**
- Consumes: —
- Produces: одинаковое поведение по PL13; 503 BACKEND_UNAVAILABLE при потере соединения с БД во всех трёх.

- [ ] **Step 1: Падающие юнит-тесты**
  - Express `consumer.test.ts`: «a delivery interrupted by stop is neither acked nor rejected (it returns to the queue)» — `stopping = true` во время повторов → нет `ch.reject(msg, false)`, нет `ack`.
  - Django: тот же сценарий для потребителя (`acks_late`, без `reject` в DLQ на остановке).
  - Express `problem.test.ts`: ошибка pg с `code` класса `08` (`08006`, `08001`) и `ECONNREFUSED` → 503 `BACKEND_UNAVAILABLE`; `08P01` → 500.
  - Express метрики: запрос, оборванный клиентом посреди тела, записывается со статусом `499`, не `400`.
  - Django `test_middleware.py`: разбор тела 8 МиБ не блокирует цикл — параллельный `ping` потока SSE уходит раньше конца разбора (или: `read_json_body` вызывается через `sync_to_async(…, thread_sensitive=False)` — тест на вызов).
  - Django `test_logging.py`: `extra={'batchId': uuid.UUID(...)}`, `datetime`, `Decimal` → в строке как текст; объект `request` по-прежнему отбрасывается.
  - Django `test_lifecycle.py`: SIGINT взводит тот же watchdog, что SIGTERM.
  - Express `auth` (или tests/api `auth.test.ts` при возможности форсировать гонку): порядок блокировок resetPassword — advisory `refresh:{userId}` первым (R52).

- [ ] **Step 2: Run** `./at.sh test` (Express) и `./at.sh django:test` → FAIL на новых тестах.

- [ ] **Step 3: Реализовать** по тестам; Caddy: `log { … }` с фильтром, удаляющим `request>uri` (или заменяющим на путь без запроса) — проверка зондом: `GET /api/v1/events/stream?access_token=PROBE8` с ошибкой уровня Caddy не даёт строки с `PROBE8` в `docker logs agrotrace-api-laravel-1`.

- [ ] **Step 4: Проверить** `./at.sh test`, `./at.sh django:test`, `./at.sh django:test -m stand` (после `./at.sh up django`), `./at.sh laravel:test`, `./at.sh laravel:stack` → 0 failed; `./at.sh api:test express metrics.test.ts documents.test.ts` и то же для `django`, `laravel` → PASS; `./at.sh cross:test express django` → PASS.

- [ ] **Step 5: Commit(s)** `fix(express,django): a consumer stop requeues instead of dead-lettering (PL13)`, `fix(express): DB connection loss → 503; aborted bodies → 499`, `fix(django): JSON body off the event loop; log extras; SIGINT watchdog`, `fix(laravel): no request URI in Caddy logs`, `fix(express): resetPassword takes the refresh lock first`.

---

### Task 7: Отчёты — высокие ячейки PDF и худший случай

**Files:**
- Modify: Express `backend-express/src/modules/reports/render.ts` (и модуль раскладки PDF), Django `backend-django/agrotrace/infra/pdf.py`, Laravel `backend-laravel/app/Infrastructure/Reports/ReportCanvas.php`, `ReportPdf.php`
- Test: `backend-express/src/modules/reports/render.test.ts`, `backend-django/tests/test_pdf.py`, `backend-laravel/tests/Unit/Reports/ReportCanvasTest.php`
- Modify: `docs/known-limitations.md` (раздел «Отчёты», создаётся здесь, если ещё нет; Task 9 дополняет)

**Interfaces:**
- Consumes: —
- Produces: PL14.

- [ ] **Step 1: Падающие тесты (по одному на backend)** «a cell taller than a page continues on the next page with the header repeated»: таблица жалоб (9 колонок) с одной строкой, `text` = 2000 символов (контрактный `maxLength`) → строк текста на страницах в сумме = строк раскладки ячейки; на второй странице есть строка заголовка таблицы; ни одна строка не выходит за нижнее поле.

Run: `./at.sh test`, `./at.sh django:test tests/test_pdf.py`, `./at.sh laravel:test tests/Unit/Reports/ReportCanvasTest.php` → FAIL.

- [ ] **Step 2: Реализовать** перенос строк ячейки по страницам во всех трёх раскладках (алгоритм одинаков — эталон Express; Django и Laravel повторяют его, как в Планах 3/5).

- [ ] **Step 3: Проверить** юнит-тесты → PASS; `./at.sh api:test <back> reports.test.ts` для трёх → PASS.

- [ ] **Step 4: Commit** `fix(reports): a cell taller than a page continues on the next page (express, django, laravel)`

- [ ] **Step 5: Замер худшего случая** (одинаковый для трёх; данные в dev-БД, потом `./at.sh reset`): 50 000 жалоб с `text` 2000 символов за один день (вставка через `./at.sh lock:run` скриптом в `tools`, роль владельца), `GET /reports/complaints?format=pdf` и `format=xlsx` от инспектора на каждом backend: статус, время, пик RSS процесса отчёта. Правило: если хотя бы один backend отдаёт PDF за ≤ 120 с, а другой — 503, выровнять ресурсный предел отстающего (память дочернего процесса Laravel, куча worker Express, полоса Django) в рамках лимита контейнера; если все три — 503, оставить ответ контракта и записать в `docs/known-limitations.md` цифры трёх замеров и совет «большие выборки — XLSX». Затем `./at.sh reset`.

- [ ] **Step 6: Commit** (если менялись пределы или документ) `docs(reports): worst-case report capacity measured on the three backends`

---

### Task 8: CI — матрица 3×3, smoke 9 хостов, все 6 пар, стабильность

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `at.sh` (`test:all`), `tests/at/at.test.ts`
- Modify: юнит-тесты страниц фронтов, флакающие под нагрузкой (Angular «first-test heading timeout», React `pages.test` «title»)
- Modify: `tests/api/contract-shape.test.ts` (413 > 12 MiB: повтор при EPIPE/ECONNRESET до получения статуса, максимум 3 попытки)

**Interfaces:**
- Consumes: команды Task 1.
- Produces: job `e2e-real` (матрица `front × back`, 9), job `matrix-smoke`, job `cross-ports` (django↔laravel), шаг покрытия домена в `unit`.

- [ ] **Step 1: Падающие тесты `tests/at`**: `test:all` содержит `cross:test django laravel`, `cross:test laravel django`, `up all`, `e2e:matrix --smoke` (в секции `# --- integration (plan 8) ---`, после секций backend) — и `ci.yml` содержит job `e2e-real` с `matrix.front: [react, angular, svelte]`, `matrix.back: [express, django, laravel]` (тест читает YAML).

- [ ] **Step 2: Реализовать `ci.yml`**
  - `unit`: шаг `./at.sh pnpm --filter @agrotrace/domain test:coverage` (порог `lines: 90` уже в `packages/domain/vitest.config.ts`; ТЗ §15.5 — ≥ 70 %).
  - `e2e-real` (9 job, `fail-fast: false`, `env.SEED_NOW: '2026-09-24T12:00:00Z'`): install → `up infra` → `reset` → `./at.sh up ${{ matrix.front }} ${{ matrix.back }}` → `./at.sh e2e ${{ matrix.front }} ${{ matrix.back }}` → при отказе артефакт `tests/e2e/test-results/run` и `docker compose logs` трёх сервисов backend.
  - `matrix-smoke`: install → `up infra` → `reset` → `./at.sh up all` → `./at.sh e2e:matrix --smoke`.
  - `cross-ports`: install → `up infra` → `reset` → `up django` → `up laravel` → `cross:test django laravel` → `cross:test laravel django`.
  - Существующий `e2e` (× mock) остаётся.
- [ ] **Step 3: Флейки** — фронтовые тесты страниц: ожидания заголовка через `findBy…` с таймаутом теста (как F9: `waitFor` 10 с), без `sleep`; 10 прогонов `./at.sh fe:test angular` и `./at.sh fe:test react` подряд под `./at.sh test` → 0 отказов. tests/api 413: повтор запроса только при ошибке записи до получения ответа; проверки статуса и тела не ослабляются.

- [ ] **Step 4: Проверить** `./at.sh at:test` → PASS (кроме ошибки окружения worktree); синтаксис workflow — `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7` → без ошибок; `./at.sh api:test laravel contract-shape.test.ts` ×5 → 9/9 каждый раз.

- [ ] **Step 5: Commit** `ci: e2e matrix 3×3 against real backends, nine-host smoke, django↔laravel pairs, domain coverage gate`

---

### Task 9: Документация итоговой системы

**Files:**
- Modify: `README.md` (раздел Quick start: `./at.sh up all` или `docker compose up` → таблица 9 адресов; ссылка на известные ограничения)
- Modify: `docs/deploy.md` (команды `up all`, `up <front> <back>`, `fe:build` и обновление шлюза, `e2e`, `e2e:matrix`, профиль e2e, PL2, устранение неполадок: пустой хост — нет сборки, порт 8088)
- Modify: `docs/ИНСТРУКЦИЯ.md` (см. «Решения пользователя» — файл сейчас не отслеживается): раздел 1 — 9 адресов настоящего стенда вместо mock-стендов; «Как устроены данные» — одна БД для всех 9, сброс `./at.sh reset`; сценарий защиты — на любой из 9 комбинаций
- Modify: `docs/demo-accounts.md` — только `./at.sh seed:docs`, если seed менялся; проверить `./at.sh pnpm --filter @agrotrace/seed test`
- Create/Modify: `docs/known-limitations.md` — все пункты корзины K таблицы бэклога (по-русски: что, где наблюдается, почему не исправлено, обходной путь)

- [ ] **Step 1: Проверочный тест** `tests/at` или `docs:test` не требуется; проверка — чтение: каждая команда, упомянутая в README/deploy/ИНСТРУКЦИЯ, есть в `./at.sh` (скрипт: `grep -o './at.sh [a-z:]*'` по документам, каждая выполняется с `AT_DRY_RUN=1` без «usage»).

- [ ] **Step 2: Написать** изменения; все адреса — с `GATEWAY_PORT` из `.env`; логины и пароль — из `docs/demo-accounts.md` (`agrotrace-demo`).

- [ ] **Step 3: Проверить** `./at.sh docs:test express` (Swagger) → PASS; ручной проход ИНСТРУКЦИИ на `svelte-django` (вход трёх ролей, сценарий отзыва) — результат в отчёте задачи.

- [ ] **Step 4: Commit** `docs: the 3×3 stand, e2e matrix commands, known limitations`

---

### Task 10: Финальная проверка всей матрицы

**Files:** только отчёт задачи (журнал SDD); исправления — отдельными коммитами с возвратом в задачу-владельца.

- [ ] **Step 1:** `./at.sh test:all` → exit 0 (включая `api:test` трёх backend с `--reset` и `--ratelimits`, 6 пар `cross:test`, `gw:test`, `docs:test`, `ds:test`).
- [ ] **Step 2:** `./at.sh api:test <back> --reset --tz Europe/Moscow` для трёх → 0 failed.
- [ ] **Step 3:** `./at.sh up all` → `./at.sh e2e:matrix --smoke` → 18 passed.
- [ ] **Step 4:** `./at.sh e2e:matrix` (или запасной объём PL1, решение записано в Task 1) → 9 строк `rc 0`; каждая полная комбинация: `21 passed, 30 skipped` (12 визуальных — только mock, 18 — `matrix.spec.ts` без `MATRIX=1`).
- [ ] **Step 5:** `./at.sh e2e react mock`, `angular mock`, `svelte mock` → `33 passed, 18 skipped` каждый.
- [ ] **Step 6:** стенд после прогонов: 9 backend-сервисов и шлюз healthy, uptime инфраструктуры не изменился, `zagruzka-*` не тронуты; `./at.sh reset` — демо-мир восстановлен.
- [ ] **Step 7:** сверка таблицы бэклога: каждый пункт M и P закрыт коммитом или переведён в K с записью в `docs/known-limitations.md`; отчёт — список коммитов по пунктам.

---

## Приложение A. Триаж бэклога

Источники: журналы и финальные ревью Планов 1/3/5 (`progress.md`, `final-review*.md`, `task-*-review*.md`), `docs/superpowers/rulings.md`, журналы фронтов и mock-api, зонды стенда 2026-10-30 (только чтение). «Проверено» — подтверждено чтением кода или запросом к стенду; «журнал» — по записи в журнале, проверяется в Task 1.

Корзины: **M** — обязательно для интеграции; **P** — паритет реализаций (исправление сразу во всех затронутых); **K** — известное ограничение (документируется, PL15).

### M — обязательно для интеграции (16)

| ID | Пункт | Источник | Проверено | Задача |
|---|---|---|---|---|
| M1 | Главный шлюз на всех 9 хостах отдаёт заглушку «Сборка фронтенда ещё не подключена»: сборки не смонтированы; у Svelte каталог `build/`, его стенд в своей сети | F3; `docker-compose.yml:81-96` | curl `react-laravel.localhost:8088`, `docker inspect` | 1 |
| M2 | `./at up all` = голый `docker compose up -d --build --wait`: фронты не собираются, инфраструктура может пересоздаться | `at.sh:734` | код | 1 |
| M3 | e2e против настоящего backend без профиля лимитов (login-ip 20/60 с на одном IP шлюза, complaint-ip) | P34, P41, F8 | код `at.sh e2e()` | 1 |
| M4 | e2e настоящего backend идёт через стенд фронта (`gateway-react` — устаревшая сборка) или отказывает (svelte) | `at.sh e2e_gateway` | код | 1 |
| M5 | Пары `cross:test django↔laravel` не прогонялись нигде; ТЗ §14.1 — «все 6 упорядоченных пар» | `at.sh test:all`, `ci.yml` | код | 1 (прогон), 8 |
| M6 | MANUAL_CHECK без DaData: чип не помещается в таблице заявок на 768 px (e2e уже фильтрует оба статуса) | P31, integration-report §3 | журнал (мог быть закрыт polish P1b) | 1 (проверка), 3 |
| M7 | Фронты не отсекают повтор уведомления по id; повтор окна 60 с и полный replay Laravel дают двойной тост | P46, M15 (Express T12-13) | код: нет фильтра в `sse.ts`, `sse.tsx`, `live-events.ts`, `live.svelte.ts` | 3 |
| M8 | SSE: пачка непрочитанных > 1 МиБ — бесконечные переподключения с тем же первым МиБ (Express, Django); Laravel шлёт replay целиком | Django T12 ruling (IMPORTANT), Laravel T12 M4 | код `hub.ts:63` (обрыв по `writableLength`), окно от `created_at` строки L | 4 |
| M9 | Laravel: `retry: 5–15 с` ответа сверх лимита остаётся временем переподключения EventSource; лимиты 200/процесс и 10/пользователь не описаны в контракте | Laravel T12 rereview1 Minor 3, rulings T12 | журнал | 4 |
| M10 | api-client: refresh 429 — фиксированные 10 с вместо `Retry-After` | F9 | код `client.ts:100` (функция есть, refresh её не использует — проверить в Task 3) | 3 |
| M11 | Перезагрузка страницы во время refresh может разлогинить | F9 | журнал | 1 (зонд), 3 |
| M12 | Шлюз: `immutable` и на 404 в `/assets/`; нет gzip на главном шлюзе | FM14; Express ledger «gateway, Plan 8» | код `nginx.conf.template:151-153` | 1 |
| M13 | Флейк юнит-тестов страниц фронтов под полной нагрузкой (Angular, React) | Express ledger Task 14 | журнал | 8 |
| M14 | Флейк tests/api «JSON > 12 MiB → 413» с EPIPE на Laravel (1 из 6) | Laravel T14 fix1 | журнал | 8 |
| M15 | Покрытие домена Express (`packages/domain`, порог 90 % в `vitest.config.ts`) в CI не проверяется (`./at test` без `--coverage`); ТЗ §15.5 | Django final M2 (заметка), ledger | код | 8 |
| M16 | В CI e2e только × mock; ТЗ §14.3 — матрица 3×3 | `ci.yml` job `e2e` | код | 8 |

### P — паритет реализаций (18)

| ID | Пункт | Источник | Проверено | Задача |
|---|---|---|---|---|
| P1 | Одиночный суррогат в `text` жалобы (и любом теле) → 500 на всех трёх | Django T11 N1, Laravel T11 | журнал | 5 (PL11) |
| P2 | Год 0000 в `appliedAt` (DateTime тела) → 500 на всех трёх (в PG нет года 0) | Django T4-5, Laravel T4-5 M4 | журнал | 5 (PL12) |
| P3 | Express 500 на дубль `batchId`, отличающийся регистром (processBatches, unique `batch_links`); Django/Laravel — 400 | Django Q15, Laravel T8 | код `noDuplicate` сравнивает как есть | 5 (PL10) |
| P4 | Express: подписи периода `+010000-01`/`-000001-12` (нарушают `format: date` и шаблон имени файла); Django/Laravel прижимают | Django T13 | журнал | 5 (PL12) |
| P5 | Laravel `strtolower` для `::FFFF:` → два bucket `complaint-ip` для одного клиента (Express — с учётом регистра) | Laravel T11 M3 | код `RequestContextMw.php:63` | 5 |
| P6 | Express принимает слегка усечённый JPEG недетерминированно (гонка потоков libvips); Django/Laravel отказывают всегда | Laravel Q12 | журнал | 5 |
| P7 | FM5: Express разбирает JSON до аутентификации (401 должен быть первым); регистр `challengeId` 2FA | FM5 (mock-api ledger) | журнал — пин в Task 5 решит | 5 |
| P8 | Express (и Django) отправляют сообщение в DLQ при остановке потребителя; Laravel возвращает в очередь | Laravel T6 ruling | код `consumer.ts:94` (`|| stopping` → reject) | 6 (PL13) |
| P9 | Потеря соединения с БД: Express → 500, Laravel (и Django — проверить) → 503 BACKEND_UNAVAILABLE | Laravel T11 M2 | журнал | 6 |
| P10 | Метрики Express: обрыв тела клиентом записан как 400 (Django — 499) | Django T14 M1 | журнал | 6 |
| P11 | Django: разбор JSON-тела в event loop задерживает пинги и уведомления всех SSE процесса | Django final M6 | код `middleware.py:201` | 6 |
| P12 | Django: `_plain` молча отбрасывает UUID/datetime/Decimal в extras (m3); SIGINT не взводит watchdog (n1) | Django rereview m3, rereview2 n1 | код `logging.py:61`, `lifecycle.py` | 6 |
| P13 | Laravel: ошибка уровня Caddy может записать URI с `access_token` | Laravel final M6 | журнал | 6 |
| P14 | Express resetPassword: строка `users` до advisory `refresh:` (R52 требует наоборот); Laravel исправлен | Laravel T2-3 M5 | журнал | 6 |
| P15 | PDF: ячейка выше страницы обрезается (~30 % текста 2000-символьной жалобы) на всех трёх | Django T13 M3 | журнал | 7 (PL14) |
| P16 | Худший случай: PDF 50k жалоб макс. длины → 503 на Laravel, XLSX — 979 из 1056 МБ; Express/Django не измерены | Laravel T13 rulings, N3 | журнал | 7 (замер) |
| P17 | Laravel 11 вне поддержки, 5 advisories (функции не используются) | Laravel T14 M8 | журнал | 2 (решение пользователя) |
| P18 | mock-api ↔ контракт: `If-Match: 0` → `validation.type` (контракт `validation.min`), дубли на этапе схемы, decideComplaint без decision, округление `rejectedShare`, числовые ячейки, diff окончательного удаления | P37, P42, P47, mock-api ledger | код `production.ts:292` | 3 |

### K — известные ограничения (26)

| ID | Пункт | Обоснование |
|---|---|---|
| K1 | `created_at`/`produced_at`: Express пишет мс (время транзакции через JS `Date`), Django/Laravel — мкс | На проводе одинаково: все три выводят `.mmmZ`, сортировка — в SQL по одним и тем же значениям; P38 сравнивает моменты |
| K2 | RECALL_TX: один повтор, без джиттера → 409 VERSION_CONFLICT под сильной конкуренцией (Laravel чаще) | R47 допускает 409; фронты показывают «данные изменились» и дают повторить; изменение ядра транзакций трёх backend на финише — риск выше пользы |
| K3 | Осиротевшие объекты MinIO при сбое второй транзакции загрузки протокола и `createBatchQr` | Только утечка места на редком пути отказа; пользователь не видит; чистильщик вне объёма |
| K4 | Публичная страница может показывать старое имя до 300 с после переименования (гонка построения кеша) | Граница — TTL `pub:batch` 300 с (R82); статусы безопасности сбрасываются сразу |
| K5 | XLSX: `\r` читается как `\n`; причуды exceljs (управляющий символ, литерал `_x000D_`, пустая ячейка); семантика ячеек импорта (`t="d"`, формула без кеша, `rPh`) | Редкие входы; Excel показывает тот же перенос; решения Q9/Q13 |
| K6 | Отчёт по отзыву читает листы без `LIMIT max_rows+1` (все три) | Нужен отзыв > 50 000 партий; ответ всё равно 400 tooManyRows |
| K7 | Laravel недосчитывает 499 у коротких запросов; запросы на порт метрик доходят до PHP | Только метрики; бенчмарк вне объёма; задокументировано в `Metrics.php` |
| K8 | Текст чисел: `5.0`, `1e+16`, `1e-07` (Django), `1.0e-7` (Laravel) против `5`, `1e16`, `1e-7` (Express) | JSON-равные значения; встречаются только в геометрии; `pub:batch` отдаётся побайтово, разбор одинаков |
| K9 | `vsd.import attempts` может превысить 6 после повторной доставки (Express и Laravel) | Контракт: «число обращений в текущем цикле»; UI показывает число без «из 6» |
| K10 | Laravel держит открытые SSE до 10 с при остановке (Express закрывает сразу); выход 0 вместо 1 по таймауту; `stop_grace_period` 25 с | Клиенты переподключаются с Last-Event-ID; предел контейнера соблюдён |
| K11 | Параллельный импорт одного справочника: Express исчерпывает пул (другие чтения 503), Laravel ставит в очередь (200) | Только ADMIN, только одновременный импорт одного справочника |
| K12 | SSE: потерянный catch-up после временной ошибки БД (все три); сброс множества `SENT_CAP` 10 000; таймаут пробы LISTEN Laravel; FrankenPHP снимает `Connection: keep-alive` | Редкие пути; повторное подключение восстанавливает; HTTP/1.1 и так keep-alive |
| K13 | Ядовитое сообщение с `x-delivery-limit` 1e6 доставляется бесконечно; в `agrotrace.django.jobs.dlq` ~124 dev-события до Q12 | `definitions.json` не меняется в этом плане; очистка очереди запрещена исполнителям — пользователь может очистить сам |
| K14 | Нет индекса для скана sweeper outbox (Laravel) | 8,75 мс на проход при 100k строк; нужна общая миграция |
| K15 | `%2F` в `publicCode`: Express 400 pattern, Django 404 | Обе — ошибки; UI такой ссылки не строит |
| K16 | Края импорта XLSX (Name production в scanXml, странности firstSheetPath, алиас UTF8, `WORKER_START_TIMEOUT_MS`); mock-api не реализует P24–P28 | Контракт обязателен для backend; mock — справочник для фронтов, отставание задокументировано (integration-report §4) |
| K17 | Laravel BoundedResolver/DeadlineStream — пробелы против glibc (только IPv4, без failover); p95 растров 0,3 с против 0,2 (Q10) | Совпадает с resolv.conf Docker; доставка в mailpit проверена |
| K18 | Redis недоступен при сбросе публичного кеша: Django отвечает 200, Express — 500 | Поведение Django лучше; кеш истекает за 300 с |
| K19 | Одноразовые коды: `GETDEL` до записи в БД (Express; Laravel возвращает код) | Выбор контракта P53: пользователь запрашивает новый код |
| K20 | Нет HTTPS/mkcert (R89 M3), CSP Яндекс Карт (ключа нет — карта выключена), brotli | `*.localhost` — безопасный контекст, cookie `Secure` работают; см. «Решения пользователя» |
| K21 | Мелочи UI (FM31 Minor): импорт > 200 ошибок не просматривается, фокус после импорта, локализация имён полей в diff аудита, двойная ошибка диалога, статичный текст 429, автодополнение контакта, `maxLength` в кодовых точках, фокус `/recalls/new`, Esc у QR и фото, фокус при query-навигации, пробел в тосте, стиль неактивной нижней навигации, запас `/p` 0,2 KB, редкие флейки public-recalled и FM18 | Пользователь продолжает работу; переполнения таблиц на 360/768/1280 проверяются в Task 1 и переходят в M, если подтвердятся |
| K22 | Формулировка WrittenOff ↔ RECALLED; у `Region` нет геометрии (карта регионов — столбчатая диаграмма); `imageCredit` (P32) | Решения контракта зафиксированы |
| K23 | Пункты ТЗ вне Плана 8: Prometheus/Grafana (§14.4–14.5), k6, OWASP ZAP, образы в GHCR и деплой на VPS (§14.3), `docs/test-plan.md`, `docs/user-guide.md`, отчёты `frontend.md`/`backend.md` | См. «Решения пользователя» |
| K24 | Задание просрочки держит блокировки всех выбранных задач в одной транзакции (паритет Express) | Длинный хвост только после долгого простоя |
| K25 | Тестовые/косметические: ветка `exc is None` в `handler500` Django без `requestId`; хрупкость EcmaGuard/float-guard Laravel | Недостижимо или только в тестах |
| K26 | Поздний владелец ключа идемпотентности после TTL 60 с может снять запись второго претендента | Свойство R48 |

**Итого: M — 16, P — 18 (P17 — по решению пользователя), K — 26.**

## Решения пользователя (до запуска)

1. **Laravel 12 (Task 2):** обновлять сейчас (рекомендуется: EOL-фреймворк — постоянное замечание на защите; риск закрывают 1182 Pest + tests/api + cross) или оставить 11 и записать P17 в K.
2. **`docs/ИНСТРУКЦИЯ.md` и `docs/ДОКУМЕНТАЦИЯ.md` не отслеживаются git:** в worktree их нет. Варианты: закоммитить их на `main` до старта (тогда Task 9 правит ИНСТРУКЦИЮ в ветке), или Task 9 правит только отслеживаемые документы, а ИНСТРУКЦИЮ пользователь переносит сам.
3. **Объём ТЗ вне этого плана (K23):** Prometheus/Grafana, k6, ZAP, GHCR/деплой, test-plan, user-guide, отчёты `frontend.md`/`backend.md` — отдельный План 9 или добавить задачи сюда.
4. **HTTPS через mkcert (R89 M3 «→ Plan 8»):** по умолчанию — не делаем (K20).
5. **Очистка `agrotrace.django.jobs.dlq`** (~124 dev-события): исполнителям запрещено; пользователь может выполнить `docker compose exec rabbitmq rabbitmqctl purge_queue agrotrace.django.jobs.dlq` сам.
