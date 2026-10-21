# План 3 «Django» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вторая backend-реализация AgroTrace — порт законченного Express (План 1, `main` 7dd3858) на Django 5.2 + DRF (Python 3.12), которая проходит **неизменённый** набор `tests/api` (549 тестов, 92/92 операции) и сценарий `tests/cross` в парах Express ↔ Django на общей БД, Redis, RabbitMQ и MinIO.

**Architecture:** Модульный монолит `backend-django/`: Django-приложения по модулям контракта (`models` с `managed = False` поверх схемы dbmate, `serializers`, `views`, `services`, общий чистый `domain`) → инфраструктура (сырой SQL psycopg 3, Redis, MinIO, RabbitMQ). Три процесса из одного образа: `api-django` (uvicorn, ASGI: синхронные DRF-представления в потоках запросов + асинхронный SSE с psycopg async LISTEN), `worker-django` (Celery, очередь `agrotrace.django.jobs`), `beat-django` (Celery Beat с выполнением тиков в процессе под advisory-lock). Эталон поведения — `backend-express/src/**` и контракт; `tests/api` — паритетный набор, который не меняется.

**Tech Stack:** Python 3.12, Django 5.2 LTS (`managed = False`, встроенный пул psycopg), djangorestframework 3.15+, psycopg[binary,pool] 3.2, uvicorn 0.30+, Celery 5.5 + kombu 5.5 (py-amqp), redis-py 5, boto3 ≥ 1.36, Pillow 11, segno, openpyxl, WeasyPrint, PyJWT 2.9+, argon2-cffi 23, pyotp, structlog, prometheus_client, drf-spectacular (только проверка паритета схемы в CI), pytest + pytest-cov + ruff (unit). Без `django.contrib.auth/admin/sessions/messages/staticfiles`.

**Spec:** `docs/tz-agrotrace-v2.md` (§8, особенно §8.1–8.4, §8.7 таблица реализаций, §11, §12.6, §14). **Contract (binding):** `contracts/openapi.yaml` + `contracts/openapi/**`, `contracts/rules/*.json` (+ `vectors/`), `contracts/events/*.schema.json`; текст `info.description` (протокол блокировок, P43, общие ключи Redis, конфигурация стенда, бюджет соединений, мониторинг, записи стенда) — исполнять буквально. **Rulings:** `docs/superpowers/rulings.md` (R1–R93) и «## Rulings» в `.superpowers/sdd/2026-09-25-plan-1-express/progress.md` (P1–P61) — обязательны. **Эталон:** `backend-express/src/**`, отчёты `.superpowers/sdd/2026-09-25-plan-1-express/task-*-report.md`, `final-fix-report.md` (раздел «Decisions for the controller» каждого отчёта — поведение, которое порт воспроизводит). **Общая подготовка (обязательна до Task 1):** SP1–SP7 из `.superpowers/preflight-plans-3-5-review.md` §6, слитые в `main` отдельным потоком; точные имена — в `.superpowers/shared-prep-report.md` (когда он есть, его имена важнее имён этого плана). Этот план их не перепланирует, а использует: SP1 — приглушение планировщиков других реализаций по docker-label внутри `api:test`; SP2 — отдельная БД `agrotrace_test_django` (создание и dbmate — общий помощник at.sh) и заблокированная заглушка `django:test`, вызывающая хук backend; SP3 — устойчивые к слиянию проверки tests/at и пустые размеченные секции `# --- django (plan 3) ---` … `# --- end django ---` в `at.sh`, `docker-compose.yml`, `docker-compose.api-test.yml`, `.github/workflows/ci.yml`, `.env.example`; SP4 — абзац P61 контракта для трёх реализаций; SP5 — `tests/cross/interop.test.ts` на `main`; SP6 — перезапуск RabbitMQ (очереди `.delay`) и переменные `.env`; SP7 — `docs/superpowers/plans/port-globals.md`.

## Global Constraints

Все пункты `docs/superpowers/plans/port-globals.md` (SP7: роль `APP_DATABASE_URL`, без префикса ключей Redis, не трогать инфраструктурные сервисы, ни `down`, ни `--remove-orphans`, канал исправлений tests/api, сумма соединений стенда) и `.superpowers/sdd/2026-09-25-plan-1-express/plan-globals.md` действуют с заменой `express` → `django`. Кратко и с поправками порта:

- **tests/api не меняется.** Набор — продукт; Django подгоняется под него, не наоборот. Единственное исключение — подлинный дефект теста, нейтральный к контракту (тест проверяет поведение Express, которого нет в контракте): исполнитель отвечает NEEDS_CONTEXT с доказательством, контроллер выносит ruling (`DJ<n>` в `.superpowers/sdd/2026-10-21-plan-3-django/progress.md`), правка остаётся backend-агностичной (P58: без литералов имён backend) и по SP7(d) коммитится в `main` (Express зелёный); обе ветки делают `git merge main` в начале следующей задачи.
- **Роль БД (D-I8):** api, worker и beat подключаются только по `APP_DATABASE_URL` (роль `agrotrace_app`, права из `infra/postgres/init/01-roles.sql`), как Express; `DATABASE_URL` (владелец, суперпользователь образа) использует только общий помощник SP2 для создания `agrotrace_test_django`; pytest работает ролью приложения в этой БД.
- **Контракт не меняется** без ruling (его параллельно читает Laravel). Найденная неоднозначность → ruling + отдельный коммит `docs(contracts): …`, Express остаётся зелёным.
- Контракт — единственный источник истины (пути, коды, `ProblemCode`, `rule`, `params`, заголовки, `x-*`); ответы, включая ошибки, валидируются в tests/api (Ajv 2020 strict, `additionalProperties:false`). Массы — строки с 3 знаками, ids — uuid в нижнем регистре, пустые необязательные — `null`.
- Ошибки — RFC 7807 `application/problem+json`, `type = /problems/<kebab-code>`, ключи `errors` — `validation.*` (P7, P16, P19, P36, P44). Вывод DRF по умолчанию (`{"field": ["This field is required."]}`, 403 вместо 401, 406/415 согласования, HTML-страницы Django 400/404/500) **никогда** не доходит до клиента.
- **Моменты времени.** Сериализация DateTime — `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, миллисекунды усечением, как `Date.toISOString()` у Express), сравнение в tests/api — как моментов (P38). Одна операция — один момент (P43): `now()` транзакции PostgreSQL (`SELECT now()` один раз в начале или `django.contrib.postgres.functions.TransactionNow()`); запрещены `django.db.models.functions.Now()` (это `STATEMENT_TIMESTAMP()`), `auto_now`/`auto_now_add`, `timezone.now()`/`datetime.now()`/`date.today()` в записываемых данных и в правилах сроков. `USE_TZ = True`, `TIME_ZONE = 'UTC'`; все правила дат — UTC при любом `TZ` процесса (прогон `--tz Europe/Moscow`).
- **Регулярные выражения (D-I1).** Шаблоны контракта — ECMA-262 / JSON Schema `pattern`, то есть **поиск без якорей**: в Python они компилируются только через `core.patterns.ecma()` и применяются `.search()` (якоря задаёт сам шаблон: `\S` у NameString — «есть хотя бы один не-пробел», `^otpauth://totp/` — префикс). Перевод: `\d` → `[0-9]`, `\w` → `[A-Za-z0-9_]`, `\s`/`\S` — класс пробелов JavaScript (ASCII-пробелы, U+00A0, U+1680, U+2000–200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) и его отрицание, `.` → `[^\n\r  ]`, `$` → `\Z` (без хвостового `\n`, R-note для Django плана 0).
- Блокировки — R47/R52 и сила P57: READ COMMITTED, порядок waybill → recall → labTest → complaint → organization → batches (`ORDER BY id`) → recallTasks (`ORDER BY id`) → прочее; явные блокировки `select_for_update(no_key=True, of=('self',))` (`FOR NO KEY UPDATE`), `FOR KEY SHARE`/`FOR SHARE` — сырым SQL; `FOR UPDATE` только для физического удаления строки справочника и `deleteField`; задания и sweeper — `FOR NO KEY UPDATE SKIP LOCKED`; 40P01/40001 → один повтор всей транзакции, затем 409 VERSION_CONFLICT. Движок отзыва — REPEATABLE READ и дополнительно один повтор при 23505 на `ux_recalls_open_source` (параллельный запуск по тому же источнику; повтор находит открытый отзыв), как `RECALL_TX.retryIf` в `backend-express/src/db/tx.ts` (D-I3). Рекомендательные блокировки `refresh:<user>` (P12) и `dictionary:<name>` (R93) — первыми в транзакции. `ATOMIC_REQUESTS = False`.
- **Бюджет соединений (P61 в редакции SP4), Django = 20, по процессам (D-I5).** Размеры пулов — переменные `DJANGO_DB_POOL_MAX` и `DJANGO_SSE_POOL_MAX`, заданные в `environment:` каждого сервиса Django в compose (не в общем `.env`: `DB_POOL_MAX` Express не используется и не переопределяется, D-M9). Правило: в каждом процессе пиковое число одновременных держателей соединения ≤ его пулу.

  | Процесс | Держатели соединений (пик) | Пул | Итого |
  |---|---|---|---|
  | api-django (uvicorn, 1 процесс) | потоки запросов (неограниченно, лишние ждут ≤ 5 с → 503) и relay после commit в том же потоке; поток сервера метрик (`recalls_open`) | `DJANGO_DB_POOL_MAX=7` | 7 |
  | | SSE: resync хаба + replay/`unread` потоков (async) | `DJANGO_SSE_POOL_MAX=2` | 2 |
  | | сеанс `LISTEN notifications` | отдельное соединение | 1 |
  | worker-django (Celery threads -c 2) | 2 потока задач (обработчик + relay в том же потоке) + 2 потока отправки уведомлений (соединение только на захват/запись, на время SMTP/Telegram отпускается) + 1 поток поллера Telegram | `DJANGO_DB_POOL_MAX=6` (5 + 1 запас) | 6 |
  | beat-django (InProcessScheduler) | 4 потока заданий (`lab-escalation`, `recall-task-overdue`, `notification-delivery`, `outbox-sweeper`); сессионный advisory lock и транзакции тика — на одном соединении потока; отправки `notification-delivery` (`mode='stale'`) идут синхронно в потоке задания на его соединении, без своих потоков | `DJANGO_DB_POOL_MAX=4` | 4 |
  | **Сумма** | | | **20** |

  `CONN_MAX_AGE = 0` (обязательно с пулом), пул psycopg с `check=ConnectionPool.check_connection` (соединения переживают `./at reset` из другого worktree), ожидание ≤ 5 с (`DB_CONNECT_TIMEOUT_MS`), `statement_timeout` 30 с и `lock_timeout` 10 с — параметром `options` при подключении (не `SET` на пуловом соединении); нет соединения / 57014 / 55P03 → 503 BACKEND_UNAVAILABLE (в фоновых процессах — неудачная попытка/тик, а не падение).
