# Общие правила портов — Django (План 3) и Laravel (План 5)

> **For agentic workers:** этот файл обязателен для обоих планов наравне с их разделом «Global Constraints» и с `.superpowers/sdd/2026-09-25-plan-1-express/plan-globals.md` (с заменой `express` → `django`/`laravel`). При расхождении с планом действует этот файл; при расхождении с контрактом — контракт.

**Зачем.** Два порта идут параллельно в двух worktree (`C:/project-wt/plan-3`, `C:/project-wt/plan-5`) на **одном** docker-стенде: одна БД, Redis, RabbitMQ, MinIO, Mailpit, mercury-mock, один compose-проект `agrotrace`. Общая подготовка SP1–SP7 лежит на `main` (отчёт `.superpowers/shared-prep-report.md`); ниже — правила, которые из неё следуют для обоих портов.

## 1. Роль БД

- api, worker и планировщик (scheduler / beat) подключаются **только** по `APP_DATABASE_URL` — роль `agrotrace_app`, права из `infra/postgres/init/01-roles.sql`, как Express.
- `DATABASE_URL` — владелец `agrotrace_owner`, суперпользователь образа. Он обходит права и занимает резервные слоты. Его использует только `at.sh` (dbmate, `prepare_test_db`) и хук модульных тестов порта, если тестам нужен владелец своей БД (`TEST_DATABASE_URL`). Процессы приложения — никогда.

## 2. Redis без префикса

- Ключи общие для трёх реализаций (таблица контракта, R82/R92/P9): `idem:`, `rl:`, `pub:batch:`, `pwreset:`, `invite:`, `tgcode:`, `totp-used:`, `2fa:`, `altcha-used:`, `tg:poller`.
- Никакого префикса ключей, сериализатора или сжатия. Laravel: `REDIS_PREFIX=''` и `options.prefix=''` (иначе `laravel_database_` раздвоит каждый ключ). Django: redis-py без `key_prefix`, без кеш-фреймворка Django поверх общих ключей.
- Собственные каналы и ключи реализации — только с её пространством имён (`agrotrace:laravel:sse:*` и т. п.).

## 3. Стенд: что трогать нельзя

- Инфраструктурные сервисы compose (`postgres`, `redis`, `rabbitmq`, `minio`, `minio-init`, `mailpit`, `mercury-mock`, `gateway`, `tools`, `playwright`, `dbmate`) не правятся.
- Никогда: `./at down`, `docker compose down`, `--remove-orphans`, `docker compose restart <инфраструктура>`, остановка чужих контейнеров руками. Контейнеры вне проекта `agrotrace` (например `zagruzka-*`, `qa*`) не трогаются вообще.
- Свои сервисы — с `expose`, никогда `ports:` (8000 и 9464 доступны только в сети `at`).
- Перед первым `./at.sh` в worktree — копия `C:/project/.env` (в ней уже есть переменные SP6), не `.env.example`.

## 4. Мьютекс стенда

- Команды, меняющие общий стенд, сами берут хостовый замок (`at.sh`, коммит a4050f4): `api:test`, `cross:test`, `docs:test`, `gw:test`, `test:all`, `db:migrate`, `db:rollback`, `db:test`, `gen:db-types`, `seed`, `seed:test`, `reset`, `bench`, `down`, `up` (кроме `up help`), `e2e` против настоящего backend, `django:test`, `laravel:test`, `lock:run <команда…>`.
- Замок — каталог `<git common dir>/agrotrace-stand.lock`, один для всех worktree клона. Ждущий печатает «waiting for <cmd> in <worktree>»; предел `AT_LOCK_TIMEOUT` (по умолчанию 5400 с), затем выход 75. Вложенный вызов `at.sh` внутри заблокированной команды замок не берёт повторно (`AT_LOCK_HELD`). Зависший замок с мёртвым PID перехватывается с предупреждением.
- Любая разовая команда на общем стенде вне списка — через `./at.sh lock:run <команда…>`. `AT_NO_LOCK=1` — только для отладки в одиночку.

## 5. Чужие планировщики на время прогона (SP1)

- `api:test <back>` останавливает запущенные планировщики **других** реализаций (`scheduler-express`, `beat-django`, `scheduler-laravel` — кроме своего), `cross:test <a> <b>` — всех, кроме `a` и `b`, `e2e <front> <back>` против настоящего backend — всех, кроме `back`.
- Контейнеры находятся по docker-меткам `com.docker.compose.project=agrotrace` и `com.docker.compose.service=<сервис>`, а не по имени сервиса compose, поэтому работают из worktree, в compose-файле которого чужих сервисов нет.
- Ловушка EXIT запускает их обратно (`docker start`, без гарантии); `api:test` делает это после возврата своих процессов к обычной конфигурации.
- Следствие для портов: имена сервисов планировщика фиксированы — `beat-django` и `scheduler-laravel`. Свою остановку чужих планировщиков порт не пишет.

## 6. БД модульных тестов (SP2)

- `agrotrace_test_django` — `./at.sh django:test`, `agrotrace_test_laravel` — `./at.sh laravel:test`. `agrotrace_test` остаётся за `db:test` (tests/db) и `gen:db-types`; порты её не трогают.
- Обе команды заблокированы мьютексом и сначала вызывают `prepare_test_db <имя>`: БД создаётся, если её нет (владелец `agrotrace_owner`, права `01-roles.sql`), и мигрируется dbmate из `db/migrations`. БД не пересоздаётся: тесты порта сами убирают свои строки.
- Затем вызывается хук: `django_test_hook "$@"` / `laravel_test_hook "$@"` с экспортированными `TEST_DATABASE_URL` (владелец, `?sslmode=disable`) и `TEST_APP_DATABASE_URL` (`agrotrace_app`). До Task 1 хук — заглушка «added by Plan 3/5», возвращает 1. Task 1 порта заменяет **только тело хука** в своей секции `at.sh`.