- Идемпотентность — R48/R53: ключ `idem:{userId}:{key}`, отпечаток = sha256 hex от `"{METHOD} {path}\n"` + сырые байты тела, значения и Lua-скрипты побайтово как в `backend-express/src/http/idempotency.ts` (запись одной реализации воспроизводится другой).
- Rate limits — R30 + `RATE_LIMIT_OVERRIDES` (P10, P41 с `complaint-ip`); IP клиента — последний элемент `X-Forwarded-For`, `::ffff:` → IPv4 (P9).
- События — outbox R55/R56: строка `outbox_events(backend='django')` в той же транзакции; публикация после commit (fast path) + sweeper каждые 5 с; обработчик начинает транзакцию с `INSERT INTO processed_events … ON CONFLICT DO NOTHING`. Exchange `agrotrace.django`, очереди `agrotrace.django.jobs`, `.jobs.dlq`, `.jobs.delay` — только имена `infra/rabbitmq/definitions.json`. Решение по Celery и Beat — ниже, раздел «Очередь, воркер и планировщик».
- Общие ключи Redis — таблица контракта (R82, R92, P9): значения JSON читаются разбором, `pub:batch:*` отдаётся побайтово; токены писем — 32 байта base64url, ссылки от `PUBLIC_BASE_URL`.
- Файлы — MinIO, WebP 96/480 без увеличения (Pillow), подписанные ссылки: ключ = **сырые байты** HMAC-SHA256(JWT_SECRET, "agrotrace:file-url:v1"), подпись hex HMAC(ключ, "{id}:{exp}"), TTL 3600 (R28/R34/R39/R88); ETag = sha256 отдаваемых байт.
- Пароли — Argon2id PHC `$argon2id$v=19$m=65536,t=3,p=1$…` без префикса `argon2$` (§8.3), hash 32 байта, salt 16; хеши Express/сида проверяются Django и наоборот. JWT HS256 общий `JWT_SECRET`, claims и их типы — P12; cookie `at_refresh` (HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth) — та же строка `Set-Cookie`, что у Express; общая таблица `refresh_tokens`. Сессия, начатая на Express, продолжается на Django и наоборот.
- `X-Backend: django` во всех ответах (включая ассеты Swagger UI, 404/405/413/500); `X-Request-Id` по R79; журналы — JSON (structlog) с полями `backend` и `requestId`, секреты замаскированы на любой глубине (P8).
- `audit_log` для всех изменяющих операций: `backend='django'`, `action=operationId`, diff `{field:[before,after]}` в API-формате, секреты `"***"`, раскладка полей — как в решениях отчётов Express (task-2/3/4-5/6-7/8-9 «Decisions»). Запись аудита — общая инфраструктура с Task 1 (у Express она была ретрофитом Task 4).
- Конфигурация тестового стенда, которую Django обязан соблюдать: `RATE_LIMIT_OVERRIDES` (P10/P41), `MERCURY_RETRY_BASE_MS`/`MERCURY_FAIL_PRODUCT_CODES`/`MERCURY_FAIL_MODE` + перезапуск воркера в `api:test` (P35), `SCHEDULER_TICK_MS` (по умолчанию 300000, стенд 1000), `REPORT_MAX_ROWS` (P50, стенд 13), `METRICS_PORT` 9464 (P54), `TELEGRAM_BOT_TOKEN` только у api (P14/P51), `DADATA_API_KEY` пуст, `TZ=${API_TEST_TZ:-UTC}`.
- Записи стенда в общую БД (P48/P51/P59, список контракта и `tests/api/lib/sanctioned.ts`): реализация ведёт себя так, будто их сделал другой процесс, и **не кеширует** эти строки дольше одного запроса (продукты, пользователи, организации, сроки, `outbox_events`, `processed_events`, сеанс LISTEN).
- Схема БД — только dbmate (`db/migrations`); Django-миграции отключены (`MIGRATION_MODULES` → None для всех приложений), `manage.py migrate` не вызывается никогда.
- **Worktree и общий стенд.** Работа — в `C:/project-wt/plan-3`, ветка `feat/plan-3-django` от `main`, содержащего SP1–SP7. Перед первым `./at.sh` скопировать `C:/project/.env` (уже с переменными SP6) в worktree (иначе at.sh создаст `.env` из примера с `GATEWAY_PORT=80`). Стенд общий с worktree Laravel: мьютекс at.sh сериализует меняющие стенд команды; никогда `./at down`, `docker compose down`, `--remove-orphans`, `restart` инфраструктуры, правка инфраструктурных сервисов compose, остановка чужих контейнеров (планировщики других реализаций на время `api:test` гасит сам SP1).
- **Общие файлы** (`at.sh`, `docker-compose.yml`, `docker-compose.api-test.yml`, `.github/workflows/ci.yml`, `.env.example`) правятся только внутри размеченных секций SP3 `# --- django (plan 3) ---` … `# --- end django ---`; каждая такая правка — отдельный коммит `chore(stand): …`; при конфликте с Laravel оставляются обе секции. `tests/at/at.test.ts`, `tests/cross/**`, шлюз и текст P61 контракта этот план не меняет (SP1/SP3/SP4/SP5 уже на `main`; шлюз маршрутизирует `<front>-django.localhost` на `api-django:8000`).
- Express после каждой правки общих файлов остаётся зелёным: `./at.sh api:test express` по затронутым файлам и `./at.sh at:test`.
- **Регрессия задачи N** — `./at.sh api:test django --reset <файлы tests/api задач 1…N>` (аргументы — фильтры vitest по именам файлов). Файл задачи «зелёный» означает: все его тесты, кроме перечисленных в строке «ждут» этой задачи (тесты, чьи фикстуры `tests/api/lib/{fixtures,production,quality}.ts` вызывают операции более поздней задачи); такие тесты исполнитель перечисляет в отчёте с номером задачи, в которой они обязаны позеленеть (D-I2). Полностью зелёные файлы — не позже указанной задачи.
- Unit-тесты Django: `./at.sh django:test` — заглушка SP2 (мьютекс, пересоздание `agrotrace_test_django` общим помощником), которая вызывает хук Django из Task 1 (pytest + ruff в образе backend-django); `agrotrace_test` (tests/db, gen:db-types) Django не трогает (D-C1). Покрытие `agrotrace/domain` ≥ 70% (§14.1).
- Коммиты — Conventional Commits, scope `django` (или `stand` для общих файлов), трейлер `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`, LF.

### Процесс api: ASGI

- `uvicorn agrotrace.asgi:application --port 8000 --workers 1`. Один процесс, как описывает абзац P61 в редакции SP4: один сеанс LISTEN на реализацию (§8.2.4), метрики без мультипроцессного режима, бюджет соединений держит пул. `agrotrace/asgi.py` — обёртка над `get_asgi_application()`, обрабатывающая `lifespan` (Django его не поддерживает): при старте запускает SSE-хаб (сеанс LISTEN существует с запуска, как у Express), сервер метрик на `METRICS_PORT` и проверку конфигурации; при остановке закрывает хаб первым.
- Синхронные DRF-представления исполняются Django ASGI каждое в своём потоке (`ThreadSensitiveContext` на запрос) — параллельные запросы действительно параллельны (нужно для гонок и `locks.test.ts`); соединения берутся из пула Django и возвращаются в конце запроса.
- SSE — асинхронное представление (`StreamingHttpResponse` с асинхронным генератором); в нём нет синхронного ORM (иначе `SynchronousOnlyOperation`): чтения — через асинхронный пул psycopg (2), LISTEN — отдельное `psycopg.AsyncConnection` в autocommit, на котором выполняется только `LISTEN notifications`.
- **Разрыв клиента в синхронных представлениях (D-I7).** Под Django ASGI `http.disconnect` отменяет только асинхронную обёртку, поток представления продолжает работу. Поэтому `asgi.py` оборачивает `receive`: на `http.disconnect` взводится `threading.Event`, хранимый в `contextvars` запроса (contextvars переходят в потоки `sync_to_async`); `core.context.client_gone() -> bool` читает его. Его опрашивают `Lane.run(cancelled=client_gone)` (снятие ожидающей задачи SVG/XLSX/отчёта), очередь отчётов и SSE. Каждый вызов представления обёрнут `try/finally: connections.close_all()` в том же потоке, поэтому отменённый запрос не уносит пуловое соединение (сигнал `request_finished` при отмене может не выполниться).
- Лимиты Django для тела отключены: `DATA_UPLOAD_MAX_MEMORY_SIZE = None`, `DATA_UPLOAD_MAX_NUMBER_FIELDS = None`, `DATA_UPLOAD_MAX_NUMBER_FILES = None` (иначе `RequestDataTooBig` — HTML 400 раньше `core.body`); 12 МиБ JSON и лимиты загрузок проверяют `core.body` и `core.multipart` (D-M2).

### Очередь, воркер и планировщик: как Celery ложится на контракт (решение плана)

Контракт прямо допускает Celery (`contracts/events/envelope.schema.json`: «Celery and Laravel Queue pass this document as the single argument of the task/job named by `type` (their wrapper format is library-defined)»; «Celery and Laravel Queue may use the delay queue as well … as long as the busy delivery is settled at once»). Поэтому порт использует **обычные задачи Celery**, а не собственный kombu-consumer, и закрепляет конфигурацию так, чтобы топология и семантика совпадали с контрактом:

- **Сообщение.** Протокол сообщений Celery v2: имя задачи = `type` события (`recall.requested`, `notification.dispatch`, `lab.escalate`, `rating.recalculate`, `vsd.import`), единственный аргумент — конверт целиком (тот же документ, что `outbox_events.payload`, валиден по envelope.schema.json), `task_id` = `id` события. Документ события байт-в-байт тот же, что у Express; различается только обёртка, которую контракт оставляет библиотеке. Очередь Django читает только Django (§8.2.1), поэтому обёртка наружу не видна.
- **Публикация — только из outbox.** Бизнес-код никогда не вызывает `delay()`/`apply_async()`/`retry()`. Relay (после commit через `transaction.on_commit`) и sweeper публикуют строку `outbox_events` вызовом `app.send_task(type, args=[envelope], task_id=id, exchange='agrotrace.django', routing_key=type, delivery_mode=2, retry=False)` с publisher confirms (`broker_transport_options={'confirm_publish': True}`, тайм-аут подтверждения 10 с), затем `UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = :id AND published_at IS NULL`. Идиома `transaction.on_commit(lambda: task.delay())` запрещена: падение между commit и publish теряет событие (§11.2, R55); здесь on_commit только ускоряет relay, гарантию даёт строка и sweeper.
- **Топология не объявляется Celery.** `Queue('agrotrace.django.jobs', Exchange('agrotrace.django', 'topic', no_declare=True), routing_key='#', queue_arguments=<ровно аргументы definitions.json>, no_declare=True)`; `task_default_queue='agrotrace.django.jobs'`, `task_default_exchange='agrotrace.django'`, `task_default_exchange_type='topic'` (иначе `send_task` уходит в `celery` и при `task_create_missing_queues=False` падает); `task_create_missing_queues=False`; `worker_enable_remote_control=False` (нет `celery.pidbox` и reply-очередей); `worker_send_task_events=False`, `task_send_sent_event=False`; запуск с `--without-gossip --without-mingle --without-heartbeat`; `task_ignore_result=True`, без result backend; шаг `DelayedDelivery` Celery 5.5 отключён (иначе он объявит `celery_delayed_*` при обнаружении quorum-очереди; способ отключения зависит от версии — Celery закрепляется точной версией в `requirements.txt`, отключение проверяет `test_celery_config.py`). В брокере остаются только имена definitions.json — это проверяет стенд-тест Tasks 6 и 12.
- **Воркер.** `celery -A agrotrace worker -Q agrotrace.django.jobs -P threads -c 2 --prefetch-multiplier 1`; `task_acks_late=True`, `task_reject_on_worker_lost=True`, `worker_detect_quorum_queues=True` (QoS не глобальный — иначе quorum-очередь отклоняет consume). Две доставки в работе (prefetch 2 на канал вместо «двух каналов по 1» Express) и не более одного `vsd.import` на процесс — свободный слот всегда обслуживает уведомления (R92).
- **Обработчик** (`events.tasks.EventTask`): одна транзакция `with_tx`, первым оператором claim `processed_events`; 0 строк → пустой commit, ack. Сбой → повтор в процессе до 5 раз с паузами 2, 4, 8, 16, 32 с (каждый — новая транзакция), затем `raise Reject(requeue=False)` → DLQ. Занятый `vsd.import` (неблокирующий `threading.Lock` процесса): без claim и эффектов публикуется копия того же сообщения **сырым kombu** (D-I6: `send_task` Celery подменяет пустой `exchange` на exchange по умолчанию задачи, и копия по привязке `#` сразу вернулась бы в `jobs` без 5-секундной паузы): `kombu.Producer(channel).publish(body=<тело Celery v2 из request: [args, kwargs, embed]>, headers=<заголовки Celery v2: task, id, …>, content_type='application/json', content_encoding='utf-8', delivery_mode=2, correlation_id=id, exchange='', routing_key='agrotrace.django.jobs.delay', mandatory=True, retry=False)` на отдельном канале с publisher confirms (`events.tasks.publish_delay_copy(request) -> None`); только после подтверждения задача завершается (ack). Возврат брокером (py-amqp поднимает исключение на basic.return без обработчика) или nack → ошибка в журнал, пауза 1 с, `raise Reject(requeue=True)`; без сбоя брокера возврат в голову очереди невозможен (P56 + final m1).
- **Beat.** `celery -A agrotrace beat -S agrotrace.scheduler.beat:InProcessScheduler`. Расписание — Celery Beat (`timedelta(milliseconds=SCHEDULER_TICK_MS)`, `beat_max_loop_interval` ≤ 1 с), но `apply_async` записи переопределён: тик выполняется **в процессе beat** (пул из 4 потоков — по одному на задание, тик одного задания не перекрывается; `Scheduler.producer` не трогается никогда) под `pg_try_advisory_lock(hashtext('agrotrace.scheduler.<задание>'))` на соединении потока задания, на нём же идут транзакции тика (одно соединение на задание, см. бюджет), с выборкой `FOR NO KEY UPDATE SKIP LOCKED`; каждое задание запускается сразу при старте процесса. В брокер beat ничего не публикует. Почему не сообщение в очередь: в очереди по контракту только конверты пяти типов событий (envelope enum); тик ждал бы за `vsd.import` в двух слотах воркера; `queue_messages` считал бы тики; advisory lock всё равно нужен (§8.2.2). Sweeper outbox (5 с, `pg_try_advisory_lock(hashtext('agrotrace.outbox.django'))`, ретенция R59) — тоже запись этого Beat (контракт не фиксирует процесс sweeper; у Express он в api).

### Реестр обязательств порта (D-M10)

Сводка обязательств из журнала Express, которые задачи ниже несут в своих «Port notes»; бриф задачи извлекается вместе с этой таблицей.

| Обязательство | Источник | Задача |
|---|---|---|
| 405 + `Allow`, `_root`, строгая маршрутизация, R79, маскирование журналов | P3, P7, P8 | 1 |
| Формы ошибок, порядок 400 (путь → If-Match+тело), дискриминатор | P16, P19, P36, P44, final M2 | 1, 7, 11 |
| Моменты: мс + `Z`, один `now()` на операцию | P38, P43 | 1 (guard), 9, 10, 13 |
| Бюджет 20 соединений, 5 с, statement/lock timeout → 503 | P61 (SP4) | 1 |
| Outbox в транзакции, relay после commit, sweeper 5 с, `processed_events`, ретенция | R55, R56, R59, P1 | 1, 6 |
| `RATE_LIMIT_OVERRIDES` (с `complaint-ip`), неверное значение — стоп при старте | P10, P41 | 1, 2, 11 |
| IP последнего хопа, `no-store`, JSON-значения Redis | P9 | 2 |
| Refresh: advisory lock первым, типы claims, cookie-интероп | P12, R32, R40 | 2 |
| Argon2 PHC без `argon2$`, интероп с хешами Express/сида | §8.3 | 2 |
| Загрузки, SVG-пределы и полосы, снятие задачи ушедшего клиента | P14, P15, P17, P18, P20, P21 | 3 (+ D-I7 в 1) |
| Подписанные ссылки: ключ — сырые байты, `exp` `^[1-9]\d{0,11}$`, `sig` 64 hex | R28, R39, R88, P17 | 3 |
| S3 `when_required` | P4 | 3 |
| XLSX: стадии, пределы, семантика ячеек exceljs | P23–P28 | 4 |
| Сила блокировок, `FOR UPDATE` только в 2 местах | P57, final m2 | 1, 4, 5, 10 |
| `MERCURY_*` и перезапуск воркера | P35 | 6 |
| Занятый `vsd.import` → `.jobs.delay`, `mandatory` + confirm, никогда requeue в голову | P56, final m1, R92 | 6 |
| QR: PNG 1024, PDF — этикетка A6 (контракт, ruling координатора к D-I4) | R43, R44 | 6 |
| Идемпотентность, Lua, отпечаток; разрыв клиента не освобождает ключ | R48, R53, T6-7 I1 | 7 |
| Отзыв выигрывает у приёмки | P39 | 7, 10 |
| Ядро движка отзыва в Task 9; RR + повтор 23505 `ux_recalls_open_source` | P2, D-I3 | 9, 10, 11 |
| `SCHEDULER_TICK_MS`, advisory lock задания, запуск при старте; векторы рабочих дней и BR-08 | spec 8.2, M2 (T8-9) | 9 |
| ALTCHA побайтово (ключ hex как UTF-8) | P40 | 11 |
| Доставка: 3 попытки 1/2 с, срок попытки 30 с, захват на отправку, штамп µs текстом | P45, P49, N5 | 12 |
| SSE: водяной знак, окно 60 с, догон при resync, `LISTEN` последним оператором, `reauth`, `ping` | R33, P46, P53, N1 | 12 |
| Telegram-токен только у api | P14, P51 | 1, 12 |
| `REPORT_MAX_ROWS`, рендер вне потока, 503 report-busy до чтения данных | P50, P52, N3 | 13 |
| `METRICS_PORT` 9464, ряды и метки | P54 | 14 |
| Записи стенда не кешируются | P48, P51, P59 | все |
| Имена backend не зашиты в тесты | P58 | все |

## Review Focus

1. **Блокировки под Django ORM.** `select_for_update()` по умолчанию — `FOR UPDATE` (конфликтует с `FOR KEY SHARE` и даёт взаимоблокировку I2 финального ревью Express); с `select_related` блокирует и присоединённые строки; ленивый queryset, вычисленный вне `atomic`, не блокирует ничего; вложенный `atomic` — savepoint, в котором `SET TRANSACTION ISOLATION LEVEL` невозможен. Ожидание: ровно один успех в гонках, без 40P01 в журнале postgres. Тесты: `locks.test.ts`, гонки в `waybills/processing/recalls.test.ts`, unit `test_static_guards.py` (Task 1, дополняется в Task 10) и `test_tx.py`.
2. **Границы транзакций и Celery.** Событие должно рождаться строкой outbox в транзакции и публиковаться только после commit; откат (в том числе первая попытка повтора 40P01) не публикует ничего; Celery не объявляет и не создаёт ни одного имени вне definitions.json; занятый `vsd.import` не держит канал. Тесты: `documents.test.ts` «worker concurrency», `recalls.test.ts` повторная публикация, unit `test_celery_config.py`, `test_event_task.py`, стенд-тест топологии (Task 6, 12).
3. **Асинхронный SSE под ASGI.** Потеря LISTEN (`pg_terminate_backend` по `query = 'LISTEN notifications'`) → поток получает только строки выше водяного знака W плюс поздние коммиты окна 60 с и остаётся живым; разрыв клиента освобождает поток (CancelledError); `reauth` ровно в `exp` токена; `ping` 25 с; никаких `retry:`/комментариев перед первым событием; ни одного синхронного ORM-вызова в event loop. Тесты: `events.test.ts`, unit `test_sse_hub.py` (Task 12).
4. **Формат ошибок DRF и Django.** Любая ошибка — problem+json контракта: 401 (а не 403 DRF) без токена, 405 с `Allow` контракта, `_root` для битого/не-объектного тела, 413 для JSON > 12 МиБ, 404 для путей с `//`, хвостовым `/`, другим регистром и битым percent-escape; `?format=pdf` не перехватывается DRF (`URL_FORMAT_OVERRIDE = None`). Тесты: `contract-shape.test.ts`, `harness.test.ts`, каждый `expectContract`, unit `test_problem.py` (Task 1).
5. **Точность и момент времени.** `Now()` Django = `STATEMENT_TIMESTAMP()`, `auto_now` — часы Python: оба нарушают P43 (createdAt ≠ openedAt); штамп `notifications.claimed_at` сравнивается как текст `claimed_at::text` в SQL, никогда через datetime ORM; DateTime — миллисекунды + `Z`. Тесты: прогон `--tz Europe/Moscow`, `recalls.test.ts` (createdAt = openedAt, closedAt = confirmedAt), unit `test_static_guards.py`, `test_delivery.py` (Task 12).
6. **Валидация вне Zod.** Поля DRF обрезают пробелы, приводят `"5"` к числу и `"true"` к булеву, принимают uuid без дефисов и даты с зоной, считают длину не так; Python `re` с `\d`/`$` пропускает Unicode-цифры и хвостовой `\n`. Ожидание: ключ ошибки и путь — как у Express. Тесты: все 400 в tests/api, unit `test_validation_fields.py`, `test_patterns.py`, векторы BR-11 (Task 1, 7).
7. **Числа и JSON.** Масса из `Decimal` всегда `^\d+\.\d{3}$`, суммы — `MassTotal`; число ячейки XLSX — как десятичный текст числа JavaScript (`5`, не `5.0`); JSON без `NaN`/`Infinity`, без `ensure_ascii`, целое `5.0` в теле запроса — целое (как в JS). Тесты: `dictionaries.test.ts` (импорт), `processing.test.ts` (BR-04 params), unit `test_js_number.py`, `test_json_body.py` (Task 1, 4, 8).

---

## Карта файлов

```
backend-django/
  Dockerfile Dockerfile.dockerignore requirements.txt requirements-dev.txt pyproject.toml manage.py
  agrotrace/
    settings.py asgi.py urls.py celery_app.py
    core/      config.py (env, бюджет, overrides) contract.py (бандл, методы путей, шаблон маршрута) context.py (contextvars:
               requestId, ids событий запроса) middleware.py (request id, X-Backend, access log, сырой путь, method guard)
               body.py (JSON 12 МиБ) problem.py (AppProblem, обработчик исключений DRF/Django) patterns.py (ecma)
               validation.py (ContractSerializer, строгие поля) views.py (ContractView: порядок проверок) auth.py access.py
               ratelimit.py idempotency.py if_match.py multipart.py tx.py (with_tx, Tx.now) locks.py sql.py render.py
               (JSON, iso, mass) audit.py logging.py metrics.py
    domain/    rules.py state_machine.py dates.py decimal.py idempotency.py strings.py   (порт @agrotrace/domain)
    security/  jwt.py passwords.py tokens.py totp.py
    infra/     redis.py s3.py amqp.py outbox.py relay.py mailer.py telegram.py dadata.py mercury.py images.py svg_scan.py
               svg_sanitize.py lanes.py qr.py pdf.py xlsx_write.py xlsx_scan.py csv_read.py altcha.py file_urls.py i18n.py
    modules/<module>/  apps.py models.py (managed = False) serializers.py views.py services.py urls.py mappers.py
               health docs auth me users organizations files dictionaries admin audit fields batches documents waybills
               processing lab recalls rating complaints public notifications analytics reports
    events/    tasks.py (EventTask, регистрация по type, слоты) claim.py handlers/*.py
    scheduler/ beat.py (InProcessScheduler) runner.py (guarded tick) jobs/*.py
    sse/       hub.py stream.py dbpool.py
  tests/       test_*.py (pytest)
docker-compose.yml           секция SP3 django: api-django / worker-django / beat-django
docker-compose.api-test.yml  секция SP3 django: overrides трёх процессов
at.sh                        секция SP3 django: тело хука django:test SP2, строки test:all
.github/workflows/ci.yml     секция SP3 django: job api-django (Task 14)
(tests/at, tests/cross/interop.test.ts, P61 контракта, приглушение планировщиков — уже на main: SP1, SP3, SP4, SP5)
```

Образ (`backend-django/Dockerfile`, контекст — корень репозитория): стадия node собирает бандл контракта (`pnpm --filter @agrotrace/contracts bundle` → `openapi.json`), копирует `swagger-ui-dist` и шрифт Onest (`@fontsource/onest`); стадия `python:3.12-slim` ставит библиотеки Pango для WeasyPrint и закреплённые `requirements.txt` **и** `requirements-dev.txt` (pytest, pytest-cov, ruff — хук `django:test` запускает их в этом же образе, D-M5), копирует `backend-django/`, `contracts/rules`, `contracts/events`, `packages/i18n/locales`, бандл и ассеты. Пользователь не root.

---

### Task 1: Каркас Django, конвейер запроса, стенд и харнесс

**Depends on:** SP1–SP7 на `main` (Global Constraints, «Общая подготовка»): приглушение планировщиков (SP1), БД `agrotrace_test_django` и заблокированная заглушка `django:test` с хуком (SP2), размеченные секции и устойчивые проверки tests/at (SP3), абзац P61 (SP4), `tests/cross/interop.test.ts` (SP5), RabbitMQ с очередями `.delay` и переменные `.env` (SP6), `port-globals.md` (SP7). Если чего-то из этого нет на `main` — BLOCKED, а не собственная реализация.

**Operations:** getHealthLive, getHealthReady; Swagger UI `/api/v1/docs`. **Cross-cutting:** конфигурация, проблемы, валидация, транзакции, outbox (запись), аудит (запись), отслеживание разрыва клиента, Celery-приложение, Beat-каркас.

**Files:**
- Create: `backend-django/**` (каркас по карте), `backend-django/tests/test_{config,problem,patterns,validation_fields,json_body,tx,static_guards,models_schema,asgi_concurrency,scheduler_runner}.py`
- Modify (только секции SP3 `# --- django (plan 3) ---` … `# --- end django ---`, отдельный коммит `chore(stand)` **вместе с** `backend-django/Dockerfile`, чтобы `./at up all` не ломался между коммитами, D-M5): `docker-compose.yml` (сервисы `api-django`, `worker-django`, `beat-django`: образ `agrotrace/backend-django:dev`, `env_file: .env`, `environment:` с `APP_DATABASE_URL`-подключением и `DJANGO_DB_POOL_MAX` 7/6/4, `DJANGO_SSE_POOL_MAX: '2'` у api, `expose: ["9464"]` у api (никогда `ports:`), healthcheck `python -c` urllib на `/api/v1/health/live`, `depends_on` инфраструктуры healthy, `stop_grace_period: 15s`; инфраструктурные сервисы не трогать), `docker-compose.api-test.yml` (api — `RATE_LIMIT_OVERRIDES` `{"user":100000,"login-ip":100000,"complaint-ip":100000}`, `DADATA_API_KEY: ''`, `TELEGRAM_BOT_TOKEN: 'api-test-token'`, `TELEGRAM_BOT_USERNAME: 'agrotrace_test_bot'`, `REPORT_MAX_ROWS: '13'`; worker — `MERCURY_FAIL_PRODUCT_CODES: '99.99.99'`, `MERCURY_FAIL_MODE: '500'`, `MERCURY_RETRY_BASE_MS: '50'`, `TELEGRAM_BOT_TOKEN: ''`; beat — `SCHEDULER_TICK_MS: '1000'`, `TELEGRAM_BOT_TOKEN: ''`; у всех `TZ: '${API_TEST_TZ:-UTC}'`), `at.sh` (тело хука `django:test` SP2 и строки `test:all` в секции django). `tests/at/at.test.ts` не меняется (SP3 сделал проверки устойчивыми).

**Interfaces — Produces:**
- `core.problem.AppProblem(status: int, code: str, *, rule: str | None = None, params: dict | None = None, errors: dict[str, list[str]] | None = None, headers: dict[str, str] | None = None)`; `validation_problem(errors: dict[str, list[str]]) -> AppProblem`; `exception_handler(exc, context)` (DRF `EXCEPTION_HANDLER`) и `handler404/handler500`.
- `core.views.ContractView(APIView)`: атрибут `operation_id: str`; `initial()` в порядке контракта: аутентификация → скоуп `user` (после аутентификации, до роли — решение 10 Task 2 Express) → `x-roles`/`x-org-admin` из контракта → скоупы `x-rate-limit` операции → `Idempotency-Key` при `x-idempotent`; помощники `path_uuid(name) -> str`, `body(serializer_cls, *, extra_errors: dict | None = None) -> dict`, `if_match() -> int`.
- `core.validation.ContractSerializer` и поля `String(min, max, pattern=None)`, `NameString`, `Email`, `Password`, `Uuid`, `IsoDate`, `IsoDateTime`, `Mass`, `DecimalString`, `Percent`, `Inn`, `RegionCode`, `Enum(values)`, `Int(min=None, max=None)`, `Bool`, `ListOf(child, min_items=0, max_items=None)`, `no_duplicate(field)` — порт `packages/validation/src/common.ts` с теми же ключами.
- `core.patterns.ecma(pattern: str, flags: str = '') -> re.Pattern` (применять `.search()`, семантика JSON Schema `pattern`; перевод классов — Global Constraints).
- `core.tx.with_tx(fn: Callable[[Tx], T], *, isolation: Literal['read committed', 'repeatable read', 'read only repeatable read'] = 'read committed', retry_once: bool = True, retry_if: Callable[[Exception], bool] | None = None, conflict_params: Callable[[], dict] | None = None) -> T`; `Tx.now: datetime` (одно чтение `now()`), `Tx.on_commit(cb)`; один повтор для 40P01/40001 (`exc.__cause__.sqlstate`) **и** для исключений, на которых `retry_if` вернул `True`; второй сбой → `AppProblem(409, 'VERSION_CONFLICT', params=conflict_params() if conflict_params else None)`; вызов внутри открытого `atomic` — ошибка программиста. `fn` — только БД (может выполниться дважды, P8). `core.tx.RECALL_TX = dict(isolation='repeatable read', retry_if=is_unique_violation('ux_recalls_open_source'))` — для всех входов движка отзыва (Tasks 9–11, D-I3).
- `core.context.client_gone() -> bool` и обёртка `receive` в `asgi.py` (D-I7).
- `core.locks`: `lock(table_model, ids, *, strength: Literal['no key update', 'update', 'share', 'key share'] = 'no key update', skip_locked: bool = False) -> list` (`ORDER BY id`).
- `core.render`: `iso(dt) -> str` (мс, `Z`), `iso_or_null`, `mass(Decimal) -> str`, `json_bytes(obj) -> bytes`.
- `infra.outbox.enqueue(tx: Tx, type: str, data: dict) -> str` (строка `backend='django'`, `occurredAt` = часы в момент вставки R59, `requestId` из контекста; id регистрируется для relay после commit).
- `core.audit.record(tx: Tx, *, action: str, entity_type: str, entity_id: str, diff: dict, actor: Principal | None, request=None) -> None`.
- `agrotrace.celery_app.app` (конфигурация раздела «Очередь…», задач ещё нет); `scheduler.runner.guarded_tick(name: str, run: Callable[[], int]) -> bool`; `scheduler.beat.InProcessScheduler` (пустое расписание).
- Хук Django для заглушки SP2 (имя — по `shared-prep-report.md`): после того как SP2 под мьютексом пересоздал и мигрировал `agrotrace_test_django`, хук запускает в образе `backend-django` `pytest` и `ruff check` с `TEST_DATABASE_URL` = эта БД ролью `agrotrace_app`; аргументы `./at.sh django:test [pytest args…]` передаются pytest. Мьютекс, создание БД и запись в список блокируемых команд — работа SP2, не этого плана.