## 7. Разметка общих файлов (SP3)

- Общие файлы: `at.sh`, `docker-compose.yml`, `docker-compose.api-test.yml`, `.github/workflows/ci.yml`, `.env.example`, `tests/at/at.test.ts`. Порт пишет в них **только** внутри своих секций:
  - Django: `# --- django (plan 3) ---` … `# --- end django ---`;
  - Laravel: `# --- laravel (plan 5) ---` … `# --- end laravel ---`;
  - в `tests/at/at.test.ts` — то же с `//`.
- Секции уже стоят на `main`, пустые, в каждом месте, где нужны блоки backend:
  - `at.sh`: список блокировки, хуки (функции), диспетчер команд, `test:all`;
  - `docker-compose.yml`: `services` и верхнеуровневый `volumes`;
  - `docker-compose.api-test.yml`, `ci.yml` (`jobs`), `.env.example`, `tests/at/at.test.ts` (конец файла).
- Код вне секций не меняется. При слиянии остаются обе секции целиком; конфликтов быть не должно (между секциями — неизменённые строки).
- tests/at проверяет разметку сам: соглашение в первой строке файла, пары маркеров, число строк `TZ` по каждому backend профиля api-test (по одной на каждый из трёх сервисов), порядок секций `test:all`. Порт новых проверок соседства строк не добавляет.
- Строки `test:all` порта (свой модульный набор, `api:test <back> --reset`, `--ratelimits`, пары `cross:test`, `docs:test <back>`) — в его секции `test:all`.

## 8. Бюджет соединений (P61, SP4)

- Каждая реализация — не больше 20 соединений на все свои процессы; в каждом процессе пиковое число одновременных держателей соединения не больше его пула. Ожидание соединения ≤ 5 с, `statement_timeout` 30 с, `lock_timeout` 10 с, иначе 503 BACKEND_UNAVAILABLE.

  | Реализация | Распределение | Итого |
  |---|---|---|
  | Express | api: пул 11 + LISTEN 1; worker: пул 4; scheduler: пул 4 | 20 |
  | Django | api (uvicorn, 1 процесс): `DJANGO_DB_POOL_MAX=7` + `DJANGO_SSE_POOL_MAX=2` + LISTEN 1; worker: пул 6 (2 потока задач, 2 потока отправки, поллер Telegram); beat: пул 4 (одно соединение на задание: advisory lock, транзакции тика и отправки `notification-delivery`) | 20 |
  | Laravel | api: `DB_SLOTS=11` (Octane-воркеры `OCTANE_WORKERS` отвязаны семафором) + LISTEN хаба 1; worker: 2 потребителя + поллер 3; scheduler: 4 процесса заданий | 19 |

- Пулы Django задаются в `environment:` своих сервисов compose, не в общем `.env` (переменная Express `DB_POOL_MAX` не используется).
- **Сумма по стенду:** `max_connections=100`, из них 3 — резерв суперпользователя, ролям доступно 97. Реализации — не больше 3 × 20 = 60 (заявлено 20 + 20 + 19 = 59). Инструменты — не больше 30: меняющие стенд команды идут по одной под мьютексом (tests/db до 20 вместе с dbmate, tests/api до 5, модульные тесты портов в своих БД), плюс psql. Итого не больше 90 ≤ 97. `max_connections` не меняется.

## 9. Дефекты tests/api и tests/cross

- Наборы tests/api и tests/cross — продукт и общие для всех реализаций. Порт подгоняется под них.
- Подлинный дефект теста (тест проверяет поведение Express, которого нет в контракте) исправляется так:
  1. исполнитель порта отвечает NEEDS_CONTEXT с доказательством, контроллер выносит ruling;
  2. правка — на `main`, backend-агностичная (P58: без литералов имён backend), отдельным коммитом `test(api): …` / `test(cross): …`; на `main` после неё зелёные `./at.sh api:test express <файл>` (или `./at.sh cross:test`) и `./at.sh at:test`;
  3. обе ветки делают `git merge main` в начале своей следующей задачи.
- В ветке порта правок tests/api и tests/cross нет никогда.

## 10. Межреализационные сценарии (SP5)

- `tests/cross/session.test.ts` и `tests/cross/interop.test.ts` уже на `main`: Argon2id-вход через другую реализацию, подписанные ссылки на файлы и ETag, повтор `Idempotency-Key`, SSE (уведомление, созданное через A, приходит в поток на B), ротация и отзыв refresh-токена. Каждый сценарий идёт в обе стороны пары.
- Порт ожидает **весь** tests/cross зелёным в обоих порядках: `./at.sh cross:test express <back>` и `./at.sh cross:test <back> express` (после слияния портов — и пара `django laravel`).

## 11. Переменные окружения (SP6)

- `.env.example` и `C:/project/.env`: Laravel — `LARAVEL_APP_KEY` (dev-значение), `OCTANE_WORKERS=32`, `DB_SLOTS=11`; Django общих переменных не добавляет.
- Блоки compose читают переменные порта как `${VAR:-default}`, чтобы контейнер стартовал и со старым `.env`.
- RabbitMQ уже перезапущен с очередями `.jobs.delay`; `./at.sh check` зелёный. Повторный перезапуск — только с согласия контроллера и через `./at.sh lock:run docker compose restart rabbitmq`.