**tests/api — зелёные:** `health`, `contract-shape`, `harness`, `docs`, `fixture-writes`.

**Unit-тесты Django:**
- `test_config.py`: по процессам пиковое число держателей ≤ пула (api: потоки ограничены пулом 7, SSE ≤ 2, LISTEN 1; worker: `celery_concurrency (2) + delivery_slots (2) + poller (1) ≤ 6`; beat: `число заданий (4) ≤ 4`, у `notification-delivery` в beat нет собственных потоков отправки), сумма 7 + 2 + 1 + 6 + 4 = 20 — значения читаются из `environment:` сервисов `docker-compose.yml`; неверный `RATE_LIMIT_OVERRIDES` (неизвестный скоуп, 0, не JSON) останавливает старт; `SCHEDULER_TICK_MS` по умолчанию 300000.
- `test_problem.py`: `PoolTimeout`, 57014, 55P03 → 503 BACKEND_UNAVAILABLE; 40P01 дважды → 409 VERSION_CONFLICT; неизвестное исключение → 500 INTERNAL без стека; DRF `NotAuthenticated` → 401 UNAUTHORIZED; `ParseError` → 400 `_root [validation.invalid]`; тело ответа валидно по `Problem` бандла.
- `test_patterns.py`: `ecma(r'\S').search('ab')` — совпадение (NameString из двух символов проходит), `ecma(r'\S').search` на строке из одного U+00A0 — нет; `ecma('^otpauth://totp/')` находит префикс длинной строки; `.` не совпадает с U+2028; `ecma(r'^\d+$')` не принимает `'٣'` и `'1\n'`; `ecma(r'\S')` отклоняет строку из `\u00a0\ufeff`; BR-11 ключ с хвостовым `\n` отклонён.
- `test_validation_fields.py`: случаи `packages/validation/test/**` для общих полей — пустая обязательная строка → `validation.required`; `"5"` в `Int` → `validation.type`; `5.0` в `Int` принят; `true` в `Int` → `validation.type`; пробелы не обрезаются; длина в кодовых точках (`'😀'*255` проходит `maxLength 255`); uuid без дефисов → `validation.uuid`; `2026-09-24T08:30:00+03:00` → `validation.dateTime.format`; масса `'1.5'` → `'1.500'`, `'0.000'` → `validation.positive`; ИНН с неверной контрольной суммой → `validation.inn.checksum`; неизвестный ключ → `validation.unknownField` по его пути; путь `items[0].batchId`.
- `test_json_body.py`: `NaN`/`Infinity` → `_root [validation.invalid]`; массив вместо объекта → `_root [validation.type]`; `charset=latin1` → `_root [validation.invalid]`; 12 582 913 байт → 413 `params.maxBytes 12582912`.
- `test_tx.py` (БД `agrotrace_test_django`): `with_tx(isolation='repeatable read')` видит снимок; первая попытка с 40P01 повторяется, `Tx.now` двух операторов одной транзакции равны; вложенный вызов — `AssertionError`; `retry_if`, вернувший `True` на 23505 с constraint `ux_recalls_open_source`, даёт ровно один повтор, второй такой сбой → 409 с `conflict_params()`; 23505 другого ограничения не повторяется.
- `test_static_guards.py`: в `agrotrace/{modules,events,scheduler,core}` нет `Now()`, `auto_now`, `timezone.now(`, `datetime.now(`, `date.today(` (исключения — `security/jwt.py`, `infra/altcha.py`, `infra/file_urls.py`, `core/logging.py`); нет `select_for_update(` без `no_key=True` и нет `\bfor\s+update\b` (регистр/пробелы любые) в SQL, кроме списка `ALLOWED` (пуст до Tasks 4/5); нет `.delay(`, `.apply_async(`, `.retry(` вне `infra/relay.py` и `events/tasks.py`.
- `test_models_schema.py`: каждое поле моделей `managed = False` есть в `information_schema.columns` `agrotrace_test_django` с совместимым типом и nullability; таблица модели существует (дополняется каждой задачей, добавляющей модели).
- `test_asgi_concurrency.py`: два параллельных запроса к тестовому синхронному представлению с `sleep(0.5)` через ASGI-транспорт завершаются быстрее 0,9 с; 20 запросов, оборванных клиентом (`http.disconnect`) во время запроса к БД, → `pool.get_stats()` показывает 0 выданных соединений; `client_gone()` в потоке представления становится `True` после разрыва; ожидающая задача тестового `Lane`, чей клиент ушёл, снимается и не выполняется.
- `test_scheduler_runner.py`: `guarded_tick` пропускает тик при занятом advisory lock и снимает его в `finally` до возврата соединения в пул; тик одного задания не перекрывается.

**Port notes:**
- Порядок промежуточных слоёв — как `backend-express/src/app.ts`: request id (R79: клиентский `^[A-Za-z0-9._-]{1,64}$` или сгенерированный) и `X-Backend` самыми внешними (на всех ответах, включая ошибки и ассеты) → метрики (Task 14) → access log → отказ по сырому пути (`scope['raw_path']`: пустой сегмент `//` в любом месте, битый percent-escape или не-UTF-8 → 404, P8 и contract-shape «malformed percent-escape») → method guard по методам контракта (405 + `Allow` контракта, в том числе для ещё не реализованных операций и OPTIONS, P3) → JSON-тело (до маршрутизации, чтобы битый JSON на нереализованной операции давал 400, как у Express) → маршруты `/api/v1` (`path()` без `<uuid:>`-конвертеров: не-uuid id — 400 `validation.uuid` в представлении) → 404 problem. `APPEND_SLASH = False`, без `CommonMiddleware`, `ALLOWED_HOSTS = ['*']` (иначе `DisallowedHost` → HTML 400), `DEBUG = False`, `SECRET_KEY` выводится из `JWT_SECRET` (HMAC) — `.env.example` не меняется.
- DRF: `DEFAULT_CONTENT_NEGOTIATION_CLASS` — всегда JSON (без 406), `URL_FORMAT_OVERRIDE = None` (контрактный `?format=`), свой рендерер (`ensure_ascii=False`, компактный, `application/json; charset=utf-8`; problem — `application/problem+json`), парсеры DRF не используются (тело читает `core.body`, сырые байты сохраняются для отпечатка идемпотентности), `DEFAULT_AUTHENTICATION_CLASSES` с `authenticate_header` → 401, `UNAUTHENTICATED_USER = None`, throttling DRF выключен.
- Ошибки в 400 (P36 + final M2): параметры пути проверяются первыми и отдельно; ошибки `If-Match` и тела сливаются в одну карту только при верных параметрах пути; ключ — `_root` для тела целиком (P7); тесты требуют ключи через `toContain` (P16), лишних полей ошибки быть не должно.
- `/api/v1/docs`: HTML без inline-скриптов и внешних origin, ассеты `swagger-ui-dist` и инициализатор (`url: '/api/v1/docs/openapi.json'`) отдаёт Django с `X-Backend`; JSON = бандл контракта (docs.test.ts сравнивает с `contracts/openapi.yaml`). Проверка `./at.sh docs:test django` (R89/I6, P5).
- Health ready — db, redis, rabbitmq, s3 с тайм-аутом; отказ → 503 по контракту.
- Модели `managed = False` пишутся вручную по `db/schema.sql` только для таблиц, которые читает ORM; графы, отчёты, массовые операции — сырой SQL с плейсхолдерами (§7.6, §8.8).
- at.sh (секция django SP3): тело хука `django:test` и строки `test:all` (`django:test`, `api:test django --reset`, `api:test django --ratelimits`) в отведённом SP3 месте. Приглушение планировщиков других реализаций в `api:test` — SP1, план его не трогает.
- Lanes (`infra/lanes.py`, используются с Task 3): дочерние процессы через `multiprocessing.get_context('forkserver')` (процесс uvicorn многопоточный, `fork` небезопасен), `resource.setrlimit(RLIMIT_AS, memory_mb)` в дочернем процессе (D-M3).
- Шаг 0 — worktree: `git worktree add C:/project-wt/plan-3 -b feat/plan-3-django main` (если ещё нет; `main` содержит SP1–SP7), копия `.env`, `./at.sh install`.

- [ ] **Шаг 0: worktree от `main` с SP1–SP7 (проверить: `docs/superpowers/plans/port-globals.md`, секции `# --- django (plan 3) ---` в at.sh/compose/ci.yml, `tests/cross/interop.test.ts`, заглушка `./at.sh django:test` отвечает «added by Plan 3»), `.env`, `./at.sh install`.**
- [ ] **Шаг 1: Unit-тесты выше (RED):** `docker compose run --rm --no-deps api-django pytest` → FAIL (модулей нет; хука ещё нет).
- [ ] **Шаг 2: Dockerfile + секции compose, api-test overrides и at.sh (хук `django:test`); коммит общих файлов вместе с Dockerfile.** `./at.sh at:test` PASS (без правок tests/at); `./at.sh django:test` запускает pytest (RED); `./at.sh api:test express health` PASS.

```bash
git add backend-django/Dockerfile backend-django/Dockerfile.dockerignore backend-django/requirements*.txt docker-compose.yml docker-compose.api-test.yml at.sh
git commit -m "chore(stand): django services, api-test profile, django:test hook"
```

- [ ] **Шаг 3: RED по HTTP:** `./at.sh api:test django health contract-shape harness docs` → FAIL (нет маршрутов / нет `X-Backend: django`).
- [ ] **Шаг 4: Реализация каркаса по Interfaces.**
- [ ] **Шаг 5: GREEN:** `./at.sh django:test` PASS; `./at.sh api:test django health contract-shape harness docs fixture-writes` PASS; `./at.sh docs:test django` PASS; `./at.sh up react django` отвечает через шлюз `react-django.localhost:<GATEWAY_PORT>/api/v1/health/live` с `X-Backend: django`.
- [ ] **Шаг 6: Commit**

```bash
git add backend-django
git commit -m "feat(django): skeleton, problem handling, contract middleware, swagger ui"
```

### Task 2: Аутентификация и сессии

**Operations:** login, refreshToken, logout, setupTwoFactor, verifyTwoFactor, forgotPassword, resetPassword, registerOrganization, acceptInvite; **перенесены из Task 4 (D-I2):** approveOrganization, updateAdminOrganization — их вызывают фикстуры `freshHead`/`activateOrg`/`setOrgStatus` (`tests/api/lib/fixtures.ts`), от которых зависят почти все файлы tests/api (модуль `modules/admin`, его listAdminOrganizations остаётся в Task 4).

**Files:** Create: `agrotrace/modules/auth/**`, `agrotrace/modules/admin/{views,services,serializers,urls}.py` (approve, update), `agrotrace/security/{jwt,passwords,tokens,totp}.py`, `agrotrace/core/{auth,ratelimit}.py`, `agrotrace/infra/{redis,mailer,dadata,i18n}.py`, `tests/test_{jwt,passwords,totp,ratelimit,client_ip,i18n_mail}.py`, `agrotrace/modules/public/cache.py`.

**Interfaces — Produces:**
- `security.jwt.Principal(user_id: str, org_id: str, roles: list[str], org_admin: bool)`; `issue_access_token(p: Principal, now: datetime) -> str`; `verify_access_token(token: str) -> tuple[Principal, int] | None` (второе — `exp`).
- `security.passwords.hash_password(pw: str) -> str`, `verify_password(phc: str, pw: str) -> bool`, `dummy_verify(pw: str) -> None`.
- `security.tokens.new_opaque_token() -> str`, `sha256hex(s: str) -> str`; `security.totp.verify(secret, code, now) -> int | None` (принятый шаг).
- `core.ratelimit.hit(scope: str, subject: str) -> None` (raise 429); `core.ratelimit.client_ip(request) -> str`.
- `infra.mailer.send_once(to: str, subject: str, text: str) -> None` (`EMAIL_TIMEOUT` задан); `infra.i18n.t(key: str, params: dict | None = None) -> str` по `packages/i18n/locales/ru.json`; `infra.dadata.check_inn(inn) -> Literal['PENDING', 'MANUAL_CHECK']`.
- `modules.auth.sessions.issue(tx, user_id) -> str` (cookie-строка), `rotate(...)`, `revoke_chain(...)`.
- `modules.public.cache.drop(codes: Iterable[str]) -> None` (после commit через `Tx.on_commit`, `DEL` пачками по 500) и `codes_of_org(tx, org_id) -> list[str]` (партии, где организация — происхождение или этап `path`).

**tests/api — зелёные:** `auth` (тесты `[ratelimit]` — в `--ratelimits`); **ждут:** тесты `auth`, использующие фикстуру `invite`/`invitedUser` (inviteUser) → Task 3. После задачи: `./at.sh cross:test express django session` и `django express session` PASS.

**Unit-тесты Django:**
- `test_jwt.py`: токен формата Express (заголовок `{"alg":"HS256","typ":"JWT"}`, claims P12) проверяется; отклоняются `alg: none`, HS512, неизвестный `crit`, `roles: []`, неизвестная роль, `org_admin: "true"`, `exp` дробный, `sub` не uuid; `iat` в будущем принимается (как jose); `exp <= now` — истёк.
- `test_passwords.py`: PHC-строка, полученная Node `argon2.hash` с параметрами сида (закрепить литералом в тесте, сгенерировав `./at.sh pnpm --filter @agrotrace/backend-express exec node -e …` один раз), проверяется; новый хеш начинается с `$argon2id$v=19$m=65536,t=3,p=1$`; значение `'!'` приглашённого → `False`, не исключение.
- `test_totp.py`: векторы RFC 6238 (SHA1, 6 цифр, 30 с), окно ±1 шаг.
- `test_ratelimit.py`: ключ `rl:{scope}:{subject}:{windowStartEpochSec}`, `INCR` + `EXPIRE … NX` в одном MULTI, `Retry-After` = секунды до конца окна, `params {scope, limit, windowSec}`; overrides меняют только `limit`.
- `test_client_ip.py`: последний элемент `X-Forwarded-For`; без него — адрес сокета (`scope['client']`); `::ffff:10.0.0.1` → `10.0.0.1`.
- `test_i18n_mail.py`: тема и текст письма сброса и приглашения совпадают с выводом `@agrotrace/i18n` для тех же параметров (ожидаемые строки закрепить литералами, снятыми с Express).

**Port notes:**
- Порядок входа R31 (+ final M3: блокировка вычисляется по `now()` БД), гонка верного пароля с пятым неверным не специфицирована (P60); 2FA R35, challenge `2fa:*`/`2fa-fail:*`, `totp-used:*` `SET NX EX 90`; verifyTwoFactor перепроверяет статусы → 401 TOKEN_EXPIRED (решение 4 Task 2 Express).
- Refresh R32/R40/P12: `pg_advisory_xact_lock(hashtext('refresh:' || user_id))` первым, затем `refresh_tokens FOR NO KEY UPDATE`; повтор старого ≤ 10 с → 401 TOKEN_EXPIRED без `Set-Cookie`, позже → отзыв только цепочки `replaced_by`; отозванный logout → 401 + очищающая cookie. Токен — 32 байта base64url, в БД sha256 hex. Строки `Set-Cookie` — ровно `at_refresh=<t>; Max-Age=1209600; …`/`at_refresh=; Max-Age=0; …` как `sessions.ts` (не `response.set_cookie`, он добавляет `expires`).
- `Cache-Control: no-store` у login/refresh/verify (P9). Ответ login — `twoFactorRequired: false` (R29).
- Строки R36 (без trim, email в нижний регистр, длины в кодовых точках); email — regex Zod 3 (ASCII), не `EmailValidator` Django. ИНН с контрольной суммой (R66); `validation.<field>.taken` собираются в один 400 до DaData (решение 6); DaData: нет ключа → MANUAL_CHECK, 3 попытки × 3 с, 4xx → недоступно (решение 7).
- `forgotPassword`/`resetPassword`/`acceptInvite`: `pwreset:*`/`invite:*` (R82), тело проверяется до `GETDEL` (R92), `GETDEL` окончательный (P53); сброс пароля отзывает refresh-токены под тем же advisory lock.
- Аудит (решение 3 Task 2 Express): registerOrganization, acceptInvite, resetPassword, setupTwoFactor; создание — `password: [null, "***"]`, смена — `["***","***"]`.
- Скоуп `login-ip` по IP (P9), `forgot` по email в нижнем регистре; тесты отправляют свой `X-Forwarded-For`.
- approveOrganization / updateAdminOrganization (`modules/admin`, из Task 4 Express): не-uuid id у approve → 404 (решение 1 Task 4-5); одобрение/отклонение/SUSPENDED влияют на вход и refresh (R54/D26, R37 refresh 403); строка организации `FOR NO KEY UPDATE`, место в порядке — после complaint, до batches (R59); смена имени или региона сбрасывает `pub:batch` всех партий, где организация — происхождение или этап `path` (решение 16, R82); аудит `organization` (name, address, regionCode, status), неизменённое обновление не пишет строку.

- [ ] **Шаг 1: unit-тесты RED** (`./at.sh django:test tests/test_jwt.py …` → FAIL).
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django auth` → FAIL (404 на `/auth/*`).
- [ ] **Шаг 3: Реализация по Interfaces.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 2; `./at.sh api:test django --ratelimits auth`; `./at.sh cross:test express django session`; `./at.sh cross:test django express session`.
- [ ] **Шаг 5: Commit** `feat(django): authentication, sessions, 2fa, registration`.

### Task 3: Профиль, пользователи, организации, файлы

**Operations:** getMe, updateMe, uploadMyAvatar, deleteMyAvatar, getMyChannels, updateMyChannels, createTelegramCode, listUsers, inviteUser, updateUser, getUserAvatar, getOrganization, listOrganizations, uploadOrganizationLogo, getOrganizationLogo, downloadFile, downloadPublicFile.

**Files:** Create: `agrotrace/modules/{me,users,organizations,files}/**`, `agrotrace/core/multipart.py`, `agrotrace/infra/{s3,images,svg_scan,svg_sanitize,lanes,file_urls}.py`, `tests/test_{multipart,images,svg,lanes,file_urls}.py`.

**Interfaces — Produces:**
- `core.multipart.read_single_file(request, *, max_bytes: int) -> Upload(name: str, data: bytes)` (ошибки — 400/413 по P14).
- `infra.images.sniff(data) -> str | None` (MIME по сигнатуре), `variants(data, mime) -> dict[str, bytes]` (`'96'`, `'480'`).
- `infra.lanes.Lane(name, target, *, waiting: int, deadline_s: float, memory_mb: int)`; `Lane.run(payload, *, cancelled: Callable[[], bool]) -> Any` (raise `LaneBusy`/`LaneTimeout`) — дочерний процесс, ожидание входит в срок, `terminate()` и перезапуск с back-off.
- `modules.files.services.store(tx, *, kind, owner_id, upload, mime) -> dict`, `serve(request, file_row, variant) -> HttpResponse`.
- `infra.file_urls.signed(id: str, now) -> str`, `verify(id, exp, sig, now) -> bool`, `public_url(id) -> str`.
- `modules.organizations.services.visible_org_ids(tx, principal) -> SQL` (`modules.public.cache.drop`/`codes_of_org` — из Task 2).

**tests/api — зелёные:** `profile`, `users`, `organizations`, `files`, `auth` полностью; **ждут:** тесты, читающие продукты/регионы через справочники или журнал аудита (`/dictionaries`, `/audit-log`) → Task 4 — исполнитель перечисляет их поимённо.

**Unit-тесты Django:**
- `test_multipart.py`: вторая часть `file` → `validation.duplicate`; посторонняя часть → `validation.unknownField`; имя `a/b\c.png` → `c.png`; базовое имя 256 кодовых точек → `validation.maxLength`; ровно лимит принимается, лимит+1 → 413.
- `test_images.py`: PNG под `.jpg` → PNG; изображение 40×20 сохраняет размер в обоих вариантах; > 40 Мп → 415; битый PNG → 415.
- `test_svg.py`: вложенность 65 → 415 `svg-too-complex`; 5 001 элемент → 415; `<script>`/`foreignObject`/`use` → 415 `{allowed}`; `style="fill:url(http://x)"` удалён, `fill="url(#g)"` сохранён; DOCTYPE → 415; корень `s:svg` → 415.
- `test_lanes.py`: медленная задача (инъекция) → `LaneTimeout` за 3 с с учётом ожидания; 1 выполняемая + 8 ожидающих, девятая → `LaneBusy`; снятие ожидающей при закрытии клиента.
- `test_file_urls.py`: для `id`/`exp`/`JWT_SECRET` из закреплённого вектора подпись равна значению `backend-express/src/infra/file-urls.ts` (снять литерал); ключ — сырые байты HMAC, `id` в нижнем регистре; просроченная, верхний регистр или длина ≠ 64 у `sig` → `False`; `exp` не по `^[1-9]\d{0,11}$` (`0`, `01`, `+5`, 13 цифр) → `False` (P17, D-M11).
- `test_lanes.py` дополнительно: задача, чей клиент ушёл (`client_gone()` → `True`), снимается из ожидания; дочерний процесс создан контекстом `forkserver` и ограничен `RLIMIT_AS`.

**Port notes:**
- Видимость организаций (решения 1–3 Task 3 Express): своя + контрагенты видимых накладных (отправитель — любой статус, получатель — кроме DRAFT); INSPECTOR/ADMIN — все; удалённые — никому; невидимая → 404, видимая чужая при загрузке логотипа → 403; listOrganizations (R46) без PLATFORM.
- UserPatch R37, самоправка ролей/статуса → `validation.notAllowed` на каждом поле (решение 10), несоответствие роли типу организации → `errors.roles [validation.notAllowed]` (P14).
- Загрузки P14/P15/P17/P18/P20/P21: тип по сигнатуре, порядок 400 → 413 → 404/403 → 415; SVG — потоковый предразбор без регулярок с возвратом, санитизация в `Lane` (две полосы ≤ 64 КиБ и крупнее), срок 3 с, `cancelled=client_gone` (D-I7: `organizations.test.ts` — 5 оборванных загрузок, затем законная < 3 с); хранится очищенный документ (`sizeBytes`, `sha256` — по нему). Python-санитизатор даёт другие байты, чем DOMPurify, — допустимо: файл хранится один раз.
- Скачивание R34/R39: ETag = `"` + sha256 + `"`, 304 на If-None-Match, `Content-Disposition` (базовое имя без последнего расширения + расширение отдаваемого MIME, решение 8), `Cache-Control` private/public; любой `exp`/`sig` в запросе — режим подписи; кривой (`exp` не `^[1-9]\d{0,11}$`, `sig` не 64 hex нижнего регистра, только один из двух) → 403 (решение 9, P17); `variant` не подписывается. Аватар через `/public/files` → 404.
- boto3 ≥ 1.36 с MinIO: `request_checksum_calculation='when_required'`, `response_checksum_validation='when_required'` (аналог P4 — иначе DeleteObjects без Content-MD5 падает).
- createTelegramCode: `tgcode:*` + `tgcode-user:*`, `botUsername` из `TELEGRAM_BOT_USERNAME`; без токена — 503 EXTERNAL_UNAVAILABLE (P14).
- Смена логотипа/имени организации сбрасывает `pub:batch` всех партий, где она — происхождение или этап `path` (R82/R92, решение 14).
- Сортировка текстовых полей — `COLLATE "C"` (P14).

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django profile users organizations files` → FAIL.
- [ ] **Шаг 3: Реализация по Interfaces.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 3.
- [ ] **Шаг 5: Commit** `feat(django): profile, users, organizations, files`.

### Task 4: Справочники, администрирование, журнал аудита

**Operations:** listDictionary, createDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry, importDictionary, uploadProductImage, listAdminOrganizations, listAuditLog, listPublicRegions (approveOrganization и updateAdminOrganization — уже Task 2).

**Files:** Create: `agrotrace/modules/{dictionaries,admin,audit}/**`, `agrotrace/infra/{xlsx_scan,csv_read}.py`, `tests/test_{csv_import,xlsx_scan,xlsx_read,js_number,audit_diff}.py`. Modify: `tests/test_static_guards.py` (`ALLOWED` += физическое удаление справочника).

**Interfaces — Produces:** `modules.dictionaries.services.import_rows(tx, name, rows) -> ImportReport`; `infra.xlsx_scan.read_first_sheet(data: bytes) -> list[list[Cell]]` (в `Lane`, raise 415 с `reason`; `Cell = str | Invalid`, значения строятся тем же потоковым сканером, который проверяет пределы, — openpyxl для чтения импорта не используется, D-I9); `infra.csv_read.read(data: bytes) -> list[list[str]]`; `core.render.js_number_text(x: float | int) -> str`.

**tests/api — зелёные:** `admin`, `audit`, файлы задач 2–3 полностью; `dictionaries` — **ждут:** тесты с полями и регионом в использовании → Task 5.

**Unit-тесты Django:**
- `test_csv_import.py`: `;`, BOM, кавычки, кавычка внутри неквотированного поля — обычный символ, символ после закрывающей кавычки → `validation.import.format`, одиночный CR — данные, неверный UTF-8 → 400 `validation.import.format`, NUL → 415 (R58).
- `test_xlsx_scan.py`: случаи `backend-express/test/xlsx-limits.test.ts` (P23–P28): > 64 записей, раздутый размер, CRC, `r="0"`, префиксный `x:row` в пространстве SpreadsheetML → 415 `{allowed}`, `xm:f` игнорируется, UTF-16 → 415, лист-диаграмма первым → 415, > 20 000 строк → 415 `workbook-too-large`, ячейка > 1 000 символов → `validation.maxLength` строки, порядок стадий.
- `test_xlsx_read.py` (семантика ячеек exceljs, случаи `backend-express/test/xlsx-*.test.ts`): shared string и inline string — текст, rich text — конкатенация runs; формула — кэшированный результат `<v>` (без него — пусто); `t="n"` — `js_number_text(float(v))` (`5` → `'5'`, `1.50` → `'1.5'`); `t="b"`, `t="e"`, `t="d"` и число с форматом даты — `Invalid` (`validation.pattern` в любой колонке, решение 6 Task 4-5); хвостовые пустые ячейки отбрасываются, короткая строка дополняется пустыми, пропуски по `r` — пустые ячейки.
- `test_js_number.py`: `5` → `'5'`, `5.0` → `'5'`, `0.1` → `'0.1'`, `1e21` → `'1e+21'`, `1e-7` → `'1e-7'`, `123456789012345680000` → `'123456789012345680000'`.
- `test_audit_diff.py`: секретные поля → `"***"`; неизменённое обновление не пишет строку (решение 5 Task 4-5).

**Port notes:**
- R93/P23: advisory lock `dictionary:<name>` первым; строки справочника `FOR NO KEY UPDATE`, физическое удаление — `FOR UPDATE`; регион по ссылке `FOR KEY SHARE`, продукт/показатель/препарат — `FOR SHARE`; REFERENCE_IN_USE (R54/D29), восстановление мягко удалённого по имени, `includeDeleted` от не-ADMIN или для norms/regions → `notAllowed` даже при `false` (решение 10).
- Импорт R58/R59 и решения 6–9, 11: первая строка выигрывает, `unchanged` сравнивает десятичные числа численно, ошибки строки отсортированы по колонке; XLSX — только по контракту P23–P28 (mock-api отстаёт, integration-report п. 2), разбор и пределы в `Lane` (память ≤ 256 МБ, срок 10 с, результат ≤ 8 МиБ), без временных файлов. Значения ячеек даёт собственный потоковый сканер (тот же проход, что проверяет пределы P24–P28) с семантикой exceljs из `test_xlsx_read.py`; openpyxl с его преобразованием дат по формату, формулами вместо значений и загрузкой всей книги для импорта не применяется (D-I9) — он остаётся только для записи отчётов (Task 13).
- listAdminOrganizations — фильтры и сортировка по контракту; изменяющие операции администрирования уже в Task 2.
- Обновление имени/фото продукта сбрасывает `pub:batch` всех его партий (решение 16).
- listAuditLog: равенство `createdAt` — по `id` в обоих направлениях; INSPECTOR читает.

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django admin audit dictionaries` → FAIL.
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 4.
- [ ] **Шаг 5: Commit** `feat(django): dictionaries, admin, audit log`.

### Task 5: Поля и обработки

**Operations:** listFields, createField, getField, updateField, deleteField, listFieldTreatments, createTreatment, updateTreatment.

**Files:** Create: `agrotrace/modules/fields/**`, `agrotrace/domain/dates.py` (часть), `tests/test_{geojson,treatment_window}.py`. Modify: `tests/test_static_guards.py` (`ALLOWED` += `deleteField`).

**Interfaces — Produces:** `modules.fields.services.lock_field_for_reference(tx, field_id, org_id, *, strength: Literal['key share', 'no key update']) -> dict | None` (условие `deleted_at IS NULL` в самом запросе); `domain.dates.can_edit_treatment(created_at, now) -> bool`.

**tests/api — зелёные:** `fields`, `dictionaries` полностью.

**Unit-тесты Django:** `test_geojson.py` (незамкнутое кольцо → `errors.geometry`, прочие ошибки сохраняют путь `geometry.coordinates[0][1][0]`, решение 12 Task 4-5); `test_treatment_window.py` — все случаи `contracts/rules/vectors/treatment-edit.json` (граница 24 ч включительно).

**Port notes:**
- P57 + final m2: `deleteField` — `FOR UPDATE` (ждёт и исключает ссылки); `createBatch`/`updateTreatment` читают поле `FOR KEY SHARE … AND deleted_at IS NULL`, `createTreatment` — `FOR NO KEY UPDATE … AND deleted_at IS NULL`; после ожидания PostgreSQL перепроверяет условие, ссылка на удалённое поле не создаётся (`locks.test.ts` «createBatch ∥ deleteField» — Task 10).
- Фильтры `from`/`to` — даты UTC (R41/D31), `organizationId` только INSPECTOR/ADMIN, иначе `validation.organizationId.notAllowed` (R51).
- Окно правки 24 ч от `created_at` по часам БД (P43), чужое поле при правке → 404 даже у FARMER+INSPECTOR (решение 14).

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django fields` → FAIL.
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 5.
- [ ] **Шаг 5: Commit** `feat(django): fields and treatments`.

### Task 6: Партии, граф, QR, документы и «Меркурий»; relay, воркер, sweeper

**Operations:** createBatch, listBatches, getBatch, getBatchHistory, getBatchPath, getBatchGraph, createBatchQr, downloadBatchQr, putBatchOnSale, markBatchSold, getBatchDocuments, retryBatchVsdImport. **Events:** `vsd.import`. **Beat:** `outbox-sweeper`.

**Files:** Create: `agrotrace/modules/{batches,documents}/**`, `agrotrace/modules/lab/assign.py`, `agrotrace/domain/{rules,state_machine,decimal,strings}.py`, `agrotrace/infra/{relay,amqp,mercury,qr,pdf}.py`, `agrotrace/events/{tasks,claim}.py`, `agrotrace/events/handlers/vsd_import.py`, `agrotrace/scheduler/jobs/outbox_sweeper.py`, `tests/test_{domain_vectors,mercury,qr,celery_config,event_task,relay}.py`, `tests/test_topology_stand.py`. Modify: `agrotrace/scheduler/beat.py` (запись `outbox-sweeper`, 5 с).

**Interfaces — Consumes:** `with_tx`, `locks.lock`, `outbox.enqueue`, `audit.record`, `public.cache.drop`, `fields.lock_field_for_reference`.
**Interfaces — Produces:**
- `modules.batches.visibility.visible_batch_ids_sql(principal) -> tuple[str, list]` (S ∪ N, D14); `modules.batches.mappers.batch_view(row, principal) -> dict` (`actions` = availableActions ∩ права); `modules.batches.services.lock_visible_batch(tx, principal, id) -> dict`.
- `modules.lab.assign.assign_lab(tx, batch) -> str | None` (D18; нет ACTIVE лаборатории → `AppProblem(409, 'NO_LAB_AVAILABLE')`, откат).
- `domain.rules`: `risk_model(...)`, `batch_code(year, n)`, `available_actions(...)` — порт `packages/domain/src/rules.ts` и `state-machine.ts`.
- `infra.relay.publish(event_ids: list[str]) -> None` (confirm, затем UPDATE `published_at`); `infra.amqp.queue_ready_count() -> int | None`.
- `events.tasks.event_task(type: str, *, lane: Literal['vsd', 'default'] = 'default')` — декоратор, регистрирующий `EventTask` с claim и повторами; `events.tasks.publish_delay_copy(request) -> None` (сырой kombu, confirm, `mandatory`; raise при возврате/nack); `events.claim.claim(tx, event_id) -> bool`.
- `scheduler.jobs.outbox_sweeper.run() -> int` (5 с, `agrotrace.outbox.django`, 100 строк `FOR NO KEY UPDATE SKIP LOCKED`, ретенция R59).

**tests/api — зелёные:** `batches` (тесты с накладными — после Task 7), `documents` (тест «worker concurrency» — после Tasks 7 и 12).

**Unit-тесты Django:**
- `test_domain_vectors.py`: каждый случай `contracts/rules/vectors/{batch-code,BR-03,state-machine}.json` и `contracts/rules/state-machine.json` даёт ожидаемый результат (тот же раннер дополняется в Tasks 7–11).
- `test_mercury.py`: паузы `MERCURY_RETRY_BASE_MS` × 2ⁿ (6 обращений), `X-Mock-Fail` только для кодов из `MERCURY_FAIL_PRODUCT_CODES`, тайм-аут 10 с, выбор последнего CONFIRMED в окне harvestedAt ± 3 д.
- `test_qr.py`: PNG 1024 × 1024; PDF — одна страница A6 (105 × 148 мм) с одной этикеткой по `contracts/openapi/paths/batches.yaml` (createBatchQr/downloadBatchQr): QR, publicCode, продукт, организация; кириллица шрифтом Onest (текст извлекается из PDF). Сетка A4 3 × 8 из §8.6 ТЗ не делается: контракт и Express — A6, ruling координатора к D-I4.
- `test_celery_config.py`: очередь и exchange `no_declare`, `queue_arguments` = definitions.json, `task_default_queue='agrotrace.django.jobs'`, `task_default_exchange='agrotrace.django'` (topic), `task_create_missing_queues` False, remote control/events выключены, `task_acks_late`, `task_reject_on_worker_lost`, `worker_prefetch_multiplier` 1, `worker_detect_quorum_queues`, `DelayedDelivery` не входит в шаги потребителя, result backend отсутствует.
- `test_event_task.py` (поддельный producer): повтор 5 раз с паузами 2…32 с, затем `Reject(requeue=False)`; claim = 0 → эффектов нет; занятый `vsd.import` → `publish_delay_copy` вызывает `kombu.Producer.publish` с `exchange=''`, `routing_key='agrotrace.django.jobs.delay'`, `mandatory=True`, заголовками Celery v2 с тем же `id`/`task` и телом `[[envelope], {}, …]` (не `send_task`), затем успешный возврат; исключение publish (возврат/nack) → пауза ≈ 1 с и `Reject(requeue=True)`.
- `test_relay.py`: откаченная транзакция не публикует ничего; после commit — `send_task` с `exchange='agrotrace.django'`, `routing_key` = type, `task_id` = id, затем `published_at`; ошибка confirm оставляет строку sweeper.

**Port notes:**
- createBatch: коды AT-YYYY-NNNNNN, BR-03 через `domain`, D18/R42, LAB_ASSIGNED — строка outbox `notification.dispatch` (получатели `orgIds [lab, origin]`, решение 10 Task 6-7); `harvestedAt` сравнивается с `now()` транзакции (final M3); поле — `lock_field_for_reference(..., 'key share')`.
- Видимость D14, граф depth 1..5 с `accessible:false` (D16) и пропуском мягко удалённых (решение 5), путь от harvestedAt/producedAt (R45), фильтры `origin`/`orgId` (R49/R51), равенства в пути — по номеру накладной (C), история — по id вставки; обход графа — сырой SQL рекурсивного CTE (§7.6).
- QR R43/R44: PNG 1024 px и PDF-этикетка A6 (контракт, D-I4); хранится в MinIO, `GET` до генерации → 404, повтор заменяет; on-sale только из Accepted у RETAILER (R20); If-Match — compare-and-set под блокировкой (`VERSION_CONFLICT` с `currentVersion`), ключи ошибок If-Match (решение 1 Task 6-7).
- Документы R81/R91/R90: DAIRY/MEAT → строка `batch_documents` PENDING + `vsd.import` в той же транзакции; `labProtocols`/`qr` только видимые вызывающему; retry только из NOT_FOUND/FAILED (иначе 409), `x-idempotent` (идемпотентность — Task 7, здесь достаточно проверки ключа); промежуточные попытки не аудируются (решение 6).
- Воркер P35: `MERCURY_*` читаются при старте; `./at api:test` перезапускает `worker-django` с переопределениями. Обработчик `vsd.import` — `claim` первым (final M6), строка VSD `FOR NO KEY UPDATE`.
- `pub:batch` сбрасывается после commit каждой операцией, меняющей статус/держателя/анализы/путь (R82), до ответа (`Tx.on_commit`).
- Relay — только после commit; ids откаченной попытки не называют строк. Sweeper — в beat (решение плана); пока нет Task 12, публикуются все типы событий (у Express ограничение `RELAYED_TYPES` было временным).
- Стенд-проверка топологии: после старта `worker-django` список exchanges/queues брокера (API управления RabbitMQ `:15672`, учётка из `RABBITMQ_URL`) не содержит `celery*`, `*.pidbox`, `celeryev*`, `celery_delayed_*`; копия занятого `vsd.import`, опубликованная `publish_delay_copy`, видна в `agrotrace.django.jobs.delay` (`messages` = 1 через API управления), не появляется в `agrotrace.django.jobs` раньше 4 с и возвращается туда примерно через 5 с (D-I6) — тест `tests/test_topology_stand.py` с маркером `stand` (запускается `./at.sh django:test -m stand` при поднятом стенде; копию публикует сам тест с уникальным id события, которого нет в `outbox_events`, и снимает её claim-проверкой воркера).

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django batches documents` → FAIL.
- [ ] **Шаг 3: Реализация по Interfaces.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; `./at.sh django:test -m stand`; регрессия задачи 6.
- [ ] **Шаг 5: Commit** `feat(django): batches, graph, qr, documents, relay and worker`.

### Task 7: Накладные и идемпотентность

**Operations:** createWaybill, getWaybill, listWaybills, sendWaybill, acceptWaybill, rejectWaybill, deleteWaybill. **Cross-cutting:** `core.idempotency`, `core.if_match`.

**Files:** Create: `agrotrace/modules/waybills/**`, `agrotrace/core/idempotency.py`, `agrotrace/domain/idempotency.py`, `tests/test_idempotency.py`. Modify: `tests/test_domain_vectors.py` (+ BR-01, BR-06, BR-07, BR-11, `waybill-state-machine.json`).

**Interfaces — Produces:** `core.idempotency.fingerprint(method: str, path: str, raw: bytes) -> str`; `IdemStore` (`claim`, `get`, `complete`, `release` — Lua-скрипты `OWN_PENDING`/`COMPLETE_LUA`/`RELEASE_LUA` текстуально как в `backend-express/src/http/idempotency.ts`); `ContractView` с `x-idempotent` — урегулирование записи до отправки ответа (`finalize_response`).

**tests/api — зелёные:** `waybills` (тест R50c с внеплановым анализом — после Task 9), `batches` полностью.

**Unit-тесты Django:** `test_idempotency.py` — отпечаток `"POST /api/v1/waybills\n" + b'{"a":1}'` равен закреплённому значению Express; запись `done`, сделанная в формате Express (`{"fingerprint","state":"done","status","body"}`), воспроизводится с `Idempotent-Replayed: true` и телом как JSON; `complete`/`release` не трогают чужую или завершённую запись; 4xx/5xx владельца освобождает ключ; ключ с хвостовым `\n` → INVALID_IDEMPOTENCY_KEY. Векторы BR-01 (R21: равенство `until` — наименьшее имя по кодовым точкам), BR-06, BR-07 (R22 `DECLARED_ZERO`), BR-11.

**Port notes:**
- Протокол R48/R53: `SET NX EX 60` pending, done 86400; pending → 409 IDEMPOTENCY_KEY_IN_PROGRESS + `Retry-After: 1`; другой отпечаток → REUSED; разрыв клиента ничего не урегулирует — владелец доводит и урегулирует сам (T6-7 I1); истечение pending до 2xx → результат не сохраняется (возможен дубль DRAFT, R53). Путь в отпечатке — без query, как получен (`raw_path`).
- Порядок send D6, BR-01 422 `{publicCode, until, substance}`; accept: BR-07 акт при > 2%, смена держателя, гонка с отзывом — отзыв всегда выигрывает, accept → 422 BR-06 `{publicCode, status: Recalled}` (P39, проверка в Task 10); reject → Approved и переназначение задачи отзыва отправителю (R50c).
- Повторы позиций — только на шаге контракта (P36): createWaybill шаг 2 `items[i].batchId validation.duplicate`, acceptWaybill шаг 6 `items validation.items.mismatch`; из ошибок схемы они удаляются.
- Блокировки: waybill → batches `ORDER BY id`; гонка двух send с общей партией → ровно один 200.
- acceptWaybill уведомлений не шлёт (решение 7 Task 6-7).

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django waybills` → FAIL.
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 7.
- [ ] **Шаг 5: Commit** `feat(django): waybills, idempotency, locking`.

### Task 8: Переработка

**Operations:** processBatches.

**Files:** Create: `agrotrace/modules/processing/**`. Modify: `tests/test_domain_vectors.py` (+ BR-04, BR-05), `agrotrace/domain/decimal.py`.

**Interfaces — Produces:** `domain.decimal.kg_to_grams(s: str) -> int`, `grams_to_kg(g: int) -> str`, `mass_total(g: int) -> str` (R26, R50 `MassTotal`).

**tests/api — зелёные:** `processing`.

**Unit-тесты Django:** векторы BR-04 (R23: оба списка пусты → NO_INPUTS; `lossNormPercent` `^\d{1,3}(\.\d{1,2})?$`), BR-05; `kg_to_grams('123456789.123')`, > 9 целых цифр → `ValueError`.

**Port notes:**
- BR-04 `params {inputKg, allowedKg, outputKg}` — строки как в домене (MassTotal для сумм), BR-05 по `canUseAsInput` (Approved|Accepted, R20), BR-06, NOT_HOLDER; входы → Processed, связи графа (D20), производные Approved (D19); аудит выхода с `parents [{batchId, massUsedKg}]` (решение 10 Task 8-9).
- Гонка processing ∥ send: ровно один успех; проигравший — 409 INVALID_TRANSITION или 422 BR-05 `{status: InTransit}` (решение 1 Task 8-9); 409 повтора взаимоблокировки — только unit (P55).
- Масса только из `Decimal`/целых граммов, никогда `float`.

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django processing` → FAIL.
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 8.
- [ ] **Шаг 5: Commit** `feat(django): processing`.

### Task 9: Лаборатория, ядро движка отзыва, эскалация

**Operations:** listLabTests, createLabTest, getLabTest, registerLabSample, submitLabResults, uploadLabProtocol, downloadLabProtocol. **Beat:** `lab-escalation`. **Ядро отзыва** (P2): синхронные шаги 1–7 для FAIL.

**Files:** Create: `agrotrace/modules/lab/**`, `agrotrace/modules/recalls/engine.py`, `agrotrace/scheduler/jobs/lab_escalation.py`, `tests/test_{working_days,recall_due,beat_schedule}.py`. Modify: `agrotrace/domain/dates.py`, `tests/test_domain_vectors.py` (+ BR-02, BR-08), `agrotrace/scheduler/beat.py`.

**Interfaces — Produces:**
- `domain.dates.add_working_days(start: datetime, n: int) -> datetime` (R24, UTC), `recall_task_due_at(opened_at: datetime) -> datetime` (BR-08).
- `modules.recalls.engine.start_recall(tx: Tx, *, source_batch_id: str, trigger: str, opened_by: str | None, block_upstream: bool, action: str) -> RecallOutcome(recall_id: str, created: bool, closed: bool, changed_codes: list[str], task_ids: list[str], event_ids: list[str])` — вызывается только внутри `with_tx(..., **RECALL_TX)` (REPEATABLE READ + один повтор при 23505 `ux_recalls_open_source`, D-I3) — так оборачиваются submitLabResults (FAIL), а в Tasks 10–11 createRecall и decideComplaint(RECALL); повторный запуск при OPEN по источнику → существующий отзыв. Гонка двух FAIL по одной партии (`lab.test.ts` ≈ строка 904) → оба 200 с одним `recallId`.
- `scheduler.beat` — записи `lab-escalation` с интервалом `SCHEDULER_TICK_MS`, запуск сразу при старте.

**tests/api — зелёные:** `lab`, `waybills` полностью; прогон `--tz Europe/Moscow` по файлам задач 1–9.

**Unit-тесты Django:**
- `test_working_days.py`: каждый случай `contracts/rules/vectors/working-days.json` (отложенный M2 Task 8-9 Express), в том числе при `TZ=Europe/Moscow` процесса (`monkeypatch.setenv('TZ')` + `time.tzset()`).
- `test_recall_due.py`: каждый случай `contracts/rules/vectors/BR-08.json` (правило срока задачи отзыва).
- `test_beat_schedule.py`: `SCHEDULER_TICK_MS=1000` → интервал 1 с; каждое задание выполняется при старте; `apply_async` записи не публикует в брокер (поддельный producer не вызван).
- Векторы BR-02 (строгое `>`).

**Port notes:**
- Ровный набор показателей (D4), снимок норматива, PASS → Approved, FAIL → Blocked + движок отзыва в той же транзакции; `recallId` в ответе и в `lab_tests.recall_id` (R57/R60); `rating.recalculate` для FARM-происхождения; `pub:batch` после каждого результата (решение 4 Task 8-9); нормативы читаются без блокировки в снимке RR (решение 7).
- LAB видит только свою лабораторию, участник — через видимость партии, вычисленную без LAB (решение 5); фильтр `batchId` для участников (T9 note a); тесты удалённых партий невидимы (решение 6); registerLabSample без тела = `{}` (решение 9); аудит движка — `action` вызывающей операции (решение 8).
- Протокол PDF ≤ 10 МБ, сигнатура PDF, замена; файлы через Task 3.
- Эскалация через 5 рабочих дней: тест переносит `lab_tests.due_at` записью стенда (P48) и ждёт тика 1 с; сравнение «now() > срок» только по часам БД.
- Beat: advisory lock — сессионный на пуловом соединении; разблокировка в `finally` до возврата соединения, иначе блокировка уходит в пул вместе с ним.
- R89: отзыв без задач (закрыт при создании) не рассылает OPENED; `recall.requested` пишется и для него (решение 3 Task 8-9).

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django lab` → FAIL.
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 9; `./at.sh api:test django --reset --tz Europe/Moscow <файлы задач 1–9>`.
- [ ] **Шаг 5: Commit** `feat(django): lab tests, recall engine core, escalation`.

### Task 10: Отзывы, задачи изъятия, рейтинг

**Operations:** createRecall, listRecalls, getRecall, getRecallGraph, listRecallTasks, confirmRecallTask. **Beat:** `recall-task-overdue`. **Events:** `recall.requested`, `rating.recalculate`.

**Files:** Create: `agrotrace/modules/{recalls,rating}/**` (кроме engine), `agrotrace/modules/notifications/dispatch.py`, `agrotrace/events/handlers/{recall_requested,rating_recalculate}.py`, `agrotrace/scheduler/jobs/recall_task_overdue.py`, `tests/test_{rating_fold,recall_graph_sql}.py`. Modify: `tests/test_domain_vectors.py` (+ BR-08-overdue, BR-09, BR-10, `trust-rating.json`), `tests/test_static_guards.py`, `agrotrace/scheduler/beat.py` (запись `recall-task-overdue`).

**Interfaces — Produces:**
- `modules.notifications.dispatch.insert_notifications(tx, *, notification_type: str, recipients: dict, payload: dict) -> list[str]` (PENDING ids EMAIL/TELEGRAM; IN_APP — DELIVERED; NOTIFY для IN_APP делает триггер таблицы `notifications` (`db/schema.sql`), явного `pg_notify` здесь нет — иначе хабы всех реализаций получают дубль с другим payload, D-M1).
- `modules.rating.services.recalculate(tx, org_id) -> tuple[int | None, int | None, bool]` (FARM, `FOR NO KEY UPDATE`, аудит `system.ratingRecalculate`), `fold(tx, org_id) -> int`.

**tests/api — зелёные:** `recalls`, `locks`.

**Unit-тесты Django:** векторы BR-08-overdue, BR-09 (свёртка: время ↑, лаборатория раньше отзыва, id по C), BR-10; `test_recall_graph_sql.py` (БД `agrotrace_test_django`, свой граф): обход вниз и вверх с `blockUpstream`, транзит через мягко удалённые без смены их статуса и без задач (R59), глубина ≤ 20; `test_static_guards.py` — список `ALLOWED` ровно 2 места `FOR UPDATE`.

**Port notes:**
- Шаги 1–7 тега Recalls, статусы по примечанию §5.1, задачи держателям и получателям InTransit (T9 note c), мгновенное закрытие без задач BR-10 + CLOSED (R59), без OPENED (R89); RR (R54/D7), createRecall — в `with_tx(..., **RECALL_TX)` (один повтор при 23505 `ux_recalls_open_source`: параллельные createRecall по одному источнику → оба 200 с одним отзывом, D-I3); гонка accept ∥ recall — отзыв выигрывает (P39).
- P43: `createdAt` задач = `openedAt`, `closedAt` = `confirmedAt` закрывающей задачи — один `Tx.now`.
- P57 / `locks.test.ts`: confirmRecallTask (отзыв → партия → задача, все `FOR NO KEY UPDATE`) и submitLabResults(FAIL с присоединением к OPEN-отзыву) идут без взаимоблокировки; «createBatch ∥ deleteField» — 204 и 400.
- Задачи мягко удалённых отзывов скрыты и не подтверждаются (404), overdue-задание их не фильтрует (решение 8 Task 10-11).
- Рейтинг — eventually consistent через `rating.recalculate`; тесты ждут с дедлайном (`ratingsSettled` читает claims `processed_events` этого backend).
- Overdue: OVERDUE + эскалация + `notification.dispatch` `{orgIds:[holder], roles:[INSPECTOR]}` с полями payload Task 10-11 «Interfaces»; повторно не эскалирует.
- `recall.requested` формирует RECALL OPENED и RECALL_TASK CREATED (IN_APP DELIVERED, EMAIL/TELEGRAM PENDING — доставка в Task 12).

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django recalls locks` → FAIL.
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 10; журнал postgres без `deadlock detected` за прогон (`docker compose logs --since 30m postgres | grep -c deadlock` = 0).
- [ ] **Шаг 5: Commit** `feat(django): recall engine, tasks, rating`.

### Task 11: Жалобы и публичная часть

**Operations:** listComplaints, getComplaint, startComplaintReview, decideComplaint, getPublicBatch, createPublicComplaint, getCaptchaChallenge.

**Files:** Create: `agrotrace/modules/{complaints,public}/**` (кроме cache), `agrotrace/infra/altcha.py`, `tests/test_altcha.py`. Modify: `tests/test_domain_vectors.py` (+ `entity-state-machines.json`).

**Interfaces — Produces:** `infra.altcha.key(jwt_secret) -> str` (hex-строка как ключ UTF-8), `challenge(now_ms) -> dict`, `verify(payload_b64: str, now_ms: int) -> str | None` (signature решения).

**tests/api — зелёные:** `complaints`, `public`; `[ratelimit]` complaint-ip — в `--ratelimits`.

**Unit-тесты Django:** `test_altcha.py` — ключ из `contracts/rules/altcha.json` равен `key`, `challenge`/`signature` совпадают, каждый случай `cases` даёт `valid` при `nowMs`; base64 стандартный с паддингом.

**Port notes:**
- ALTCHA реализуется на `hashlib`/`hmac`, а не библиотекой `altcha` из таблицы §8.7: контракт (P40) фиксирует рецепт v1 и общий вектор, библиотека допустима, только если проходит `altcha.json` побайтово.
- ALTCHA P40: ключ = hex(HMAC-SHA256(JWT_SECRET, "agrotrace:altcha:v1")) **как UTF-8-строка** (в отличие от ключа ссылок файлов — сырые байты), maxnumber 100 000, TTL 600; `altcha-used:{signature}` `SET NX EX 600` после проверки решения и партии.
- createPublicComplaint (решение 4 Task 10-11): лимит → один 400 (шаблон publicCode + тело, P42/P36) → CAPTCHA_FAILED → 404 (решение не израсходовано) → `SET NX`; уведомление COMPLAINT инспекторам; `complaint-ip` 10/ч (P41: стенд снимает лимит, тест с 11 запросами проверяет, что ручка соблюдается).
- decideComplaint без `decision` → `validation.required` (P19/P42/P44); LAB_TEST создаёт анализ (`labOrgId`, LAB_ASSIGNED reason COMPLAINT), RECALL запускает/переиспользует отзыв (R54/D15) в `with_tx(..., **RECALL_TX)` (D-I3).
- `pub:batch` (R82/R92): при промахе — `SET … EX 300`, затем перечитать `version` партии и `DEL` при изменении; при попадании — сохранённые байты как есть (`HttpResponse(bytes)`, без разбора); страница без персональных данных; фото продуктов — `files` из сида без изменений (P32).

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django complaints public` → FAIL.
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 11; `./at.sh api:test django --ratelimits`.
- [ ] **Шаг 5: Commit** `feat(django): complaints and public pages`.

### Task 12: Уведомления, доставка, Telegram, SSE

**Operations:** listNotifications, markNotificationsRead, streamEvents. **Events:** `notification.dispatch`, `lab.escalate` (+ доставка PENDING из `recall.requested`). **Beat:** `notification-delivery`.

**Files:** Create: `agrotrace/modules/notifications/{views,services,delivery,serializers,urls}.py`, `agrotrace/events/handlers/{notification_dispatch,lab_escalate}.py`, `agrotrace/infra/telegram.py`, `agrotrace/scheduler/jobs/notification_delivery.py`, `agrotrace/sse/{hub,stream,dbpool}.py`, `tests/test_{delivery,telegram_poller,sse_hub,i18n_notifications}.py`. Modify: `agrotrace/infra/i18n.py`, `agrotrace/asgi.py`, `agrotrace/scheduler/beat.py` (запись `notification-delivery`).

**Interfaces — Produces:**
- `modules.notifications.delivery.deliver(ids: list[str], *, mode: Literal['fresh', 'stale']) -> None` (в воркере, `mode='fresh'` — пул процесса из 2 потоков отправки; в beat, `mode='stale'` — синхронно в потоке задания на его соединении, без своих потоков; захват на каждую отправку; соединение берётся только на захват/запись и отпускается на время SMTP/Telegram — бюджет D-I5).
- `sse.hub.Hub` (`start()`, `close()`, `register(stream)`, `resync()`); `sse.stream.stream_events(request)` — async-представление.
- `infra.telegram.Telegram(token)`: `send_message(chat_id, text)`, `get_updates(offset)`; `start_poller()` — поток в воркере (`worker_ready`/`worker_shutdown`).
- `infra.i18n.notification_message(type: str, payload: dict, part: Literal['title', 'body', 'email.subject', 'email.body', 'telegram']) -> str` — порт `packages/i18n/src/notification.ts` (+ `formatDateTime`, плюралы ru).

**tests/api — зелёные:** `notifications`, `events`, `documents` полностью.

**Unit-тесты Django:**
- `test_delivery.py`: 3 попытки с паузами 1 и 2 с (P45); попытка, которая не завершается, — неудача через 30 с (`EMAIL_TIMEOUT` и общий срок попытки); захват — `UPDATE … SET claimed_at = now() … RETURNING claimed_at::text`, продление и запись `attempts` с условием `claimed_at = %s::timestamptz` по этому тексту (микросекунды) и `delivery_status='PENDING'`; потеря захвата на попытке 2 → отправка прекращена, ничего не записано; без токена Telegram → NOT_CONFIGURED, 0 попыток; без привязки — FAILED, 0 попыток; без `SMTP_HOST` — EMAIL NOT_CONFIGURED.
- `test_telegram_poller.py`: `SET NX EX 30`, продление каждые 10 с Lua compare-and-PEXPIRE из таблицы контракта; 0 → опрос прекращён; `offset` сдвигается только после обработки; `/start <code>` → `GETDEL tgcode:{code}`.
- `test_sse_hub.py`: водяной знак W = max(L, наибольший seq пользователя) при подключении; после потери LISTEN — только seq > W плюс непрочитанные seq < W, созданные ≤ 60 с до потери (T3-5 note, P46); поток, подключавшийся во время resync, догоняет сам (N1); дедупликация по id в потоке; `reauth` в `exp`; `ping` с `ts` без миллисекунд; `Last-Event-ID` важнее `lastEventId`, нечисловой или > 18 цифр игнорируется; буфер > 1 МиБ завершает поток.
- `test_i18n_notifications.py`: для каждого типа `contracts/rules/notifications.json` `title`/`email.subject`/`telegram` совпадают с выводом `@agrotrace/i18n` (литералы, снятые с Express).

**Port notes:**
- Воркер: `notification.dispatch` = claim + `insert_notifications`; `lab.escalate` → LAB_OVERDUE (orgHeadIds [lab], roles [INSPECTOR], payload + labName); отправка EMAIL/TELEGRAM — после commit, отдельно от ack (решение 6 Task 12-13), остановка воркера ждёт завершения отправок.
- P49 + I2-R/N5: захват на каждую отправку непосредственно перед первой попыткой (`fresh`: `claimed_at IS NULL OR claimed_at < now() − 5 мин`; `stale` в задании: `coalesce(claimed_at, created_at) < now() − 5 мин`); слоты процесса — захват берётся внутри слота; штамп никогда не проходит через `datetime` (Eloquent-пример контракта относится и к ORM Django). `EMAIL_TIMEOUT = 10`, срок попытки 30 с — `Future.result(timeout=30)`.
- Telegram-токен только у api (P14/P51): тест P51 пишет `users.telegram_chat_id` фикстурой и ждёт NOT_CONFIGURED.
- markNotificationsRead: `ids` (каждый — свой IN_APP, иначе `ids[i] validation.notFound`, ничего не отмечено) или `upToSeq`; `pg_notify(… {"user_id","unread":true})` в той же транзакции — единственный явный NOTIFY в коде (IN_APP-строки оповещает триггер, D-M1); аудита нет (решение 10).
- SSE (R33, contract `paths/events.yaml`): 401 problem при неверном `access_token` (заголовок Authorization игнорируется) → лимит `user` → заголовки (`text/event-stream`, без буферизации) → регистрация (живые события буферизуются) → replay (`seq > L` + окно 60 с) → сброс буфера → `unread`. Формат событий — только `id:`/`event:`/`data:` (никаких `retry:` и комментариев перед первым событием). Разрыв клиента — `asyncio.CancelledError` в генераторе снимает поток.
- LISTEN: отдельное `psycopg.AsyncConnection` (autocommit, keepalive TCP), на нём выполняется только `LISTEN notifications` — в том числе проба каждые 30 с с тайм-аутом 10 с; уведомления читаются циклом `conn.notifies(timeout=…)` (psycopg 3.2) с выходом не реже раза в 30 с, потому что открытый генератор `notifies()` держит блокировку соединения и проба иначе не выполнится (D-M4), чтобы `pg_stat_activity.query` всегда был `LISTEN notifications` (правило контракта для портов); переподключение с back-off и `resync()` всех потоков. Чтения хаба и потоков — асинхронный пул (2).
- Повторная публикация события (`published_at = NULL` + удаление claim — фикстура P48) не дублирует уведомление (`processed_events`).
- Стенд-тест топологии Task 6 повторяется с поднятым воркером после этой задачи (`./at.sh django:test -m stand`).

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django notifications events documents` → FAIL.
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; `./at.sh django:test -m stand`; регрессия задачи 12 дважды подряд.
- [ ] **Шаг 5: Commit** `feat(django): notifications, delivery, telegram, sse`.

### Task 13: Аналитика и отчёты

**Operations:** getDashboard, downloadReport.

**Files:** Create: `agrotrace/modules/{analytics,reports}/**`, `agrotrace/infra/xlsx_write.py`, `tests/test_{analytics_window,report_sheets,report_lane}.py`. Modify: `agrotrace/infra/pdf.py`.

**Interfaces — Produces:** `modules.reports.render.render(spec: ReportSpec, fmt: Literal['xlsx', 'pdf']) -> bytes` (выполняется в `Lane('report', render, waiting=4, deadline_s=120, memory_mb=1024)`); `modules.analytics.window.resolve(params, snapshot_now) -> tuple[date, date]`.

**tests/api — зелёные:** `analytics`, `reports`.

**Unit-тесты Django:**
- `test_analytics_window.py`: по умолчанию 30 дней до даты снимка (UTC); одна граница → другая в 29 днях; > 366 дней → `range.tooLong`; ошибки scope и окна в одном 400.
- `test_report_sheets.py`: листы, колонки, порядок и типы ячеек каждого из шести отчётов по описанию контракта (числовые форматы `0`/`0.000`/`0.00`, моменты `YYYY-MM-DD HH:MM` UTC усечением, нет колонки контакта в отчёте жалоб); `REPORT_MAX_ROWS=13`: 13 строк → файл, 14 → `validation.report.tooManyRows`.
- `test_report_lane.py`: полная очередь (1 + 4) → 503 `{reason: "report-busy"}` до чтения данных (N3); превышение 120 с → 503; ушедший клиент (`client_gone()`, D-I7) освобождает место в ожидании.

**Port notes:**
- Все числа дашборда — из одного снимка `READ ONLY REPEATABLE READ`, «сейчас» = `now()` снимка (P43); доли — `ratioPercent2`, порядок rejectedShare по округлённой доле (решение 8 Task 12-13), часы — целые секунды `floor(extract(epoch))`; задачи удалённых отзывов/партий и анализы удалённых партий исключены.
- downloadReport: тип (400) → доступ `x-report-access` (403 без params) → параметры одним 400 → 404 → проверка очереди (503 report-busy) → снимок → листы; каждая выборка читает `REPORT_MAX_ROWS + 1` строк; `Content-Disposition` обеих форм, `Cache-Control: no-store`.
- Рендер вне потока запроса (P52): openpyxl и WeasyPrint держат GIL, поэтому `Lane` — дочерний процесс, не поток; «Поле | Значение» — числа как числа (решение 8).
- PDF: A4 альбомная, шрифт Onest (кириллица), заголовок таблицы на каждой странице.

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django analytics reports` → FAIL.
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; регрессия задачи 13.
- [ ] **Шаг 5: Commit** `feat(django): dashboards and reports`.

### Task 14: Матрица прав, покрытие контракта, метрики, кросс-тесты, CI

**Files:** Create: `agrotrace/core/metrics.py`, `tests/test_{metrics,schema_parity,logging}.py`. Modify (только секции SP3 django, отдельный коммит `chore(stand)`): `.github/workflows/ci.yml` (job `api-django`), `at.sh` (`test:all`: `cross:test express django`). `tests/cross/**` не меняется: `interop.test.ts` уже на `main` (SP5).

**Interfaces — Produces:** `core.metrics.route_label(path: str) -> str` (шаблон контракта без `/api/v1`, литеральные сегменты важнее параметров, иначе `unmatched`); `start_metrics_server(port: int)`.

**tests/api — зелёные:** `permissions`, `metrics`, `contract-coverage` — полный прогон: `./at.sh api:test django --reset` (coverage `operations 92/92`, 0 gaps), второй полный прогон подряд, `--tz Europe/Moscow`, `--ratelimits`.

**Unit-тесты Django:**
- `test_metrics.py`: `route_label('/api/v1/dictionaries/products/0b1c…/image')` = `/dictionaries/products/{id}/image`; путь вне контракта → `unmatched`; метод `PROPFIND` → `other`; разрыв клиента до ответа → `status="499"`; 5xx увеличивает `http_request_errors_total`; нечитаемый gauge → `NaN`; у каждой серии четырёх обязательных семейств метка `backend="django"`.
- `test_schema_parity.py`: множество `(path, method, operationId)` схемы drf-spectacular (`SpectacularAPIView` генерация в памяти) равно множеству бандла контракта (§8.3/§14.1 «сравнение сгенерированных схем»); полная схема не сравнивается — источником истины остаётся бандл, который отдаёт `/docs`.
- `test_logging.py`: строка журнала — JSON с `backend: "django"` и `requestId`; в обработчике события — `requestId` конверта; `password`, `token`, `refresh`, `secret`, `totp` на любой глубине замаскированы (P8).

**Port notes:**
- Метрики P54: отдельный сервер `prometheus_client` на `METRICS_PORT` (9464) в процессе api (один процесс — мультипроцессный режим не нужен); `/api/v1/metrics` и `:8000/metrics` → 404 problem; обязательные семейства `http_request_duration_seconds` (метки `method`, `route`, `status`), `http_request_errors_total`, `queue_messages{queue="agrotrace.django.jobs"}` (ready-сообщения пассивным `queue_declare` при опросе, тайм-аут 2 с), `recalls_open` (SQL при опросе). django-prometheus из таблицы §8.7 не используется: его имена и метки не совпадают с обязательными рядами контракта (P54 сильнее таблицы ТЗ).
- Матрица прав генерируется из контракта; её находки — дефекты Django, не теста; 409 повтора взаимоблокировки остаются в allowlist (P55).
- tests/cross: весь набор с `main` (SP5: сессия, вход по Argon2 через другую реализацию, подписанная ссылка и ETag, повтор `Idempotency-Key`, IN_APP через SSE) должен быть зелёным в обе стороны; падение сценария — дефект Django, а дефект самого сценария идёт по каналу SP7(d).
- CI job `api-django` (в секции SP3 django файла ci.yml): `install` → `up infra` → `reset` (SEED_NOW фиксирован) → `django:test` → `up django` → `api:test django` → `api:test django --reset --tz Europe/Moscow` → `api:test django --ratelimits` → `cross:test express django` → `cross:test django express` → `docs:test django` → журналы трёх процессов при сбое.

- [ ] **Шаг 1: unit-тесты RED.**
- [ ] **Шаг 2: RED по HTTP:** `./at.sh api:test django permissions metrics` → FAIL; `./at.sh cross:test express django` — красные сценарии записать (ожидаются только из-за метрик/прав, остальное должно уже проходить).
- [ ] **Шаг 3: Реализация метрик, журналов, проверки схемы; CI и test:all в секциях django (коммит `chore(stand): ci job api-django, test:all cross pair`).**
- [ ] **Шаг 4: GREEN:** `./at.sh django:test`; `./at.sh api:test django --reset` дважды подряд (549 passed / 4 skipped или текущий счёт набора, coverage 0 gaps); `./at.sh api:test django --reset --tz Europe/Moscow`; `./at.sh api:test django --ratelimits`; `./at.sh cross:test express django`; `./at.sh cross:test django express`; `./at.sh docs:test django`; Express не сломан — `./at.sh api:test express --reset` и `./at.sh cross:test`; `./at.sh at:test`; `./at.sh lint`.
- [ ] **Шаг 5: Commit** `test(django): permission matrix, metrics, schema parity, ci`.
- [ ] **Шаг 6: Слияние с `main` (D-M12).** `git merge main` (Express, SP-правки, возможно уже слитый Laravel); конфликты в общих файлах — только в секциях SP3, оставить обе секции; затем полный повтор Шага 4 плюс `./at.sh cross:test express django`, `./at.sh at:test`, `./at.sh django:test`; коммит слияния `merge: main into feat/plan-3-django`. Слияние ветки в `main` выполняет контроллер после финального ревью.

---

## Последующие планы

Laravel (параллельный worktree, тот же паритетный набор) → фаза интеграции: слияние Django и Laravel в `main` (конфликты общих файлов — оставить оба блока), e2e-матрица 3 × 3 (`./at e2e <front> django`) с профилем P34, бэклог P37/P46/M15 (дедупликация уведомлений во фронтах). Dev-профиль с hot reload uvicorn (`WATCHFILES_FORCE_POLLING`, §14.4) и нагрузочные/ZAP-прогоны Django — План 8 «Стабилизация».
