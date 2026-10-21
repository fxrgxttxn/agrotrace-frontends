# План 5 «Laravel» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Третья backend-реализация AgroTrace на Laravel 11 (PHP 8.3, Octane на FrankenPHP), которая проходит набор `tests/api` (549 тестов, 92/92 операций) без единого изменения тестов и сценарий `tests/cross` в паре с Express в обоих направлениях.

**Architecture:** Модульный монолит `backend-laravel/` со слоями:
- Transport — `app/Http`: шлюз маршрутов по контракту, FormRequest, контроллеры, problem+json, SSE;
- Application — `app/Actions`: сценарии операций, транзакции `Tx`, политики (`app/Policies`);
- Domain — `app/Domain`: порт `@agrotrace/domain` на чистом PHP, без фреймворка;
- Infrastructure — `app/Infrastructure`, модели Eloquent без миграций (`app/Models`), сырой SQL через `DB::select` (`app/Queries`).

Один образ, три контейнера:
- `api-laravel` — Octane/FrankenPHP и процесс `agrotrace:sse-hub` (единственный сеанс LISTEN);
- `worker-laravel` — два процесса-потребителя на php-amqplib и поллер Telegram;
- `scheduler-laravel` — Laravel Scheduler.

Поведение задают контракт и правила; эталон поведения — завершённый Express (`backend-express/`, HEAD 7dd3858).

**Tech Stack:**
- Каркас и рантайм: Laravel 11, PHP 8.3, laravel/octane 2 + FrankenPHP 1.x (образ `dunglas/frankenphp`, PHP 8.3, ZTS), supervisord.
- Хранилища и транспорт: PDO pgsql (`pgsqlGetNotify`), phpredis, php-amqplib 3, aws-sdk-php через league/flysystem-aws-s3-v3.
- Безопасность: firebase/php-jwt 6, pragmarx/google2fa 8.
- Файлы и документы: intervention/image 3 (GD, WebP), endroid/qr-code, phpoffice/phpspreadsheet (только запись отчётов), dompdf, swagger-ui-dist (тот же, что у Express, из pnpm-lock).
- Мониторинг и логи: promphp/prometheus_client_php (APCng), Monolog JSON.
- Расширения PHP: bcmath, pcntl, apcu, zlib, dom, xmlreader, sodium, gd.
- Качество: Pest 3, Larastan, Pint.

Пакеты, названные в ТЗ, но не используемые, перечислены в решениях L1, L10 и L11.

**Spec:** `docs/tz-agrotrace-v2.md`:
- §8 целиком, особенно 8.2 (одновременная работа), 8.3, 8.4 (SSE: Octane, `response()->stream()`, `pgsqlGetNotify`) и 8.7 (колонка Laravel);
- §7.6 — обход графа сырым SQL через `DB::select`;
- §12.6 — эквивалентность реализаций;
- §14 — тестирование, CI и развёртывание: `api-laravel`, `worker-laravel`, `scheduler-laravel`, `./at up <front> laravel`.

**Contract (binding):** `contracts/openapi.yaml` + `contracts/openapi/**`, `contracts/rules/*.json` (включая `vectors/`, `altcha.json`), `contracts/events/*.schema.json`, `infra/rabbitmq/definitions.json`.

**Rulings:** `docs/superpowers/rulings.md` (R1–R93) обязательны. Обязательны и решения контроллера Плана 1 P1–P61 (`.superpowers/sdd/2026-09-25-plan-1-express/progress.md`) там, где они касаются портов. Их сводка — раздел «Реестр обязательств порта» ниже.

Порядок приоритета: пользователь → решения → ТЗ → планы. Собственные решения этого плана — L1–L15. Контроллер переносит их в журнал SDD этого плана как решения.

## Рабочее место и общий стенд

- Работа идёт в git worktree `C:/project-wt/plan-5`, ветка `feat/plan-5-laravel` от `main` (7dd3858). Worktree создаётся по навыку superpowers:using-git-worktrees: `git worktree add C:/project-wt/plan-5 -b feat/plan-5-laravel main`.
- Локальный `.env` worktree — копия `C:/project/.env`, не `.env.example`. Иначе `GATEWAY_PORT` и прочие локальные значения разойдутся, и общий стенд пересоздастся с другими портами.
- Стенд один на все worktree: проект compose `name: agrotrace`, один postgres/redis/rabbitmq/minio, контейнеры `agrotrace-*`.
  - Команды, меняющие стенд (`reset`, `seed`, `api:test`, `cross:test`, e2e против backend), сериализует host-мьютекс в `at.sh`.
  - Express-контейнеры не останавливать: `cross:test` и e2e используют их.
- Django портируется параллельно в другом worktree и правит те же общие файлы. Правки общих файлов в этом плане минимальны и только добавляют: каждая — отдельным блоком с комментарием `# --- laravel ---`, без переформатирования и переименования соседнего. Общие файлы:
  - `at.sh`;
  - `docker-compose.yml`, `docker-compose.api-test.yml`;
  - `.github/workflows/ci.yml`;
  - `tests/at/at.test.ts`;
  - `.env.example`;
  - шлюз — изменений не ожидается: `gateway/nginx.conf.template` уже проксирует `api-laravel:8000` и `/_health/laravel`;
  - `contracts/**` — одна фраза в Task 14.

  При слиянии конфликты в этих файлах разрешаются объединением блоков.
- `tests/api` и `tests/cross` не меняются. Единственное исключение — подлинный дефект теста, нейтральный к контракту (тест опирается на поведение Express, которого контракт не требует). Порядок для такого случая:
  1. Остановиться.
  2. Описать дефект в отчёте задачи с доказательством: строка теста, текст контракта, ответ Express.
  3. Дождаться решения контроллера.
  4. Исправление делается backend-нейтральным, отдельным коммитом `test(api): …`. О нём сообщают Django-потоку.

## Global Constraints

- Контракт — единственный источник истины, включая `x-roles`, `x-org-admin`, `x-access`, `x-idempotent`, `x-locks`, `x-transition`, `x-sort`, `x-rate-limit` и `x-report-access`. Порядок проверок по умолчанию (info.description): 401 → 403 по роли → `Idempotency-Key` → 400 (сначала параметры пути отдельно, затем If-Match и тело одной картой, P36) → 404 → 403 по стороне → 409 VERSION_CONFLICT → 409 INVALID_TRANSITION → 400 по ссылкам → поэлементные проверки.
- Все ответы валидируются по контракту (Ajv 2020, strict, `additionalProperties:false`). Пустой JSON-объект кодируется как `{}`, никогда как `[]` (L9, `Json`). Числа и массы — по схемам: массы строкой с 3 знаками, `MassTotal` до 15 цифр.
- Ошибки — RFC 7807 `application/problem+json`: `type = /problems/<kebab(code)>`, `status` тела = HTTP-статус, `code` из `ProblemCode`; `errors` с путями `items[0].field` и ключом `_root` (P7, P16, P19, P44). Стандартный вывод Laravel (HTML, `message`/`errors` валидатора, трассы) заменён полностью; неизвестное исключение — 500 INTERNAL без деталей.
- Время (P43, P38):
  - каждое «текущее время», которое записывает операция, — `now()` её транзакции (`Tx::now()` или `now()` в SQL);
  - часы PHP не пишутся в БД никогда, кроме `occurredAt` конверта (R59 — время вставки outbox);
  - сеанс PG: `TimeZone=UTC`, `app.timezone=UTC`, `date.timezone=UTC`;
  - вывод `DateTime` — `YYYY-MM-DDTHH:MM:SS.mmmZ`, как у Express;
  - микросекунды PG никогда не проходят через datetime-касты Eloquent (L9).
- Блокировки (R47, R52, P57, P12, P23):
  - уровень READ COMMITTED;
  - порядок: advisory `refresh:`/`dictionary:` → waybill → recall → labTest → complaint → organization → batches (одним `SELECT … FOR NO KEY UPDATE … ORDER BY id`) → recallTasks (`ORDER BY id`) → прочее;
  - If-Match сравнивается как compare-and-set по заблокированной строке;
  - 40P01/40001 — один повтор всей транзакции, затем 409 VERSION_CONFLICT (`currentVersion`);
  - движок отзыва работает в REPEATABLE READ с повтором по `23505 ux_recalls_open_source`;
  - явные блокировки — `FOR NO KEY UPDATE`; `FOR UPDATE` разрешён только для физического удаления строки справочника и в `deleteField`; задания и sweeper — `FOR NO KEY UPDATE SKIP LOCKED`;
  - `lockForUpdate()` Eloquent запрещён (статический тест, Task 14).
- Бюджет соединений PostgreSQL (P61, L4) — не больше 20 на реализацию:

  | Процесс | Соединений |
  |---|---|
  | api: `DB_SLOTS` | 12 |
  | api: sse-hub (LISTEN) | 1 |
  | worker: 2 потребителя + поллер Telegram | 3 |
  | scheduler (смена минутных процессов `schedule:run`) | ≤ 2 |
  | **Итого** | **18** |

  - Каждое соединение задаёт `statement_timeout=30s`, `lock_timeout=10s`, `connect_timeout=5`.
  - Нет слота или соединения за 5 с, 57014 или 55P03 → 503 BACKEND_UNAVAILABLE.
  - `max_connections` стенда не меняется.
- Идемпотентность (R48, R53):
  - ключ `idem:{userId}:{key}`;
  - отпечаток — sha256 hex от `"{METHOD} {path}\n"` + сырые байты тела, где path — путь запроса с `/api/v1` без query;
  - запись `{"fingerprint","state":"pending"}` с `SET NX EX 60`; `done` с `{status, body}` на 86400 с;
  - Lua-скрипты compare-and-set / compare-and-delete — дословно тексты Express (`backend-express/src/http/idempotency.ts`), поэтому ключ Express и ключ Laravel взаимозаменяемы;
  - владелец решает судьбу ключа до отправки ответа; разрыв клиента ничего не решает.
- Лимиты (R30, P10, P41):
  - ключи `rl:{scope}:{subject}:{windowStartEpochSec}`, `INCR` + `EXPIRE … NX` в одном MULTI — общие с Express и Django;
  - `RATE_LIMIT_OVERRIDES` — JSON; неверное значение → выход с кодом 78;
  - профиль api-test задаёт `user`, `login-ip` и `complaint-ip` = 100000.
- IP клиента (P9): последний элемент `X-Forwarded-For`; без заголовка — адрес сокета; `::ffff:a.b.c.d` → IPv4. Middleware `TrustProxies` Laravel не используется.
- События (R55, R56, R92, P56, L1):
  - строка `outbox_events(backend='laravel')` пишется в той же транзакции;
  - тело AMQP-сообщения = документ конверта (как у Express), persistent, `content_type application/json`, `message_id = id`;
  - exchange `agrotrace.laravel`, routing key = `type`; очереди `agrotrace.laravel.jobs`, `.dlq`, `.delay` — только из `definitions.json`, других имён нет;
  - обработчик — одна транзакция, начинающаяся с `INSERT INTO processed_events … ON CONFLICT DO NOTHING`;
  - повторы обработчика внутри процесса — через 2, 4, 8, 16, 32 с, затем `basic.reject` без requeue (в DLQ);
  - занятый `vsd.import` публикуется копией в `.delay` с `mandatory` и confirm, затем ack; requeue в голову очереди — никогда.
- Общие ключи Redis (R82, P9) — таблица контракта:
  - значения JSON пишутся компактно и читаются разбором;
  - `pub:batch:*` отдаётся побайтово;
  - ссылки в письмах строятся от `PUBLIC_BASE_URL`;
  - собственные каналы pub/sub этой реализации — только с префиксом `agrotrace:laravel:` (это каналы, а не ключи).
- Файлы:
  - подписанные ссылки (R28, R39, R88): ключ = HMAC-SHA256(JWT_SECRET, "agrotrace:file-url:v1"), сообщение `"{id}:{exp}"`, TTL 3600;
  - ETag = `"sha256"` отдаваемых байт (R34);
  - варианты WebP 96/480 без увеличения;
  - ключ объекта `{type}/{yyyy}/{mm}/{fileId}/{variant}`;
  - S3: path-style, `request_checksum_calculation`/`response_checksum_validation` = `when_required` (P4).
- Учётные данные и сессии:
  - пароли — Argon2id PHC `$argon2id$v=19$m=65536,t=3,p=1$…` (читаются и пишутся совместимо с Express);
  - JWT HS256 с общим `JWT_SECRET`, claims строго по P12;
  - refresh — cookie `at_refresh` (HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age 1209600, при очистке 0), ровно один `Set-Cookie`; хеш хранится в общей `refresh_tokens`.
- Строки (R36, R24): ничего не обрезается; `TrimStrings` и `ConvertEmptyStringsToNull` выключены; длины считаются в кодовых точках (`mb_strlen`); все `preg_match` с якорем `$` пишутся с модификатором `D` (или через `\z`); сортировка строк — `COLLATE "C"`, сравнения в PHP — `strcmp` по UTF-8.
- Заголовки и журналы:
  - `X-Backend: laravel` на каждом ответе (404 шлюза маршрутов, 405, 413, 500, SSE, файлы);
  - `X-Request-Id` принимается, если соответствует `^[A-Za-z0-9._-]{1,64}$`, иначе генерируется;
  - журналы — JSON-строки (Monolog) в stdout с полями `backend`, `requestId` (в воркере — `requestId` конверта); секреты маскируются (P8): password, newPassword, currentPassword, token, accessToken, refreshToken, access_token, refresh, secret, totp, totpSecret, authorization, cookie, set-cookie, idempotencyKey, altcha, sig.
- `audit_log` пишется для всех изменяющих операций:
  - `backend='laravel'`, `action` = operationId (системные — `system.*` с `actor_id` NULL);
  - `diff {field:[before,after]}` в API-формате, секреты `"***"`;
  - `request_id` и `ip` берутся из контекста запроса.
- Никакой бизнес-логики вне `app/Domain`: правила BR-01…BR-11 вызываются оттуда; домен покрыт Pest-тестами на общих векторах `contracts/rules/vectors/*.json`, покрытие ≥ 70 % (§14.1).
- Состояние между запросами Octane не утекает: контекст запроса — `scoped`-привязка контейнера; изменяемые `static` в `app/` запрещены (статический тест со списком исключений, Task 14).
- Коммиты — Conventional Commits, scope `laravel` (или `contracts`/`at`/`ci` для общих файлов), трейлер `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Проверка задачи считается выполненной только по фактическому выводу команд. Основная команда: `./at.sh api:test laravel <files>` (профиль api-test; полный прогон без аргументов включает проверку покрытия контракта). Модульные тесты: `./at.sh laravel:test`.

## Решения плана (L1–L15) и разрешённые противоречия ТЗ

- **L1. Очередь — собственный транспорт на php-amqplib, а не `vladimir-yuldashev/laravel-queue-rabbitmq`.** ТЗ §8.7 называет Laravel Queues и этот пакет, но контракт и решения стоят выше ТЗ, а пакет нарушает их в пяти местах:
  1. Отложенный повтор (`release($delay)`) создаёт на лету очереди `{queue}.delay.{ms}` — R55 запрещает другие имена очередей и обменников.
  2. Исчерпавшее попытки задание `queue:work` подтверждает и пишет в `failed_jobs`, а не делает `basic.reject` в DLQ (envelope).
  3. Однопоточный `queue:work` не реализует «занятый `vsd.import` → копия в `.delay` с `mandatory` и confirm → ack» (P56).
  4. Relay требует publisher confirms и протокол `UPDATE … published_at` (R56).
  5. Обёртка задания с сериализованной PHP-командой несовместима по формату с телом-конвертом Express (envelope это допускает, но выигрыша нет).

  Поэтому сделано так:
  - `app/Infrastructure/Amqp` (Connection, Publisher с confirm и mandatory, Consumer);
  - artisan-команда `agrotrace:consume`;
  - обработчики событий — классы Laravel (`app/Events/Handlers/*`), их разрешает Service Container.

  Laravel Queue не подключается (`QUEUE_CONNECTION=sync`, не используется).
- **L2. Модель процессов воркера.** Синхронный PHP-процесс не обслуживает два канала одновременно. `worker-laravel` (supervisord) запускает:
  - два процесса `agrotrace:consume`, каждый с одним каналом и `basic.qos` prefetch 1;
  - `agrotrace:telegram-poll`.

  Два процесса-потребителя контейнера вместе — это «процесс воркера» из R92/P56: не больше одного `vsd.import` на контейнер. Это обеспечивает общий неблокирующий `flock` (`/tmp/agrotrace-vsd.lock`, снимается при смерти процесса). Остальная семантика — дословно по envelope.
- **L3. SSE под Octane.**
  - Поток обслуживает Octane-воркер: `response()->stream()`, `ignore_user_abort(true)`, `flush()`.
  - Единственный сеанс `LISTEN notifications` (§8.2 п. 4) держит отдельный процесс `agrotrace:sse-hub` в контейнере api (supervisord). Он работает через PDO `pgsqlGetNotify(…, 1000)`, а последний оператор его сеанса — всегда `LISTEN notifications` (проверка живости повторяет его каждые 30 с).
  - Хаб пересылает полезную нагрузку NOTIFY в Redis pub/sub `agrotrace:laravel:sse:user:{userId}` и события потери/восстановления — в `agrotrace:laravel:sse:control` (поколение + момент потери в ключе `agrotrace:laravel:sse:gen`).
  - Поток подписывается собственным минимальным RESP-клиентом (`stream_select` с таймаутом, без блокирующего `subscribe` phpredis).
  - Между событиями поток не держит соединение PG (отдаёт слот DbSlots).
- **L4. Бюджет соединений.** ТЗ §8.4 требует Octane, а текст контракта P61 называет для Laravel «`pm.max_children` php-fpm».
  - Решение: число Octane-воркеров (`OCTANE_WORKERS`, по умолчанию 32 — потоки SSE занимают воркеры) отвязано от числа соединений PG счётным семафором `DbSlots` (flock-слоты на контейнер, `DB_SLOTS=12`).
  - Соединение открывается лениво через собственный `PgConnector` (сначала берётся слот, ожидание ≤ 5 с, иначе 503) и закрывается вместе с освобождением слота в конце запроса (Octane `RequestTerminated`), а в SSE — сразу после повтора.
  - Итог 18 ≤ 20. Фраза P61 для Laravel уточняется в Task 14.
- **L5. Планировщик.**
  - Laravel Scheduler (`routes/console.php`, `schedule:work`) с суб-минутными частотами Laravel 11.
  - `SCHEDULER_TICK_MS` переводится в частоту:
    - делители 60 000 мс (1, 2, 5, 10, 15, 20, 30 с) → `everySecond()` … `everyThirtySeconds()`;
    - кратные 60 000 → cron `*/N`;
    - иное → выход с кодом 78.
  - По умолчанию 300 000 → `everyFiveMinutes()`; стенд задаёт 1000 → `everySecond()`.
  - Команда контейнера `agrotrace:schedule` сначала один раз выполняет все задания («сразу при старте процесса», контракт), затем запускает `schedule:work`.
  - Каждое задание идёт под сеансовой `pg_try_advisory_lock(hashtext('agrotrace.scheduler.<job>'))` на том же соединении и с `pg_advisory_unlock` в `finally`; занято — тик пропускается.
  - Суб-минутные события выполняются последовательно, поэтому перекрытия тиков нет.
  - Sweeper outbox (каждые 5 с, `agrotrace.outbox.laravel`) живёт в планировщике: в Octane нет фоновых циклов. Контракт место sweeper не фиксирует.
- **L6. Работа вне пути запроса** (P15, P18, P21, P24, P25, P52) — дочерние PHP-процессы вместо `worker_threads`. Механизм `App\Infrastructure\Sandbox`:
  - `proc_open` автономного скрипта `resources/sandbox/*.php` без загрузки Laravel;
  - `memory_limit` на процесс, SIGKILL по сроку;
  - результат — один JSON в stdout;
  - очередь на контейнер — «1 выполняемая + N ожидающих» на flock-слотах.

  Срок отсчитывается от постановки в очередь, ожидание входит в срок, запуск процесса до строки `ready` — нет. Ожидающая задача клиента, закрывшего соединение, снимается; выполняемая доводится до конца, результат отбрасывается.

  | Очередь | Ожидающих | Срок | Память |
  |---|---|---|---|
  | SVG, две очереди (≤ 64 КиБ и крупнее) | 8 | 3 с | — |
  | XLSX, две очереди | 8 | 10 с | 256 МБ |
  | Отчёты | 4 | 120 с | 1 ГиБ |
- **L7. Валидация.** FormRequest на каждую операцию служит оболочкой: `authorize()` → true (роли проверяет middleware), `failedValidation` → Problem. Правила внутри — строгий JSON-валидатор `App\Http\Validation`, порт `packages/validation` один к одному: ключи `validation.*`, регулярные выражения дословно с `D`, пустая обязательная строка → `required`, `unknownField` по каждому лишнему ключу, `minProperties`, дискриминатор `oneOf` (P44), отложенные дубликаты (P36).

  Встроенные правила Laravel не годятся по четырём причинам:
  - нестрогие типы: `integer` принимает `"5"`, `boolean` — `"1"`;
  - пути через точку `items.0.x`;
  - сообщения-тексты вместо ключей;
  - зависимость от TrimStrings.
- **L8. Разбор запроса вручную.** `enable_post_data_reading=Off`; тело читается из `php://input` с потолком 12 МиБ + 1.
  - JSON: `json_decode` в объекты `stdClass`. Ошибка разбора → `_root invalid`; не объект → `_root type`. Целое — по семантике JS: `1.0` — целое число.
  - Query string: разбирается из сырого `QUERY_STRING` (повторяющиеся ключи → список, `+` → пробел, имена без подмены `.`/пробела).
  - Multipart: собственный потоковый разбор (P14, P17, P20).

  Причины: PHP теряет повторы ключей, меняет `.` на `_`, молча игнорирует битый multipart и дубли части `file`, а `ValidatePostSize` отвечает своим 413.
- **L9. Eloquent без миграций** (§7, §8.7). Каждая модель объявлена так: `$table`, `$keyType='string'`, `$incrementing=false`, `$timestamps=false`, `$guarded=[]`, `$dateFormat='Y-m-d H:i:s.uP'`.
  - Касты: только `JsonValue` (jsonb в `stdClass`/array с сохранением объектов) и скаляры.
  - Нет `datetime`-кастов: моменты хранятся строками PG с микросекундами и форматируются через `Iso`.
  - Нет `SoftDeletes` и глобальных scope: видимость и мягкое удаление — явные scope-методы и SQL-предикаты в `app/Queries`. Обход отзыва идёт через удалённые партии, блокировки не должны получать скрытых условий, поэтому глобальные scope — источник ошибок.
  - Нет неявной привязки моделей к маршрутам (иначе 404 прозвучит раньше 400 `validation.uuid`).
- **L10. Swagger UI.** `/api/v1/docs` отдаёт swagger-ui-dist и `init.js` над рукописным бандлом контракта `openapi.json`, как Express.
  - Scribe не используется: схема, выведенная из FormRequest, расходилась бы с рукописным контрактом по построению.
  - Сравнение «сгенерированная схема ↔ контракт» из §8.3 заменено двумя проверками: `docs.test.ts` (отдаваемый контракт = бандл) и Ajv-валидацией каждого ответа в tests/api.
- **L11. ALTCHA — нативная реализация** по рецепту P40/M7 (вектор `contracts/rules/altcha.json`). Библиотека `altcha-org/altcha` не используется: побайтовые правила (каноничный base64, `number` строго цифрами в исходном тексте JSON, `expires` обязателен) библиотека не гарантирует.
- **L12. Безопасность.**
  - TOTP — `pragmarx/google2fa` `verifyKeyNewer` (возвращает шаг совпадения для `totp-used`), окно ±1.
  - JWT — `firebase/php-jwt` с ключом HS256, плюс ручная проверка заголовка до декодирования (`alg` ровно HS256, отказ при `crit`) и типов claims по P12.
  - Argon2id — `Hash::driver('argon2id')` с `memory=65536, time=3, threads=1`. Если в сборке PHP нет `PASSWORD_ARGON2ID`, используется `sodium_crypto_pwhash_str` с теми же параметрами (тот же PHC).
- **L13. Импорт XLSX.**
  - Чтение — собственный читатель на `XMLReader` в песочнице. Он работает после ZIP-проверок и линейного предразбора (порт `xlsx-scan.ts`) и воспроизводит семантику exceljs из `xlsx-read.ts`: rich text склеивается; формула → её сохранённый результат; boolean, дата (форматы дат exceljs), ошибка → INVALID; число → `numberText` (JS ToString без экспоненты).
  - PhpSpreadsheet (§8.7) — только запись отчётов: при чтении он строит весь лист в памяти и иначе толкует ячейки.
- **L14. Десятичные числа** — только строки и bcmath (`kgToGrams`, `MassTotal`, `ratioPercent2`), никаких float: суммы до 10^18 г и `n·10^4` выходят за int64 и точность double.
- **L15. Метрики (P54).**
  - Гистограмма и счётчик — `prometheus_client_php` с хранилищем APCng (общая память потоков FrankenPHP в одном процессе).
  - Gauge `queue_messages` и `recalls_open` вычисляются при опросе и дописываются к тексту экспозиции собственным кодом (точное `NaN`, единственная метка `backend` у `recalls_open`).
  - Порт `METRICS_PORT` 9464 — отдельный блок Caddyfile, пропускающий только `GET /metrics`; на 8000 `/metrics` → 404.
- **Прочие уточнения ТЗ контрактом:**
  - QR PDF — этикетка A6 (контракт createBatchQr), а не «A4 3×8» из §8.6;
  - TOTP, JWT и S3 — как в таблице §8.7.

## Реестр обязательств порта

Каждая строка — поведение, которое tests/api проверяет не полностью или которое Express вывел решением; номер задачи — где оно реализуется.

| Решение | Обязательство | Task |
|---|---|---|
| R24 note, R21, R26 | `D`/`\z` в PCRE (вектор BR-11 с переводом строки); tie-break по кодовым точкам; kg↔g ≤ 9 целых и ≤ 3 знаков | 1 |
| M2 (T8-9) | Векторы `working-days.json`, `BR-08*.json` (срок задачи отзыва) и все остальные векторы `contracts/rules/vectors` — Pest-тесты домена | 1 |
| P3, P7, P8 | 405 METHOD_NOT_ALLOWED + `Allow` (OPTIONS тоже, HEAD = GET); `_root`; регистрозависимая строгая маршрутизация, `//` и битые `%`-escape → 404; X-Request-Id по R79 | 1 |
| P61 | Слоты, тайм-ауты, 503; проверка суммарного бюджета при старте каждого процесса (выход 78) | 1 |
| R31, P60, R35 M1/M2, R32/R40, P12, P9, R66, R92 | Порядок входа и условный сброс счётчика; гонка правильного и пятого неверного пароля; резерв попытки TOTP в MULTI, `GETDEL` до сжигания шага; ротация под `pg_advisory_xact_lock('refresh:'…)`; claims; `Cache-Control: no-store`; контрольная сумма ИНН; тело проверяется до `GETDEL` | 2 |
| P10 | `RATE_LIMIT_OVERRIDES`; `[ratelimit]`-тесты против обычного backend | 2, 14 |
| P14–P21 | Порядок multipart; SVG: предразбор, список элементов, пределы, две очереди 1+8, 3 с; style/url-правила; видимость организаций; самоправка → notAllowed; `TELEGRAM_BOT_USERNAME` | 3 |
| P4, R34, R39, R88 | S3 checksum `when_required`; ETag, 304, Content-Disposition; подпись только `{id}:{exp}`; `exp` по `^[1-9]\d{0,11}$` | 3 |
| P22–P28, R58, R59, R93 | XLSX: ZIP → inflate/CRC каждой записи → потолки частей → предразбор (r, пространства имён, корректность XML, UTF-8) → чтение (10 с, 256 МБ, 1 000 символов, 8 МиБ) → tooManyRows → заголовок; CSV; advisory `dictionary:`; D1/D3/D5/D6/D7/D10/D11 | 4 |
| R41/D31, R51 | Даты UTC в фильтрах; фильтр, недоступный роли → 400 `notAllowed`, даже `false` | 5+ |
| R42–R45, R49, R50, R81, R82, R91, P35, P56, m2 | Лаборатория D18 и 409 NO_LAB_AVAILABLE; QR; путь; фильтры; VSD и ручки стенда Mercury; `pub:batch` DEL после коммита; R91; очередь задержки с `mandatory`; `createBatch` читает поле `FOR KEY SHARE … deleted_at IS NULL` | 6 |
| R48, R53, I1 (T6-7), P36, R50c, P39 | Идемпотентность, Lua; разрыв клиента оставляет pending; дубликаты на своём шаге; переназначение задач при reject; отзыв выигрывает у accept | 7 |
| R54 D7, R57, P2, P43 | REPEATABLE READ; `lab_tests.recall_id`; ядро движка в Task 9; один момент на операцию | 9, 10 |
| R89, M5/M6 (T10-11), P57 | Нет OPENED у отзыва без задач, закрытого или удалённого; overdue пропускает удалённые отзывы; `locks.test.ts` | 10 |
| P40/M7, P41, P42, P44, M10 (T10-11), P32 | ALTCHA побайтово; лимит complaint-ip; ключи решения жалобы; повторное чтение version после `SET pub:batch`; id фото продуктов из сида | 11 |
| P45, P46, P49, P51, P53, N1, N5 | Ожидания между попытками 1 с и 2 с; окно SSE 60 с; захват на каждую отправку + sweeper 5 мин; NOT_CONFIGURED; повтор SSE без потолка; догон при resync во время подключения; срок попытки 30 с и метка-забор с микросекундами | 12 |
| P47, P50, P52 | Округление rejectedShare; числовые ячейки; `REPORT_MAX_ROWS`; рендер вне пути запроса, 503 report-busy до чтения данных | 13 |
| P54, P55, P58, P59 | Метрики; разрешённые 409; нейтральность к имени backend; санкционированные записи стенда (реализация обязана их терпеть и не кешировать эти строки дольше запроса) | 14 |

## Review Focus

Самые рискованные точки паритета. Каждую закрепляет тест в указанной задаче.

1. **Блокировки и конкуренция с Eloquent.**
   - Подводные камни: `lockForUpdate()` даёт `FOR UPDATE` (дедлок с неявным KEY SHARE, P57); `DB::transaction($cb, $attempts)` повторяет по своей эвристике и сочетается со вложенными savepoint; сохранение модели после блокировки может перечитать строку без блокировки.
   - Ожидаемое поведение: ровно один успех в гонках, без дедлоков.
   - Закрепление: `locks.test.ts` и гонки в `waybills`/`processing`/`lab`/`recalls` (Tasks 7–10); Pest `TxTest` (повтор ровно один раз, 409 с `currentVersion`, запрет вложенности); статический `LockStrengthTest` (Task 14).
2. **Границы транзакций и очередь.**
   - Риск: событие, опубликованное до коммита или потерянное после отката, либо обработчик с двумя транзакциями.
   - Ожидаемое поведение: строка outbox пишется в транзакции; публикация — только после коммита (`Tx::afterCommit` / после ответа) и sweeper; повторная доставка не дублирует (`processed_events`).
   - Закрепление: тест повторной публикации в `recalls.test.ts`/`events.test.ts` (Tasks 10, 12); Pest `ConsumerTest` на поддельном брокере (Task 6).
3. **Формат и топология сообщений (L1).**
   - Ожидаемое поведение: тело = конверт, `message_id = id`, только имена из `definitions.json`; занятый `vsd.import` → `.delay` (`mandatory` и confirm) → ack; возврат брокером → без ack, затем nack requeue через 1 с.
   - Закрепление: `documents.test.ts` «worker concurrency (R92, P56)» (зелёный после Task 12); Pest `ConsumerTest` (Task 6).
4. **Утечка состояния между запросами Octane.**
   - Риск: principal, requestId, ids событий, слот БД, открытый поток Redis прошлого запроса виден следующему.
   - Закрепление: Pest `OctaneIsolationTest` — два запроса в одном экземпляре приложения, второй не видит контекста первого, слот освобождён (Task 1); `StaticStateTest` — изменяемые `static` запрещены (Task 14); полный прогон дважды подряд (Task 14).
5. **Планировщик против advisory lock и `SCHEDULER_TICK_MS`.**
   - Риск: минутная гранулярность Laravel; `onOneServer()` использует кеш-блокировку вместо `pg_try_advisory_lock`; задание не выполняется при старте.
   - Закрепление: Pest `TickTest` (сопоставление частот, выход 78; блокировка занята → пропуск) (Task 9); тесты эскалации и overdue в `lab.test.ts`/`recalls.test.ts` ждут тик в 1 с.
6. **Формат ошибок.**
   - Риск: HTML/JSON Laravel по умолчанию; ответ `HandleCors` на OPTIONS; 404/405 Symfony; `PostTooLargeException`; `ModelNotFound` до 400; ошибки валидатора текстом; `TrimStrings`.
   - Закрепление: `contract-shape.test.ts`, `health.test.ts`, `harness.test.ts` (Task 1); `expectContract` на каждом ответе всех наборов; Pest `ProblemRendererTest` (каждый тип исключения → problem+json с `X-Backend`).
7. **Точность времени.**
   - Риск: Eloquent усекает микросекунды, и метка-забор доставки никогда не совпадает (N5); часы PHP вместо `now()` транзакции (P43); `TZ=Europe/Moscow`.
   - Закрепление: Pest `DeliveryTest` (метка — текст `RETURNING claimed_at`, сравнение `= :stamp::timestamptz`) (Task 12); проходы с `--tz Europe/Moscow` (Tasks 9, 14); assert'ы `createdAt=openedAt`, `closedAt=confirmedAt` в `recalls.test.ts`.
8. **Кодирование JSON.**
   - Риск: пустой объект как `[]` (`errors`, `params`, `payload`, `diff`); float `1.0`; jsonb, раскрытый в ассоциативный массив.
   - Закрепление: Ajv-проверка каждого ответа; Pest `JsonTest` (Task 1).
9. **SSE под FrankenPHP.**
   - Риск: буферизация вместо потока; поток держит воркер и соединение PG; разрыв клиента не обнаруживается; хаб теряет LISTEN.
   - Закрепление: `events.test.ts` (включая обрыв LISTEN через `pg_terminate_backend`) (Task 12); Pest `RespSubscriberTest`, `SseFrameTest`.

---

## Карта файлов

```
backend-laravel/
  composer.json composer.lock artisan phpunit.xml phpunit.domain.xml pint.json phpstan.neon
  Dockerfile Dockerfile.dockerignore
  docker/                 Caddyfile (:8000 api, :9464 только /metrics), php.ini (enable_post_data_reading=Off,
                          date.timezone=UTC, memory_limit), supervisord-api.conf (octane + sse-hub),
                          supervisord-worker.conf (2× agrotrace:consume + agrotrace:telegram-poll)
  bootstrap/app.php       middleware (стек заменён целиком), исключения → Problem\Renderer, маршруты
  config/                 app, database (pgsql + PgConnector), octane (flush/listeners), logging (Monolog JSON), agrotrace.php (env)
  routes/api.php          92 операции контракта ->name(operationId); routes/console.php — расписание (L5)
  resources/sandbox/      svg-sanitize.php xlsx-read.php report-render.php (без загрузки Laravel)
  resources/swagger/      init.js; swagger-ui-dist и openapi.json копируются в образ
  app/
    Contract/             Contract.php (бандл, операции, сопоставление пути), RulesRepo.php (contracts/rules/*.json)
    Domain/               StateMachine Decimal Dates Rules Idempotency Strings (чистый PHP)
    Http/
      Middleware/         RequestContextMw BackendHeader AccessLog ContractGate JsonBody Operation (401→лимит user→403)
                          Idempotency IfMatch Metrics
      Problem/            Problem ProblemCode Renderer
      Validation/         Schema-DSL (S, Validator, Errors) + схемы модулей (порт packages/validation/src/*)
      Requests/           FormRequest на операцию
      Query/QueryReader.php  Multipart/MultipartReader.php
      Controllers/<Module>/  Sse/StreamController.php Sse/RespSubscriber.php
    Actions/<Module>/     сценарии операций (транзакции, порядок проверок)
    Policies/             сторона операции (NOT_HOLDER, NOT_SENDER, …)
    Queries/              Visibility Graph RecallScope Path Dashboard Sheets (сырой SQL)
    Models/               Eloquent на каждую таблицу (L9)
    Events/               Claim.php Handlers/{VsdImport,RecallRequested,RatingRecalculate,NotificationDispatch,LabEscalate}.php
    Notifications/        Insert.php (раскрытие получателей) Delivery.php
    Scheduler/            Tick.php (частота, advisory lock) Jobs/{LabEscalation,RecallTaskOverdue,NotificationDelivery,OutboxSweep}.php
    Security/             Principal Passwords Jwt Totp OpaqueTokens FileUrls Altcha
    Infrastructure/       Db/{Tx,TxOptions,DbSlots,PgConnector,Locks} Outbox/{Outbox,Relay} Amqp/{Connection,Publisher,Consumer,VsdLane}
                          Redis/Scripts.php RateLimit/RateLimiter.php Storage/ObjectStore.php Images/Images.php
                          Svg/{SvgScanner,SvgSanitizer} Xlsx/{Zip,XlsxScanner,XlsxReader,JsNumber} Csv/CsvReader.php
                          Sandbox/{Sandbox,Lane} Mail/Mailer.php Telegram/Telegram.php Dadata/Dadata.php Mercury/Mercury.php
                          Qr/Qr.php Pdf/Pdf.php Reports/XlsxWriter.php Metrics/Metrics.php
    Console/Commands/     Consume SseHub TelegramPoll Schedule
    Support/              RequestContext Json Iso
  tests/                  Pest.php Unit/** (без БД) Integration/** (БД agrotrace_test, R15)
```

Рекомендуемые пары для SDD (как P29): T1, T2, T3, T4+T5, T6+T7, T8+T9, T10+T11, T12+T13, T14. Одна реализация и одна независимая проверка на пару.

Правило промежуточной «зелёности». Каждая задача прогоняет перечисленные файлы tests/api. Красным может остаться только тест, чей запрос упирается в операцию поздней задачи: необъявленная ещё операция отвечает 404, как у Express. Такие тесты перечисляются в отчёте задачи, и список обязан сократиться до нуля в задаче, реализующей эти операции. Полный прогон до Task 14 падает на `contract-coverage.test.ts` — это ожидаемо.

---

### Task 1: Каркас Laravel, инфраструктура запросов, домен, стенд

**Files:**
- Create: `backend-laravel/**` (каркас по карте), `backend-laravel/tests/Unit/{Domain/VectorsTest,JsonTest,TxTest,ProblemRendererTest,OctaneIsolationTest,ContractGateTest}.php`.
- Modify (только добавления):
  - `docker-compose.yml`:
    - `api-laravel` — порт 8000 и `expose 9464` в сети `at`, healthcheck `/api/v1/health/live`;
    - `worker-laravel`, `scheduler-laravel`;
    - `php-tools` (profile `tools`, build target `dev`, том `laravel-vendor` для `backend-laravel/vendor`, монтирование репозитория);
    - все — с `depends_on` здоровых postgres/redis/rabbitmq/minio.
  - `docker-compose.api-test.yml` — блоки Laravel, значения как у Express:
    - `api-laravel`: `RATE_LIMIT_OVERRIDES='{"user":100000,"login-ip":100000,"complaint-ip":100000}'`, `DADATA_API_KEY=''`, `TELEGRAM_BOT_TOKEN='api-test-token'`, `TELEGRAM_BOT_USERNAME='agrotrace_test_bot'`, `REPORT_MAX_ROWS='13'`, `TZ`;
    - `worker-laravel`: `MERCURY_FAIL_PRODUCT_CODES='99.99.99'`, `MERCURY_FAIL_MODE='500'`, `MERCURY_RETRY_BASE_MS='50'`, `TELEGRAM_BOT_TOKEN=''`, `TZ`;
    - `scheduler-laravel`: `SCHEDULER_TICK_MS='1000'`, `TELEGRAM_BOT_TOKEN=''`, `TZ`.
  - `at.sh` — команды и строки `test:all`:
    - `laravel:test [pest args]` и `--domain-coverage` → `php-tools vendor/bin/pest`;
    - `laravel:lint` (pint `--test` + larastan);
    - `composer <args>`;
    - строки `test:all`: `laravel:test`, `api:test laravel --reset`, `--ratelimits`.

    `up laravel`, `up <front> laravel`, `api:test laravel`, `cross:test … laravel` и `docs:test laravel` уже поддерживаются `backend_services`.
  - `tests/at/at.test.ts` — dry-run случаи новых команд и состава `api:test laravel` (перезапуск трёх процессов с профилем api-test).
  - `.github/workflows/ci.yml` — job `laravel-unit` (pest, домен с покрытием, pint, larastan); job `api-laravel` наполняется в Task 14.
  - `.env.example` — `LARAVEL_APP_KEY` (dev-значение), `OCTANE_WORKERS`, `DB_SLOTS`.

**Operations:** getHealthLive, getHealthReady; `/api/v1/docs` (страница, ассеты, `openapi.json`).

**tests/api:** `health.test.ts`, `contract-shape.test.ts`, `harness.test.ts`, `docs.test.ts`; плюс `./at.sh docs:test laravel` (Playwright, Swagger UI под CSP шлюза, P5).

**Interfaces — Produces** (все последующие задачи используют именно эти имена):
- Контракт:
  - `App\Contract\Contract::match(string $method, string $rawPath): ?RouteMatch` — `RouteMatch{operationId, template, params}`, литеральные сегменты важнее параметров;
  - `methodsFor(string $rawPath): ?array` — null, если пути нет в контракте;
  - `operation(string $operationId): array` — x-расширения, параметры;
  - `RulesRepo::json(string $name): array`.
- Ошибки:
  - `App\Http\Problem\ProblemCode` — string enum, значения ровно из контракта, включая METHOD_NOT_ALLOWED и NO_LAB_AVAILABLE; методы `type(): string`, `title(): string`;
  - `Problem(int $status, ProblemCode $code, ?array $errors = null, ?string $rule = null, ?array $params = null, array $headers = [], ?string $detail = null)` и `Problem::validation(array $errors)`;
  - `Renderer::render(\Throwable): Response`.
- Контекст запроса: `App\Support\RequestContext` (scoped) — `requestId()`, `clientIp()`, `principal(): ?Principal`, `setPrincipal()`, `addEventId(string)`, `eventIds(): array`, `afterResponse(callable)`.
- Транзакции:
  - `App\Infrastructure\Db\Tx::run(callable $fn, ?TxOptions $o = null): mixed`;
  - `TxOptions(string $isolation = 'read committed', bool $readOnly = false, ?\Closure $conflictParams = null, ?\Closure $retryIf = null)`;
  - `Tx::now(): string` — текст `now()` текущей попытки с микросекундами;
  - `Tx::afterCommit(callable)` — эффекты попытки; при повторе и откате отбрасываются.
- Слоты БД: `DbSlots::acquire(float $timeoutSec = 5.0): void` и `release(): void`.
- Outbox: `Outbox::enqueue(string $type, array|\stdClass $data): string` (id события, P1).
- Вспомогательные: `Json::encode(mixed): string`, `Json::decode(string): mixed` (объекты сохраняются), `Json::obj(array): \stdClass`; `Iso::fromPg(?string): ?string`.
- Домен — сигнатуры как у `@agrotrace/domain`, вход и выход ровно в форме векторов:
  - `App\Domain\Dates::addWorkingDays(array $i): array`, `recallTaskDueAt(array $i): array`, `canEditTreatment(array $i): array`;
  - `Rules::checkWaitingPeriod(array $i): array`, `concludeLabTest`, `requiresLabTest`, `checkMassBalance`, `canUseAsInput`, `checkDiscrepancy`, `nextTrustRating`, `shouldCloseRecall`, `formatBatchCode`;
  - `StateMachine::canTransition(array $i): array`, `availableActions(string $from): array`;
  - `Decimal::compare(string,string): int`, `kgToGrams(string): string`, `gramsToKg(string): string`, `ratioPercent2(string $n, string $d): string`;
  - `Idempotency::decision(array $i): array`, `Strings::compareCodePoints(string,string): int`;
  - `App\Domain\Vectors::call(string $fn, array $input): array` — диспетчер для тестов векторов.

**Port notes:**
- Глобальный стек middleware заменён целиком: RequestContext → BackendHeader → AccessLog → ContractGate → JsonBody. Убраны `HandleCors` (иначе OPTIONS отвечает сам), `TrustProxies`, `ValidatePostSize`, `TrimStrings`, `ConvertEmptyStringsToNull` (R36) и `PreventRequestsDuringMaintenance`.
- `ContractGate`:
  - путь сопоставляется с шаблонами контракта по сырому `REQUEST_URI` до `?`, регистрозависимо, без хвостового `/`; пустой сегмент (`//` где угодно в пути), битый `%`-escape, путь вне контракта → 404 NOT_FOUND;
  - метод, не объявленный для пути (включая OPTIONS; HEAD = GET), → 405 METHOD_NOT_ALLOWED с `Allow` из контракта;
  - объявленная, но ещё не реализованная операция → 404.
- Тело JSON больше 12 582 912 байт → 413 FILE_TOO_LARGE `params.maxBytes 12582912`; за пределом сразу `Connection: close`. В Caddyfile предел тела не ниже этого: свой 413 Caddy не problem+json.
- Документация: swagger-ui-dist той же версии, что у Express (стадия Docker на pnpm-lock). В `init.js` есть `url: '/api/v1/openapi.json'`; inline-скриптов и CDN нет; бандл собирает `pnpm --filter @agrotrace/contracts bundle` в стадии образа.
- Health: ready проверяет db, redis, rabbitmq (passive `exchange_declare` на временном канале) и s3 (HeadBucket), каждую проверку не дольше `HEALTH_TIMEOUT_MS`=2000; любой отказ → 503 по схеме.
- `PgConnector`:
  - сначала слот, затем соединение;
  - после соединения выполняется `SET statement_timeout='30s'`, `SET lock_timeout='10s'`, `SET TIME ZONE 'UTC'` и задаётся `application_name=agrotrace-laravel-<process>`;
  - Octane-слушатель `RequestTerminated` вызывает `DB::disconnect()` и освобождает слот.
- `Tx` не использует `DB::transaction(…, $attempts)`. Вложенный вызов запрещён (assert уровня 0). Уровень изоляции задаётся первой командой транзакции. Ошибки 40P01/40001 определяются по SQLSTATE `errorInfo[0]`.
- Outbox: `occurredAt` — часы на момент вставки (R59, ISO с мс), `requestId` из контекста (null вне запроса), id — UUIDv4.
- Каждый процесс при старте проверяет, что заданный бюджет (`DB_SLOTS` + 1 + 3 + 2) не больше 20, иначе выход с кодом 78. Неверная конфигурация окружения → выход 78 со списком ошибок.
- Домен:
  - даты через `DateTimeImmutable` в UTC, вывод `.000Z`;
  - регулярные выражения с `D`;
  - `formatBatchCode` → `AT-YYYY-NNNNNN`;
  - машины состояний читаются из `contracts/rules/*state-machine*.json` (копия в образе).

- [ ] **Шаг 1: worktree и окружение.** Создать worktree и ветку, скопировать `C:/project/.env`. `./at.sh check` зелёный (инфраструктура, очереди `agrotrace.laravel.*` с `x-delivery-limit` и `.delay`).
- [ ] **Шаг 2: Pest-тесты домена (RED).** `tests/Unit/Domain/VectorsTest.php`: dataset из каждого `contracts/rules/vectors/*.json`; для каждого случая `expect(Vectors::call($fn, $case['input']))->toEqual($case['expected'])`; плюс проверка, что ни один файл векторов не пропущен (по каталогу). `./at.sh laravel:test tests/Unit/Domain` → FAIL (классов нет).
- [ ] **Шаг 3: домен.** Реализовать `app/Domain/*`. `./at.sh laravel:test --domain-coverage` → PASS, покрытие `app/Domain` ≥ 70 %. Коммит `feat(laravel): domain rules on the shared vectors`.
- [ ] **Шаг 4: тесты каркаса (RED).** `./at.sh api:test laravel health.test.ts contract-shape.test.ts harness.test.ts docs.test.ts` → FAIL (сервиса нет). Pest:
  - `JsonTest` — `{}` против `[]`, `1.0`, объекты из jsonb;
  - `TxTest` — один повтор на 40001/40P01, затем Problem 409 с `currentVersion` из `conflictParams`; `retryIf`; `afterCommit` не выполняется после отката;
  - `ProblemRendererTest` — каждый класс исключения → problem+json с корректными `type`/`status`;
  - `ContractGateTest` — `//`, `%zz`, регистр, хвостовой `/`, OPTIONS, HEAD;
  - `OctaneIsolationTest` — два запроса подряд в одном приложении не делят requestId, principal и eventIds.
- [ ] **Шаг 5: каркас.** Реализовать каркас, Dockerfile (стадии `contract` (node/pnpm: бандл и swagger-ui-dist), `vendor`, `dev`, `prod` на FrankenPHP с точным тегом образа), compose-сервисы, `at.sh`, `tests/at`, CI `laravel-unit`. Проверить, что `php -r 'var_dump(defined("PASSWORD_ARGON2ID"));'` даёт true в образе, иначе включить фолбэк L12.
- [ ] **Шаг 6: GREEN.** Все команды и ожидаемые результаты:
  - `./at.sh api:test laravel health.test.ts contract-shape.test.ts harness.test.ts docs.test.ts` → PASS;
  - `./at.sh docs:test laravel` → 1 passed;
  - `./at.sh laravel:test` → PASS;
  - `./at.sh at:test` → PASS;
  - `./at.sh up react laravel` + `curl http://react-laravel.localhost:<port>/api/v1/health/live` → 200, `X-Backend: laravel`.
- [ ] **Шаг 7: коммиты.** `feat(laravel): skeleton, problem handling, contract gate, stand wiring` и `chore(at): laravel commands and compose services`.

### Task 2: Аутентификация и сессии

**Operations:** login, refreshToken, logout, setupTwoFactor, verifyTwoFactor, forgotPassword, resetPassword, registerOrganization, acceptInvite.

**tests/api:** `auth.test.ts`. Случаи, опирающиеся на `updateUser` (Task 3) и `approveOrganization`/`updateAdminOrganization` (Task 4), становятся зелёными в этих задачах.

**Interfaces — Produces:**
- `App\Security\Principal` (readonly): `userId`, `orgId`, `roles: list<string>`, `orgAdmin: bool`, `exp: int`.
- `Jwt::issue(Principal-данные): string`, `Jwt::verify(string): Principal` (бросает Problem 401).
- `Passwords::hash(string): string`, `verify(string $plain, string $phc): bool`, `dummyVerify(): void`.
- `Totp::verify(string $secret, string $code, int $nowSec): ?int` (шаг совпадения).
- `OpaqueTokens::new(): string` (43 символа base64url), `hash(string): string` (sha256 hex).
- `RateLimiter::hit(string $scope, string $subject): void` (Problem 429 с `Retry-After` и `params {scope, limit, windowSec}`).
- Middleware `operation:{operationId}`: 401 → лимит `user` → 403 по `x-roles`/`x-org-admin` (без `params`). `Auth::principal(): Principal`.
- `AuditWriter::record(string $action, string $entityType, ?string $entityId, array $diff): void` (в текущей транзакции).
- `Mailer::send(string $to, string $subjectKey, string $bodyKey, array $params): void`.
- `Dadata::findParty(string $inn): DadataResult` — `found`/`notFound`/`unavailable`.
- `FileUrls::signed(string $fileId, ?string $variant): string`.

**Port notes:**
- Вход (R31):
  1. лимит login-ip;
  2. тело;
  3. email в нижний регистр;
  4. неизвестный email → `dummyVerify`, 401 INVALID_CREDENTIALS;
  5. `locked_until > now()` (часы БД) → ACCOUNT_LOCKED `{lockedUntil}` без проверки пароля;
  6. неверный пароль → одна команда UPDATE со счётчиком (5 → блокировка на 15 мин, счётчик 0);
  7. верный пароль → `UPDATE … SET failed_logins=0 WHERE id=$1 AND (locked_until IS NULL OR locked_until <= now()) RETURNING id`; нет строки → ACCOUNT_LOCKED (I1);
  8. статусы: USER_BLOCKED → USER_INVITED → ORGANIZATION_NOT_ACTIVE;
  9. challenge `2fa:{id}` или токены.

  Гонка правильного и пятого неверного пароля не специфицирована (P60).
- Refresh (R32, R40, P12):
  - найти `user_id` по хешу без блокировки → `pg_advisory_xact_lock(hashtext('refresh:'||user_id))` → строка `FOR NO KEY UPDATE`;
  - отозван ротацией не больше 10 с назад → 401 TOKEN_EXPIRED без `Set-Cookie`;
  - старше → отзыв линии `replaced_by` рекурсивным CTE;
  - отозван logout/reset → 401 + очищенная cookie;
  - пользователь BLOCKED или организация не ACTIVE → 403 с `reason` и очищенной cookie;
  - `expires_at = now() + 14 d` в SQL.
- JWT: `exp = iat + 900`, `jti`. Проверка отклоняет:
  - `alg` не HS256 (включая `none`, HS512, RS256 над HMAC);
  - `crit`;
  - отсутствие или неверный тип `sub`/`org` (uuid), `roles` (непустой массив RoleCode), `org_admin` (bool), `exp`/`iat` (int), `jti` (string).

  Токены Express принимаются и наоборот (общий секрет).
- TOTP (R35):
  - setup в два шага; повторная настройка → 409 INVALID_TRANSITION `{from: ENABLED}`;
  - verify резервирует попытку одним MULTI `EXISTS 2fa:{id}`, `INCR 2fa-fail:{id}`, `EXPIRE 300 NX`; больше 5 → ключи удаляются, TOKEN_EXPIRED; `attemptsLeft` = 5 − n;
  - при успехе: шаг совпадения не должен быть в `totp-used` (EXISTS); затем `GETDEL 2fa:{id}` (null → TOKEN_EXPIRED, шаг не сжигается); затем `SET totp-used:{userId}:{step} NX EX 90`; проигранный параллельный SET → 401 INVALID_TWO_FACTOR_CODE с `attemptsLeft` 0 (M2).
- Забытый пароль: тело → лимит `forgot` по email в нижнем регистре → `pwreset:{sha256}` `{"userId","exp"}` EX 3600 → письмо со ссылкой `${PUBLIC_BASE_URL}/password/reset/{token}`; ответ 204 всегда.
- reset/accept: тело проверяется до `GETDEL` (R92). Reset снимает блокировку и отзывает все refresh под тем же advisory lock.
- Регистрация (R66):
  - схема, контрольная сумма ИНН → затем одна 400 со всеми ссылочными ошибками (`inn` taken, `admin.email` taken, `regionCode` notFound, регион `FOR KEY SHARE`) → DaData;
  - DaData: 3 попытки по 3 с, 4xx без повтора, нет ключа → MANUAL_CHECK, без имени → `name` required;
  - руководитель ACTIVE + `is_org_admin`, роль по типу организации; гонка 23505 → «taken».
- Cookie: ровно один `Set-Cookie` `at_refresh`, атрибуты как в Global Constraints (Symfony Cookie, `raw`, без шифрования cookie Laravel).
- Аудит пишется для registerOrganization, acceptInvite, resetPassword, setupTwoFactor (шаг 1 `totpSecret: [null|"***","***"]`, шаг 2 `totpEnabled`); вход и refresh аудита не пишут.
- Письма — шаблоны `mail.*` из `packages/i18n/locales/ru.json` (копия в образе), подстановка параметров как в `packages/i18n/src/notification.ts`.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel auth.test.ts` → FAIL (404). Pest:
  - `TotpTest` (векторы RFC 6238 и шаг совпадения);
  - `JwtTest` (все отказные варианты выше и действительный токен);
  - `PasswordsTest` (префикс PHC с m=65536,t=3,p=1; проверка PHC-вектора, созданного один раз `argon2` Express и сохранённого в фикстуре теста);
  - `RateLimiterTest` (ключ, окно, `Retry-After`, overrides);
  - `RegistrationIdentityTest` (found, notFound, unavailable, без имени).
- [ ] **Шаг 2: реализация.** Модули `app/Security/*`, `Actions/Auth/*`, middleware `operation`, `RateLimiter`, `Mailer`, `Dadata`, `AuditWriter`.
- [ ] **Шаг 3: GREEN.** Команды и ожидаемые результаты:
  - `./at.sh api:test laravel auth.test.ts` → PASS, кроме случаев с операциями Tasks 3–4 (перечислить в отчёте);
  - `./at.sh api:test laravel --ratelimits auth.test.ts` → тесты `[ratelimit]` login-ip/forgot/user зелёные;
  - `./at.sh laravel:test` → PASS.
- [ ] **Шаг 4: коммит.** `feat(laravel): authentication, sessions, 2fa, registration`.

### Task 3: Профиль, пользователи, организации, файлы

**Operations:** getMe, updateMe, uploadMyAvatar, deleteMyAvatar, getMyChannels, updateMyChannels, createTelegramCode, listUsers, inviteUser, updateUser, getUserAvatar, getOrganization, listOrganizations, uploadOrganizationLogo, getOrganizationLogo, downloadFile, downloadPublicFile.

**tests/api:** `profile.test.ts`, `users.test.ts`, `organizations.test.ts`, `files.test.ts`; `auth.test.ts` — случаи с `updateUser` и приглашениями.

**Interfaces — Produces:**
- `MultipartReader::read(Request $r, int $maxBytes): Upload` — `Upload{bytes, originalName, size}`; Problem 400/413 по P14.
- `QueryReader` (из сырого `QUERY_STRING`): `page()`, `size()`, `sort(array $fields, string $default)`, `uuid(string)`, `enum(string, array)`, `enums(string, array)` (повторяемый), `text(string)`, `bool(string)`, `date(string)`, `dateRange()`, `notAllowed(string)`. Все ошибки запроса собираются в одну 400.
- `Images::sniff(string $bytes): ?string` (mime по сигнатуре); `Images::variants(string $bytes, string $mime): array` (`{96:{bytes,sha256,size},480:…}`; Problem 415).
- `SvgScanner::scan(string $bytes): void` (Problem 415); `SvgSanitizer::sanitize(string $bytes, ?callable $clientGone): string` (через Sandbox).
- `Sandbox\Lane::run(string $script, string $input, LaneOptions $o): string`.
- `ObjectStore::put(string $key, string $bytes, string $mime)`, `get(string $key): string`.
- `Files::insert(...)`, `Files::send(Request, object $file, ?string $variant, ?string $disposition): Response`.
- `Visibility::organizationVisibleTo(Principal, string $orgId): string` (SQL-фрагмент с привязками).
- `PublicCache::dropForOrganization(string $orgId)`, `dropCodes(array $codes)` (`DEL pub:batch:*` после коммита, пачками по 500).

**Port notes:**
- Порядок проверок (P14): 401 → 403 → 400 схема/multipart → 404 → 403 по стороне → 409 → 400 ссылки → 415.
- Multipart (P14, P17, P20):
  - не multipart, нет `file` или пустой файл → `file required`; вторая часть `file` → `duplicate`; другая часть → `<имя> unknownField`; битое тело → `_root invalid`;
  - `originalName` = базовое имя после отбрасывания сегментов до последнего `/` или `\`; больше 255 кодовых точек → `file maxLength`; экранирование `%22` по правилам форм;
  - лимит включительный (2 МиБ, 5 МиБ, 10 МиБ); остаток тела дочитывается, чтобы клиент получил 413; больше 12 МиБ → 413 сразу с `Connection: close`.
- Изображения:
  - сигнатуры JPEG/PNG/WebP/PDF/SVG (UTF-8, корень `svg` после BOM, декларации и комментариев);
  - размеры из заголовка проверяются до декодирования: больше 40 Мп → 415;
  - декодированный формат обязан совпасть с определённым по сигнатуре, иначе 415 `{allowed}`;
  - EXIF-поворот, вписывание без увеличения, WebP q80.
- SVG (P15, P18, P20, P21):
  - предразбор — линейный токенизатор без возвратных регулярных выражений (порт `infra/svg.ts`): DOCTYPE и `<!…>` запрещены; вложенность ≤ 64; элементов ≤ 5 000; атрибутов ≤ 100 на элемент и ≤ 20 000 всего; `xmlns*` ≤ 32; значение ≤ 64 КиБ; `<` в значении запрещён; список элементов с учётом регистра без префиксов; корень `svg` в пространстве имён SVG без префикса;
  - санитизация DOM (libxml `LIBXML_NONET`, без сущностей) в Sandbox: две очереди (≤ 64 КиБ и крупнее), 1+8, 3 с от постановки;
  - переполнение, срок или превышение пределов → 415 `{allowed, reason:"svg-too-complex"}`; иные нарушения → 415 `{allowed}`;
  - `href` только `#…` (растровый `data:` в `<image>` разрешён); список свойств `style`; fill/stroke/filter/mask/clip-path/marker-* с `\`, `expression(` или `url(`, кроме точного `url(#id)`, удаляются;
  - хранится очищенный документ, его sha256 и размер.
- Риск FrankenPHP: снятие ожидающей задачи при уходе клиента требует обнаружения разрыва без вывода. На Шаге 1 проверить `connection_aborted()` в ожидании; тест «5 оборванных загрузок, затем легитимная < 3 с» в `organizations.test.ts` обязан пройти. Если разрыв не обнаруживается — эскалация контроллеру с замерами, не обход теста.
- Скачивание:
  - ETag из `files.variants`/`files.sha256`;
  - `If-None-Match` сравнивается слабо, принимает `W/`, списки и `*` → 304;
  - `Content-Disposition` по R34: имя = `originalName` без последнего расширения, ведущая точка не считается расширением, расширение по отдаваемому mime;
  - `nosniff`, CSP у SVG;
  - `Cache-Control`: `private, max-age=0, must-revalidate` либо `public, max-age=86400`;
  - объект читается из S3 до установки заголовков.
- Подписанные ссылки: наличие `exp` или `sig` включает режим подписи (права и Bearer игнорируются); `exp` по `^[1-9]\d{0,11}$`, не в прошлом; `sig` — 64 hex нижнего регистра, сравнение в постоянное время; иначе 403. `id`/`variant` проверяются после доступа. Bearer при подписи всё равно учитывается в лимите `user`.
- Видимость организации — своя плюс контрагенты видимых накладных (отправитель — любой статус, получатель — кроме DRAFT); INSPECTOR и ADMIN видят все; удалённые не видны никому. Невидимая → 404, видимая чужая при загрузке логотипа → 403, ADMIN может любую.
- Пользователи:
  - `inviteUser`: ключ `invite:` записывается до строки, `password_hash='!'`;
  - `updateUser`: 404 → 409 INVALID_TRANSITION для INVITED → самоправка `roles`/`isOrgAdmin`/`status` → `notAllowed` даже при текущем значении; блокировка берёт advisory `refresh:` до строки и отзывает токены; без изменений → 200 без аудита;
  - `listUsers` `q` — `position(lower(q) in lower(…))`;
  - сортировка `COLLATE "C"`, затем id.
- `createTelegramCode`: 8 символов `[A-Z0-9]`, один Lua-скрипт (`SET tgcode NX EX 600`, `DEL` прежнего, `SET tgcode-user`); без `TELEGRAM_BOT_TOKEN` → 503 EXTERNAL_UNAVAILABLE `{service: telegram}`.
- Загрузка в MinIO — до транзакции; в транзакции: блокировка владельца, строка `files` (`created_at` = `Tx::now()`), указатель, мягкое удаление прежнего файла (его ссылки → 404).

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel profile.test.ts users.test.ts organizations.test.ts files.test.ts` → FAIL. Pest (портировать случаи `backend-express/test/files-units.test.ts`):
  - `SvgScannerTest` (каждая граница: 64/65, 5 000/5 001, 100/101, 32/33, 64 КиБ, список элементов, префиксы, документ глубиной 10 000 < 200 мс);
  - `SvgSanitizerTest` (враждебные атрибуты, `url(#id)` сохраняется);
  - `LaneTest` с заглушкой-скриптом (срок → kill и новый процесс; 10-я задача при 1+8 → отказ сразу; срок включает ожидание; запуск не засчитывается; снятая ожидающая задача);
  - `ImagesTest`, `ContentDispositionTest` (пример контракта), `FileUrlsTest` (рабочий пример контракта), `MultipartReaderTest`, `QueryReaderTest` (повторы, `+`, точки в именах).
- [ ] **Шаг 2: реализация.** Перечисленные модули и Actions.
- [ ] **Шаг 3: GREEN.** `./at.sh api:test laravel profile.test.ts users.test.ts organizations.test.ts files.test.ts auth.test.ts` → PASS, кроме случаев с операциями поздних задач (список в отчёте). `./at.sh laravel:test` → PASS.
- [ ] **Шаг 4: коммит.** `feat(laravel): profile, users, organizations, files`.

### Task 4: Справочники, администрирование, журнал аудита

**Operations:** listDictionary, createDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry, importDictionary, uploadProductImage, listAdminOrganizations, updateAdminOrganization, approveOrganization, listAuditLog, listPublicRegions.

**tests/api:** `dictionaries.test.ts`, `admin.test.ts`, `audit.test.ts`; `auth.test.ts`, `profile.test.ts`, `users.test.ts`, `organizations.test.ts` и `files.test.ts` — полностью зелёные.

**Interfaces — Produces:**
- `Xlsx\Zip::open(string $bytes): ZipIndex` (Problem 415).
- `XlsxScanner::scan(ZipIndex): FirstSheet`.
- `XlsxReader` — скрипт песочницы `resources/sandbox/xlsx-read.php`, результат `{header, rows:[{number, cells}]}`; ячейка — строка, `INVALID` или `TOO_LONG`.
- `JsNumber::text(float): string`.
- `CsvReader::read(string $bytes): Sheet`.
- `DictionaryStore` — представления и записи пяти справочников.
- `Import::apply(string $name, Sheet $s): ImportReport`.
- `PublicCache::dropForProduct(string $productId)`.

**Port notes:**
- Каждая изменяющая транзакция справочника первой берёт `pg_advisory_xact_lock(hashtext('dictionary:'||name))`.
- Блокировки: строки справочника — `FOR NO KEY UPDATE`; физическое удаление норм и регионов — `FOR UPDATE` (одно из двух мест, где он разрешён); регион — `FOR KEY SHARE`; продукт, показатель, препарат — `FOR SHARE`.
- Удаление и восстановление:
  - REFERENCE_IN_USE `usedBy` учитывает и мягко удалённые поля;
  - восстановление мягко удалённой записи по точному имени (регистрозависимо, D11) пишет `deletedAt: [t, null]`;
  - аудит физического удаления — `[before, null]` по каждому ненулевому полю (D3);
  - запись без изменений не пишет ни строку, ни аудит (D5).
- `includeDeleted` от роли без права или для norms/regions → 400 `notAllowed` даже со значением `false` (D10).
- CSV (D8, R58, R59):
  - разделитель `;`, BOM, кавычки; кавычка внутри некавыченного поля — обычный символ; символ после закрывающей кавычки, кроме `;` и конца строки, → `validation.import.format`; одиночный CR — данные;
  - неверный UTF-8 → 400 `errors.file [validation.import.format]`; NUL-байты → 415;
  - первая строка выигрывает, повторы — ошибки строк;
  - `unchanged` сравнивается численно (bcmath);
  - ключи ошибок строк — D6, порядок по колонкам, дубликат после ошибок значения в той же колонке (D7).
- XLSX (P23–P28), этапы в точном порядке контракта:
  1. Каталог: записей ≤ 64, объявлено ≤ 16 МиБ на запись и ≤ 32 МиБ всего; ZIP64, шифрование и многотомные архивы отклоняются; «не книга»; потолки частей (workbook, rels, styles ≤ 1 МиБ; sharedStrings и первый лист ≤ 16 МиБ).
  2. Каждая запись распаковывается (`inflate_init`/`inflate_add` порциями с потолком «объявлено + 1») с проверкой CRC: больше объявленного → `workbook-too-large`, короче или CRC неверен → `{allowed}`.
  3. Предразбор:
     - линейный сканер, корректность XML с учётом пространств имён, только `strpos`, без PCRE с возвратом;
     - UTF-8 с меткой ровно `UTF-8` (`UTF8` отклоняется), числовые ссылки на символы любой длины, если значение — допустимый Char;
     - `r` строки — положительное целое ≤ 1 048 576, строго возрастает;
     - `r` ячейки — A1 заглавными без `$`, строка совпадает, колонки возрастают, не дальше BL (64);
     - `<row>` ≤ 20 000, `<c>` в строке ≤ 64, `<si>` и run'ов ≤ 200 000;
     - префиксные элементы пространств имён SpreadsheetML main/Strict → `{allowed}`, прочие пространства (x14, xm, mc) игнорируются; в пределах одного элемента «неверный формат» важнее «превышения предела»;
     - первый лист — первый `<sheet>` workbook, цель по правилам OPC (относительно `xl/`, включая `..` и абсолютные пути); не worksheet, внешняя цель или нет части → `{allowed}`.
  4. Чтение в Sandbox (две очереди 1+8, 10 с, `memory_limit` 256M): ячейка длиннее 1 000 кодовых точек → TOO_LONG (`maxLength`), общий текст ≤ 8 МиБ (иначе `workbook-too-large`), но счёт строк продолжается.
  5. tooManyRows.
  6. Заголовок.

  Переполнение очереди → 415 `workbook-too-large`.
- Чтение ячеек (L13): узкая строка дополняется пустыми ячейками; хвостовые пустые отбрасываются; строка с неверным числом ячеек ключа не получает.
- Администрирование:
  - переходы из `entity-state-machines.json`;
  - строка организации блокируется `FOR NO KEY UPDATE` (после complaint, до batches);
  - PLATFORM статус не меняет никогда;
  - `approveOrganization` с неверным id → 404 (D1);
  - параллельные одобрения → один 200 и один 409.
- Инвалидация `pub:batch` (R82, R92): переименование продукта, импорт (все обновлённые продукты), фото продукта всегда, имя или регион организации.
- Журнал аудита: фильтры, равенство `createdAt` разрешается по id по возрастанию в обоих направлениях; INSPECTOR читает.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel dictionaries.test.ts admin.test.ts audit.test.ts` → FAIL. Pest:
  - `XlsxLimitsTest` — порт всех 81 случая `backend-express/test/xlsx-limits.test.ts`; книги собираются в тесте через `ZipArchive` и сырой XML; каждый случай проверяет точный исход и линейное время с запасом `TIMING_SLACK`;
  - `CsvReaderTest`;
  - `JsNumberTest` (`1e21`, `1e-7`, `0.1+0.2`, `-0`, целые).
- [ ] **Шаг 2: реализация.** Справочники, импорт, администрирование, журнал.
- [ ] **Шаг 3: GREEN.** Команды и ожидаемые результаты:
  - `./at.sh api:test laravel dictionaries.test.ts admin.test.ts audit.test.ts auth.test.ts profile.test.ts users.test.ts organizations.test.ts files.test.ts` → PASS (случаи в `files`/`organizations`, зависящие от партий и накладных, — в отчёт);
  - живой замер: `/health/live` ≤ 100 мс во время пяти параллельных «бомб» из `dictionaries.test.ts`; число перезапусков `api-laravel` = 0.
- [ ] **Шаг 4: коммит.** `feat(laravel): dictionaries, admin, audit log`.

### Task 5: Поля и обработки

**Operations:** listFields, createField, getField, updateField, deleteField, listFieldTreatments, createTreatment, updateTreatment.

**tests/api:** `fields.test.ts`.

**Interfaces — Produces:** `Visibility::fieldVisibleTo(Principal): string`; `Locks::field(string $id, string $strength): ?object`, где `$strength ∈ {'for no key update','for key share','for update'}` (последний — только `deleteField`).

**Port notes:**
- Видимость: FARMER — свои поля; INSPECTOR и ADMIN — чтение; остальные — по `x-roles`.
- Запись обработки — только по полю своего хозяйства, даже у FARMER с ролью INSPECTOR; чужое поле → 404 (D14).
- GeoJSON — по общей схеме: пустое кольцо → `minItems` (не 500); незамкнутое кольцо → `errors.geometry`; прочие ошибки геометрии сохраняют свои пути (D12).
- Окно правки 24 ч: `Dates::canEditTreatment` с `createdAt` и `now` = `Tx::now()`; граница включительная; закрыто → 403 `{reason: EDIT_WINDOW_CLOSED}`. Будущий `appliedAt` проверяется по тем же часам.
- Фильтры `from`/`to` — даты UTC (from > to → `errors.from [validation.range]`); `organizationId` для роли без права → `notAllowed` (R51).
- `updateField` без изменений сравнивает геометрию с отсортированными ключами (jsonb переупорядочивает ключи) и ничего не пишет.
- Блокировки:
  - `deleteField` — `FOR UPDATE` поля (ждёт ссылки и исключает новые);
  - `createTreatment` — `FOR NO KEY UPDATE` поля с `deleted_at IS NULL`;
  - `updateTreatment` — поле `FOR KEY SHARE` до обработки;
  - регион — `FOR KEY SHARE`.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel fields.test.ts` → FAIL.
- [ ] **Шаг 2: реализация.** Модуль полей и обработок.
- [ ] **Шаг 3: GREEN.** `./at.sh api:test laravel fields.test.ts` → PASS.
- [ ] **Шаг 4: коммит.** `feat(laravel): fields and treatments`.

### Task 6: Партии, граф, QR, документы, «Меркурий», транспорт событий

**Operations:** createBatch, listBatches, getBatch, getBatchHistory, getBatchPath, getBatchGraph, createBatchQr, downloadBatchQr, putBatchOnSale, markBatchSold, getBatchDocuments, retryBatchVsdImport.

**Infra:** Relay (публикация после ответа), sweeper outbox (как задание планировщика, L5; подключается здесь, планировщик целиком — в Task 9), Consumer, VsdLane, обработчик `vsd.import`.

**tests/api:** `batches.test.ts` (зелёный после Task 7: фикстуры двигают партии накладными), `documents.test.ts` (случай «worker concurrency» зелёный после Task 12).

**Interfaces — Produces:**
- `Visibility::batchVisibleTo(Principal $p, string $alias = 'b'): array{string, array}` (SQL и привязки).
- `BatchView::listItem(object)`, `BatchView::card(object, Principal)` (`actions` = `availableActions` ∩ условия контракта).
- `Lifecycle::transition(object $lockedBatch, string $to, string $reason, ?string $userId): void` (version + 1, строка истории с `Tx::now()`).
- `Lifecycle::notify(string $type, array $recipients, array $payload): void` (outbox `notification.dispatch`).
- `Locks::batches(array $ids): array`.
- `Path::stages(object $batch): array`.
- `Relay::publish(array $eventIds): void`.
- `Publisher::publish(string $exchange, string $routingKey, string $body, string $messageId, bool $mandatory): void` (confirm; Problem/исключение при return или nack).
- Consumer: `Consumer::run(array $handlers)`, где `$handlers` — `[type => EventHandler]`; `interface EventHandler { public function handle(\stdClass $envelope): void; }`.
- `Claim::event(string $eventId): bool` (внутри `Tx::run`).
- `PublicCache::dropCodes(array)`.

**Port notes:**
- Видимость (R54/D14):
  - INSPECTOR и ADMIN — все;
  - LAB — партии с неудалённым анализом своей лаборатории;
  - FARMER, PROCESSOR, RETAILER — S ∪ N: S — происхождение или держатель, а также отправитель или получатель неудалённых накладных SENT/ACCEPTED/REJECTED; N — прямые родители и дети в `batch_links`;
  - роли объединяются.
- Список: фильтры R49/R51 (`orgId` только INSPECTOR/ADMIN, `holder`/`origin=me`); `from`/`to` по `harvestedAt|producedAt`; `q`; `x-sort` с `COLLATE "C"` и null в конце; равенство по id.
- createBatch:
  - массы — ровно 3 знака (`validation.mass.format`);
  - поле читается `FOR KEY SHARE … AND deleted_at IS NULL` (удалённое → 400 `fieldId notFound`, m2);
  - `harvestedAt` сравнивается с `Tx::now()`;
  - код `next_batch_code()`;
  - BR-03 через `Rules::requiresLabTest` (число партий хозяйства, рейтинг, препараты в [now−30d, now]);
  - лаборатория (D18): наименее загруженная ACTIVE, сначала регион, равенство по коду точки id; нет лаборатории → 409 NO_LAB_AVAILABLE с полным откатом;
  - LAB_ASSIGNED `{orgIds: [lab, origin]}`;
  - DAIRY/MEAT → `batch_documents` PENDING + outbox `vsd.import` в той же транзакции.
- Граф: `depth` 1..5, иначе `validation.range`; BFS в обе стороны с наименьшим `|depth|`; без братьев; удалённые партии пропускаются (не проходятся насквозь); флаги `accessible`; порядки контракта.
- Путь (R45): от `harvestedAt`/`producedAt`; равенство `acceptedAt` — по номеру накладной (`C`). История — равенство по id вставки.
- on-sale (R20) — только из Accepted у RETAILER-держателя; sold. Порядок: блокировка → 404 → NOT_HOLDER → If-Match CAS → INVALID_TRANSITION.
- If-Match: ошибки `errors["If-Match"]` — `required`/`type`/`min` (`0` → `min`), сливаются с ошибками тела (P36).
- QR (R43, R44, контракт):
  - PNG ровно 1024×1024, уровень коррекции M, поле 4 модуля, чёрный на белом (endroid с `RoundBlockSizeMode::None` либо отрисовка матрицы в GD с проверкой размеров);
  - PDF — этикетка A6 (QR, `publicCode`, продукт, организация-создатель; шрифт с кириллицей);
  - рендер и MinIO — до транзакции; права повторно проверяются по заблокированной строке;
  - файлы вида QR `{code}.png/.pdf`; прежние мягко удаляются; `qrGeneratedAt = Tx::now()`; `version` не меняется;
  - `Content-Disposition: inline; filename="{code}.png"`; до генерации → 404.
- Документы (R91): `labProtocols` — только видимые вызывающему анализы (LAB — свои); `qr` — только если вызывающий может скачать QR; иначе пусто или null.
- retry VSD: x-idempotent; 404 → NOT_HOLDER → 404 без строки VSD → INVALID_TRANSITION из IMPORTED/PENDING; сброс строки, аудит, `vsd.import`.
- Обработчик `vsd.import` — дословно по `vsd.import.schema.json`:
  - строка не PENDING → пустая транзакция с захватом события;
  - NULL `mercury_code` → NOT_FOUND без обращения;
  - запрос: productCode, senderInn происхождения, окно `harvested_at ± 3` дня UTC;
  - 6 обращений с паузами `MERCURY_RETRY_BASE_MS`·2^k (по умолчанию 2…32 с), тайм-аут 10 с, `X-Mock-Fail: <MERCURY_FAIL_MODE>` для кодов из `MERCURY_FAIL_PRODUCT_CODES` (P35);
  - каждая неудача — короткая транзакция `attempts+1`, `last_error` ≤ 500 символов;
  - выбор документа: наибольший `issueDate`, затем `number`, затем `uuid` среди CONFIRMED;
  - итог — одна транзакция: захват → строка `FOR NO KEY UPDATE`, пока PENDING → аудит `system.vsdImport`; затем ack.
- Consumer (L1, L2):
  - один канал, prefetch 1, confirm-канал;
  - флок `VsdLane` неблокирующий: занят → копия в `agrotrace.laravel.jobs.delay` (тело, `message_id`, `content_type`, `persistent`, `mandatory=true`) → дождаться confirm → ack;
  - `basic.return` или nack → без ack, лог уровня error, через 1 с `basic.nack requeue=true`;
  - неудача обработчика → повторы в процессе через 2/4/8/16/32 с, затем `basic.reject(false)`;
  - канал, закрытый брокером, переоткрывается через 1 с;
  - SIGTERM: отменить потребление, завершить текущий обработчик, ack, закрыть.
- Relay: после ответа (Octane `terminate`, ids из контекста) публикация с confirm, затем `UPDATE outbox_events SET published_at=now(), attempts=attempts+1 WHERE id=$1 AND published_at IS NULL`. Тайм-аут confirm 10 с → канал закрыть, строку оставить sweeper. Соединение AMQP — одно ленивое на Octane-воркер с переподключением.
- Sweeper (каждые 5 с): `pg_try_advisory_lock(hashtext('agrotrace.outbox.laravel'))`; `WHERE backend='laravel' AND published_at IS NULL ORDER BY created_at FOR NO KEY UPDATE SKIP LOCKED LIMIT 100`; хранение по R59 — опубликованные старше 7 дней, `processed_events` старше 30 дней.
- `pub:batch` удаляется после коммита каждой операцией, меняющей статус, держателя, `labSummary` или путь.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel batches.test.ts documents.test.ts` → FAIL. Pest:
  - `ConsumerTest` на поддельном брокере: занятый `vsd.import` → публикация в delay, затем ack и никакого nack; `return` до confirm → без ack, nack через ~1 с; прочие события идут; повтор и reject; порядок остановки;
  - `PickVsdTest`;
  - `QrTest` (размеры PNG);
  - `OutboxSweepTest` (выборка только `backend='laravel'`, `SKIP LOCKED`, хранение R59).
- [ ] **Шаг 2: реализация.** Модули партий и документов, транспорт событий; сервис `worker-laravel` (supervisord); класс задания `Scheduler\Jobs\OutboxSweep`. Его расписание (каждые 5 с) подключает Task 9 вместе с каркасом планировщика; до этого публикацию обеспечивает relay после ответа.
- [ ] **Шаг 3: GREEN.** `./at.sh api:test laravel documents.test.ts batches.test.ts` → PASS, кроме случаев с накладными (Task 7) и «worker concurrency» (Task 12), — список в отчёте. `./at.sh laravel:test` → PASS.
- [ ] **Шаг 4: коммит.** `feat(laravel): batches, graph, qr, documents, event transport`.

### Task 7: Накладные, идемпотентность, If-Match

**Operations:** createWaybill, getWaybill, listWaybills, sendWaybill, acceptWaybill, rejectWaybill, deleteWaybill.

**tests/api:** `waybills.test.ts`, `batches.test.ts` — полностью зелёные.

**Interfaces — Produces:**
- Middleware `idempotency` (после `operation`, до FormRequest).
- `IdemStore` — интерфейс: `claim`, `get`, `complete`, `release`; реализация на Redis и в памяти для Pest.
- `Redis\Scripts::IDEM_COMPLETE`, `IDEM_RELEASE` (тексты Lua).
- `IfMatch::read(Request): ?int` (ошибки в общую карту); `IfMatch::check(object $locked, int $expected): void` (409 `{currentVersion}`).
- `Locks::waybill(string $id): ?object`, `Locks::recallTasks(array $ids): array`.

**Port notes:**
- Идемпотентность (R48, R53, I1 T6-7):
  - ключ проверяется через `Idempotency::decision` (`^[A-Za-z0-9_-]{8,128}$`), иначе 400 INVALID_IDEMPOTENCY_KEY;
  - claim `SET NX EX 60`; запись есть: другой отпечаток → 409 REUSED, pending → 409 IN_PROGRESS + `Retry-After: 1`, done → сохранённые статус и тело заново (`Content-Type: application/json`, `Idempotent-Replayed: true`); ключ истёк между SET и GET → один повтор claim;
  - владелец фиксирует запись до возврата ответа из middleware: 2xx → Lua complete (сохраняется разобранное тело с объектами), иначе Lua release;
  - разрыв клиента ничего не решает (никаких слушателей `terminate`, освобождающих ключ); владелец без ответа оставляет pending до TTL;
  - отпечаток считается от сырых байт тела, ещё до разбора JSON.
- Отправка (D6): по позициям в порядке `publicCode` — NOT_HOLDER → BR-06 → INVALID_TRANSITION `{from,to,publicCode}` → BR-01 для RAW через `Rules::checkWaitingPeriod` (учитывает и удалённое поле, R21). WAYBILL_INCOMING; кеш страниц сбрасывается.
- Создание: идемпотентно; партии блокируются; одна 400 со всеми ссылочными ошибками, включая `items[i].batchId duplicate` (шаг 2, P36); NOT_HOLDER в порядке запроса.
- Приёмка: повтор позиции → `items [validation.items.mismatch]` на шаге 6, после 404/403/409 (P36); затем BR-06 → INVALID_TRANSITION → BR-07 через `Rules::checkDiscrepancy` (акт обязателен при расхождении больше 2 %); смена держателя и массы; акты сохраняются.
- Отклонение: InTransit → Approved. R50c: OPEN/OVERDUE задачи получателя на Recalled-партиях передаются отправителю (version + 1, RECALL_TASK REASSIGNED), задачи блокируются после партий.
- Удаление: блокировка → 404 → NOT_SENDER → If-Match → только DRAFT, мягкое удаление + аудит.
- Список: только участники (направление, R51), `counterpartyOrgId`, `status`, `from`/`to`, `q` по номеру и `publicCode`.
- Гонки: два `sendWaybill` по одной партии → один 200; accept против отзыва → отзыв выигрывает, accept → 422 BR-06 `{publicCode, status: Recalled}` (P39, проверяется в Task 10).

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel waybills.test.ts` → FAIL. Pest:
  - `IdempotencyTest` с хранилищем в памяти: 5xx и 4xx освобождают, REUSED, IN_PROGRESS, разрыв оставляет pending, повтор после завершения воспроизводит ответ ровно один раз;
  - `LuaParityTest` (в `php-tools`): тексты скриптов совпадают с константами `backend-express/src/http/idempotency.ts`.
- [ ] **Шаг 2: реализация.** Накладные, middleware идемпотентности, If-Match, помощники блокировок.
- [ ] **Шаг 3: GREEN.** `./at.sh api:test laravel waybills.test.ts batches.test.ts documents.test.ts` → PASS, кроме случая «worker concurrency».
- [ ] **Шаг 4: коммит.** `feat(laravel): waybills, idempotency, locking`.

### Task 8: Переработка

**Operations:** processBatches.

**tests/api:** `processing.test.ts`.

**Interfaces — Consumes:** `Locks::batches`, `Rules::checkMassBalance`/`canUseAsInput`, `Lifecycle::transition`. **Produces:** `Actions\Processing\ProcessBatches`.

**Port notes:**
- Порядок проверок:
  1. Тело; повтор `batchId` → шаг 1 `inputs[i].batchId duplicate`.
  2. `Locks::batches(inputs)`.
  3. Одна 400 по ссылкам: вход неизвестен, удалён или невидим → `notFound`; `massUsedKg` больше массы → `mass.exceedsBatch`; продукт выхода неизвестен → `notFound`. Продукты блокируются `FOR SHARE` после партий.
  4. По каждому входу в порядке запроса: NOT_HOLDER → BR-06 → BR-05 → BR-04 (`params inputKg/allowedKg/outputKg` — строки `MassTotal` из домена, bcmath).
- Результат:
  - входы → Processed (version + 1, масса сохраняется);
  - выходы — DERIVED в порядке запроса, `producedAt = Tx::now()` (общий для всех), история null → Created → Approved (TEST_NOT_REQUIRED), version 2;
  - `batch_links` на каждую пару (вход, выход) с полным `massUsedKg` (D20);
  - защитная проверка GRAPH_CYCLE — рекурсивный обход вверх;
  - аудит выхода с `parents [{batchId, massUsedKg}]`;
  - `pub:batch` входов сбрасывается.
- Гонка processing против send: один успех; проигравший — 409 INVALID_TRANSITION или 422 BR-05 `{status: InTransit}`.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel processing.test.ts` → FAIL.
- [ ] **Шаг 2: реализация.** `Actions\Processing\ProcessBatches`.
- [ ] **Шаг 3: GREEN.** `./at.sh api:test laravel processing.test.ts` → PASS.
- [ ] **Шаг 4: коммит.** `feat(laravel): processing`.

### Task 9: Лаборатория, ядро движка отзыва, планировщик

**Operations:** listLabTests, createLabTest, getLabTest, registerLabSample, submitLabResults, uploadLabProtocol, downloadLabProtocol. **Scheduler:** весь каркас L5 и задание `lab-escalation`.

**tests/api:** `lab.test.ts` (и проход с `--tz Europe/Moscow`).

**Interfaces — Produces:**
- `Recalls\Engine::RECALL_TX(): TxOptions` (REPEATABLE READ + `retryIf` 23505 `ux_recalls_open_source`).
- `Engine::findOpen(string $sourceBatchId): ?object`.
- `RecallScope::of(string $sourceBatchId, bool $blockUpstream): array` (сырой `WITH RECURSIVE` по §7.6, глубина ≤ 20; SOURCE и члены по id).
- `Engine::apply(array $req, array $members, array $lockedById): RecallOutcome` и `Engine::start(array $req): RecallOutcome`, где `RecallOutcome{recallId, created, closed, changedCodes, taskIds, eventIds}`.
- `Scheduler\Tick::frequency(int $ms): string` (метод события Scheduler или cron; иначе исключение конфигурации → 78).
- `Tick::locked(string $job, callable $fn): bool`.
- `Lab\Assign::insertUnplanned(...)` — используется в Task 11.

**Port notes:**
- Видимость анализов: удалённые анализы и анализы удалённых партий не видны никому; LAB видит свою лабораторию; участник — `batchVisibleTo` без роли LAB. Мутации — только своей лаборатории (404).
- Список: `overdue` по часам БД; `labOrgId` для роли без права → `notAllowed`; `batchId` по невидимой партии → пустая страница; `from`/`to` по дате UTC `createdAt`.
- Карточка: нормы — текущие (неудалённые показатели) до DONE, затем снимок результата; порядок `name COLLATE "C"`, id; `actions` — только LAB своей лаборатории.
- `createLabTest`: одна 400 по ссылкам (организация не ACTIVE → `notFound`, не LAB → `validation.labOrg.type`); `dueAt = Dates::addWorkingDays(['from' => Iso::fromPg(Tx::now()), 'days' => 5])['result']`; LAB_ASSIGNED.
- `registerLabSample`: тело отсутствует → `{}`; только из QUEUED.
- `submitLabResults` в `RECALL_TX`:
  1. тело и If-Match одной 400;
  2. блокировка анализа → 404 → CAS → статус;
  3. шаг 5 одной 400: каждый повтор → `results[i].indicatorId duplicate`; набор не равен текущим нормам (в том числе продукт без норм) → `results validation.results.mismatch`;
  4. `concludeLabTest` (BR-02, строго `>`);
  5. блокировка партии; при FAIL ещё и область отзыва, если открытого отзыва нет, — одним запросом;
  6. `lab_results` со снимком нормы;
  7. OnTest: PASS → Approved (LAB_PASS) либо FAIL → Blocked (LAB_FAIL) → открытый отзыв переиспользуется или `Engine::apply` (trigger LAB);
  8. DONE, `sampled_at = coalesce(sampled_at, now())`, `recall_id` (R57), version + 1;
  9. LAB_RESULT: организации происхождения и держателя, если другой; плюс роль INSPECTOR для анализов INSPECTOR/COMPLAINT;
  10. `rating.recalculate` для FARM-происхождения;
  11. `pub:batch` сбрасывается после каждого результата.

  Нормы читаются без блокировки (D7).
- Протокол: PDF ≤ 10 485 760 включительно; замена мягко удаляет прежний; version не меняется.
- Ядро отзыва:
  - обход идёт сквозь мягко удалённые партии, но они не становятся членами; UP исключает найденное DOWN;
  - статусы — по примечанию к §5.1;
  - задача — держателю, у InTransit — получателю SENT-накладной; `dueAt = Dates::recallTaskDueAt(opened_at)`;
  - без задач → сразу CLOSED (`closed_at = opened_at`, version 2) + `notification.dispatch` RECALL CLOSED инспекторам в той же транзакции;
  - `recall.requested` пишется всегда;
  - аудит batch/recallTask/recall с `action` = вызывающая операция.
- Эскалация: `status IN (QUEUED,SAMPLED) AND due_at < now() AND deleted_at IS NULL` с неудалённой партией, `FOR NO KEY UPDATE SKIP LOCKED` → ESCALATED; `escalated_at = now()`; аудит `system.labTestEscalate` (actor null); outbox `lab.escalate` (`requestId` null).
- Часы планировщик не подменяет: тесты переносят `due_at` (санкционированная запись) и ждут тика в 1 с.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel lab.test.ts` → FAIL. Pest:
  - `TickTest`: 1000 → `everySecond`, 5000 → `everyFiveSeconds`, 300000 → `everyFiveMinutes`, 7000 → исключение; блокировка занята в другом сеансе → тик пропущен; при старте каждое задание выполняется ровно один раз.
- [ ] **Шаг 2: реализация.** Лаборатория, ядро отзыва, `scheduler-laravel` (`agrotrace:schedule`).
- [ ] **Шаг 3: GREEN.** `./at.sh api:test laravel lab.test.ts processing.test.ts waybills.test.ts` → PASS; `./at.sh api:test laravel --tz Europe/Moscow lab.test.ts` → PASS.
- [ ] **Шаг 4: коммиты.** `feat(laravel): recall engine core` и `feat(laravel): lab tests, scheduler and escalation`.

### Task 10: Движок отзыва и задачи изъятия

**Operations:** createRecall, listRecalls, getRecall, getRecallGraph, listRecallTasks, confirmRecallTask. **Scheduler:** `recall-task-overdue`. **Consumers:** `recall.requested`, `rating.recalculate`.

**tests/api:** `recalls.test.ts`, `locks.test.ts`.

**Interfaces — Produces:**
- `Notifications\Insert::rows(string $type, array $recipients, \stdClass $payload): array` — раскрытие получателей (`Insert::expand`) и вставка строк IN_APP/PENDING по алгоритму `notification.dispatch.schema.json`; возвращает id строк PENDING. Их отправку добавляет Task 12.
- `Rating::recalculate(string $orgId): array` (`{before, after, changed}`, блокирует организацию, только FARM, аудит `system.ratingRecalculate`).
- `Rating::fold(string $orgId): int`.
- `RecallView::card/items/tasks/graph`, `ActorRefs::of(array $ids)`.

**Port notes:**
- Порядки:
  - члены: SOURCE, DOWN, UP → глубина → `publicCode` (`C`);
  - задачи: `dueAt` → `publicCode`;
  - рёбра графа: родитель, затем ребёнок по `publicCode`;
  - `overdue` по часам БД.
- createRecall: тело → неудалённый источник, иначе 400 `sourceBatchId notFound` → `Engine::start` в `RECALL_TX` (UP при `blockUpstream`). Новый → 201; открытый уже есть → 200 без изменений.
- listRecallTasks: держатели — своя организация; INSPECTOR — все; `holderOrgId` только для INSPECTOR, иначе `notAllowed`. Задачи удалённых отзывов скрыты и не подтверждаются (404).
- confirmRecallTask:
  1. x-idempotent; тело и If-Match одной 400;
  2. задача читается без блокировки → отзыв `FOR NO KEY UPDATE` → партия → задача (R52, P57);
  3. 404 для другого держателя;
  4. CAS;
  5. CONFIRMED → `{from: CONFIRMED, to: CONFIRMED}`; партия не Recalled → `{from, to: WrittenOff, publicCode}`;
  6. задача CONFIRMED, партия WrittenOff, аудит;
  7. последняя задача закрывает отзыв (`closedAt` = `confirmedAt`, тот же `now()`, P43) + RECALL CLOSED.

  Две последние задачи параллельно → ровно одно закрытие, одна строка outbox и одна строка аудита.
- Просрочка: `status=OPEN AND due_at < now()` по неудалённым отзывам (M5), `FOR NO KEY UPDATE SKIP LOCKED` → OVERDUE; `escalated_at`, version + 1; аудит `system.recallTaskOverdue`; OVERDUE `{orgIds:[holder], roles:[INSPECTOR]}`.
- `recall.requested` — одна транзакция с захватом события:
  - OPENED (инспекторы, держатели задач, происхождение источника) — только пока отзыв OPEN, не удалён и имеет задачи (R89, M6);
  - RECALL_TASK CREATED на каждую задачу;
  - `rating.recalculate {RECALL_SOURCE}` для FARM с `requestId` обрабатываемого события; публикация после коммита.
- Рейтинг BR-09 — полная свёртка: события по времени, лабораторные раньше отзывных, затем id (`C`). Повторная обработка не меняет результат (не дельта).
- `locks.test.ts`:
  - confirmRecallTask ∥ submitLabResults (FAIL с переиспользованием открытого отзыва) — оба 200 без дедлока;
  - createBatch ∥ deleteField — 204 и 400.

  Оба случая проверяют силу блокировок Tasks 5, 6, 9.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel recalls.test.ts locks.test.ts` → FAIL.
- [ ] **Шаг 2: реализация.** Отзывы, задачи, задание просрочки, обработчики событий, рейтинг.
- [ ] **Шаг 3: GREEN.** `./at.sh api:test laravel recalls.test.ts locks.test.ts lab.test.ts waybills.test.ts` → PASS. В postgres-логе нет `deadlock detected` за прогон (`docker compose logs postgres | grep -c deadlock` не растёт).
- [ ] **Шаг 4: коммит.** `feat(laravel): recall engine`.

### Task 11: Жалобы и публичная часть

**Operations:** listComplaints, getComplaint, startComplaintReview, decideComplaint, getPublicBatch, createPublicComplaint, getCaptchaChallenge.

**tests/api:** `complaints.test.ts`, `public.test.ts`; `--ratelimits` (complaint-ip).

**Interfaces — Produces:**
- `Security\Altcha::key(string $jwtSecret): string`.
- `Altcha::challenge(string $key, int $nowMs): array`.
- `Altcha::verify(string $key, string $payload, int $nowMs): ?string` (подпись решения или null).
- `PublicBatchBuilder::build(string $publicCode): ?string` (точные байты JSON).

**Port notes:**
- ALTCHA (P40, M7):
  - ключ = hex(HMAC-SHA256(JWT_SECRET, "agrotrace:altcha:v1")), используется как строка UTF-8;
  - salt — 24 hex + `?expires=` + (сейчас + 600); `maxnumber` 100 000;
  - каноничный base64 с дополнением: длина кратна 4, алфавит RFC 4648 §4, обратное кодирование совпадает;
  - JSON-объект; `algorithm` ровно `SHA-256`; challenge и signature — 64 hex нижнего регистра;
  - `number` — неотрицательное целое, исходный токен которого (последний член `number` верхнего уровня, найденный минимальным токенизатором с раскрытием escape в ключах) соответствует `^(0|[1-9][0-9]*)$`: `json_decode` превращает `-0` в 0, а `12345.0` — в float;
  - `expires` (1–12 цифр) обязателен; `expires·1000 < nowMs` → истекло;
  - `sha256(salt + number) = challenge`; подпись сравнивается в постоянное время.
- getCaptchaChallenge: `Cache-Control: no-store`.
- createPublicComplaint — порядок:
  1. лимит complaint-ip;
  2. одна 400 (шаблон `publicCode` + тело);
  3. CAPTCHA_FAILED;
  4. 404 (решение не расходуется);
  5. `SET altcha-used:{signature} NX EX 600`; ключ уже есть → CAPTCHA_FAILED;
  6. жалоба NEW + аудит (`actor` null, `ip`) + COMPLAINT инспекторам.

  Два параллельных запроса с одним решением → один 201 и один 400.
- getPublicBatch:
  - шаблон → 400;
  - попадание в Redis → сохранённые байты как есть (без разбора, `Content-Type` JSON);
  - промах → построение (продукт, происхождение с регионом, даты, путь, `labSummary` из DONE по `completedAt`, id, `safety`) → `SET EX 300` → повторное чтение `version`; изменилась → `DEL` (M10);
  - персональных данных нет; id фото продуктов — из сида как есть (P32).
- Жалобы:
  - список и карточка; review только из NEW (инспектор = пользователь);
  - decide: предварительный проход `labOrgId`/`blockUpstream notAllowed`, LAB_TEST без `labOrgId` → required, нет `decision` → required (P42, P44) → блокировка жалобы → 404 → DECIDED → проверка лаборатории для LAB_TEST (notFound или `labOrg.type`);
  - LAB_TEST → `Lab\Assign::insertUnplanned` + LAB_ASSIGNED (reason COMPLAINT);
  - RECALL → `Engine::start` в `RECALL_TX` с `complaintId`, reason = comment, переиспользование открытого; страницы сбрасываются; `recall.requested` после коммита.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel complaints.test.ts public.test.ts` → FAIL. Pest: `AltchaTest` — dataset всех случаев `contracts/rules/altcha.json` (ключ, challenge, подпись, вердикт при `nowMs`) плюс `-0`, ключ `"\u006eumber"`, дублированный `number`.
- [ ] **Шаг 2: реализация.** Жалобы, публичная страница, ALTCHA.
- [ ] **Шаг 3: GREEN.** `./at.sh api:test laravel complaints.test.ts public.test.ts` → PASS; `./at.sh api:test laravel --ratelimits` → все тесты `[ratelimit]` (4) зелёные.
- [ ] **Шаг 4: коммит.** `feat(laravel): complaints and public pages`.

### Task 12: Уведомления, доставка, SSE, поллер Telegram

**Operations:** listNotifications, markNotificationsRead, streamEvents. **Consumers:** `notification.dispatch`, `lab.escalate`. **Scheduler:** `notification-delivery`. **Processes:** `agrotrace:sse-hub`, `agrotrace:telegram-poll`.

**tests/api:** `notifications.test.ts`, `events.test.ts`; `documents.test.ts` полностью (worker concurrency).

**Interfaces — Produces:**
- Consumes: `Notifications\Insert::rows`/`expand` из Task 10 (userIds; `orgIds` — все пользователи; `orgHeadIds` — `is_org_admin`; `roles`; только ACTIVE и неудалённые; без повторов).
- `Delivery::sendOwn(array $pendingIds): void` и `Delivery::sweep(): void`.
- `Telegram::sendMessage(...)` и `getUpdates(...)`.
- `Sse\StreamController::open(Request): Response`.
- `RespSubscriber::subscribe(array $channels)` и `next(float $timeoutSec): ?array`.
- `SseHub` (команда): канал пользователя `agrotrace:laravel:sse:user:{userId}`, полезная нагрузка — исходная из NOTIFY; управляющий канал `{type: "resync", gen, lostAt}`.

**Port notes:**
- `notification.dispatch`:
  - захват события → строка IN_APP DELIVERED на каждого пользователя (NOTIFY шлёт триггер);
  - EMAIL PENDING, если `channels.email` или тип принудительный (RECALL, RECALL_TASK, OVERDUE);
  - TELEGRAM PENDING, если Telegram привязан и (`channels.telegram` или тип принудительный);
  - ключи payload — ровно по `notifications.json`.

  `lab.escalate` → LAB_OVERDUE: `orgHeadIds [lab]` + `roles [INSPECTOR]`, payload = данные события + `labName`.
- Доставка (P45, P49, N5):
  - после коммита и ack процесс-потребитель отправляет только свои PENDING-строки, по одной;
  - захват перед первой попыткой — автокоммит `UPDATE notifications SET claimed_at=now() WHERE id=:id AND delivery_status='PENDING' AND (claimed_at IS NULL OR claimed_at < now()-interval '5 minutes') RETURNING claimed_at::text`;
  - метка — этот текст как есть; продление и все записи — `… AND claimed_at = :stamp::timestamptz AND delivery_status='PENDING'`; ноль строк → остановиться без отправки;
  - метка никогда не проходит через модель Eloquent;
  - `attempts` сохраняется после каждой неудачи;
  - 3 попытки, ожидания 1 с и 2 с;
  - срок попытки 30 с — `pcntl_alarm(30)` с асинхронными сигналами, плюс тайм-ауты сокета SMTP 10 с и Guzzle Telegram 10 с;
  - нет `SMTP_HOST` или токена → NOT_CONFIGURED без попыток; отвязанный Telegram → FAILED с 0 попыток;
  - задание `notification-delivery` берёт строки с `coalesce(claimed_at, created_at) < now() - 5 min` с тем же захватом и продолжает их бюджет.
- Поллер Telegram:
  - `SET tg:poller <laravel:host:pid> NX EX 30`; продление каждые 10 с Lua из таблицы контракта; 0 → прекратить опрос;
  - `getUpdates` с long poll 25 с; `/start <code>` → `GETDEL tgcode:{code}` → `users.telegram_chat_id`;
  - смещение продвигается после обработки; пауза 1 с после немедленного пустого ответа; ключ освобождается при остановке; без токена не запускается.
- markNotificationsRead: `ids` — каждый своя IN_APP-строка, иначе `ids[i] validation.notFound` и ничего не отмечается; `upToSeq`; идемпотентно; `pg_notify('notifications', '{"user_id":…,"unread":true}')` в транзакции; аудита нет. listNotifications: `isRead`, `type` (повторяемый), `from`/`to` UTC, сортировка по `seq` с равенством по id.
- SSE — последовательность подключения:
  1. 401 problem до потока, если `access_token` недействителен (Authorization игнорируется);
  2. лимит `user`;
  3. заголовки `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`;
  4. подписка на канал пользователя (живые события буферизуются) и чтение поколения;
  5. повтор: для L — `seq > L` плюс непрочитанные `seq < L`, созданные не раньше чем за 60 с до строки L (нет строки L — только `seq > L`); `Last-Event-ID` важнее `lastEventId`; не число или больше 18 цифр — считается отсутствующим;
  6. W = max(L, максимальный `seq` пользователя);
  7. сброс буфера с дедупликацией по id;
  8. `unread`;
  9. поколение изменилось за время подключения → догон тем же запросом (N1);
  10. `DB::disconnect()` и освобождение слота.

  Дальше:
  - событие с `id` → `notification` (`id:` = `seq`), затем `unread`; без `id` → только `unread`;
  - `ping` каждые 25 с, `ts` без мс;
  - в момент `exp` токена → `reauth {"reason":"TOKEN_EXPIRED"}` и конец потока;
  - ошибка записи или `connection_aborted()` → конец;
  - сообщение `resync` → строки `seq > W` плюс непрочитанные `seq < W`, созданные не раньше чем за 60 с до `lostAt`; история повторно не отправляется;
  - потеря подписки Redis → та же процедура с моментом потери самого потока.

  Повтор без потолка (P53); возможен повтор в окне 60 с при переподключении (P46).
- Хаб:
  - отдельное соединение PDO с TCP keepalive, без пула;
  - `LISTEN notifications`; каждые 30 с повторяется тот же оператор как проверка живости (тайм-аут 10 с);
  - ошибка → переподключение с нарастающей паузой, затем `INCR` поколения, `SET lostAt` и публикация `resync`;
  - последний оператор сеанса всегда `LISTEN notifications`; других запросов на этом соединении нет.
- Санкционированные записи стенда (P48) реализация обязана выдерживать: прямой INSERT в `notifications` «другой реализацией», `published_at = NULL` + удаление `processed_events`, `pg_terminate_backend` сеанса LISTEN.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel notifications.test.ts events.test.ts documents.test.ts` → FAIL. Pest:
  - `DeliveryTest`: захват потерян на попытке 2 → одна отправка, ничего не записано; зависшая отправка → FAILED после 3 попыток по сроку; продолжение бюджета захваченной строки; метка с микросекундами совпадает;
  - `RespSubscriberTest` (фрагментированные RESP-кадры, тайм-аут);
  - `SseFrameTest` (формат `id/event/data`, JSON в одну строку);
  - `TelegramPollerTest` (Lua продления, смещение).
- [ ] **Шаг 2: проверка потоковой отдачи.** Первое событие `unread` приходит до конца потока: `curl -N` через `api-laravel:8000`, время до первого байта < 1 с. Если Octane или FrankenPHP буферизует ответ, запасной путь — маршрут `/api/v1/events/stream` в Caddyfile на FrankenPHP в классическом режиме (`php_server` с отдельным фронт-контроллером Laravel). Решение и замеры — в отчёт.
- [ ] **Шаг 3: реализация.** Уведомления, доставка, SSE, хаб, поллер Telegram.
- [ ] **Шаг 4: GREEN.** `./at.sh api:test laravel notifications.test.ts events.test.ts documents.test.ts` → PASS. Во время прогона `SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'agrotrace-laravel%'` ≤ 20.
- [ ] **Шаг 5: коммит.** `feat(laravel): notifications, delivery, sse`.

### Task 13: Аналитика и отчёты

**Operations:** getDashboard, downloadReport.

**tests/api:** `analytics.test.ts`, `reports.test.ts`.

**Interfaces — Produces:**
- `Analytics\Window::resolve(?string $from, ?string $to, string $snapshotDate): array` (Problem 400).
- `Dashboard::inspector/org/lab(Principal, array $window): array` (в одном снимке).
- `Reports\Sheets::build(string $type, array $params, Principal): ReportData` (`{sheets:[{name, columns:[{title,type}], rows}]}`).
- Скрипт песочницы `resources/sandbox/report-render.php` (вход — ReportData JSON, выход — байты).
- `Reports\Queue::admit(): Ticket` (Problem 503 report-busy).

**Port notes:**
- Дашборд:
  - `scope`: нет → required; неизвестное → enum; не та роль → `validation.scope.notAllowed`; вместе с ошибками окна (`range`, `range.tooLong` больше 366 дней) — одна 400;
  - окно по умолчанию — 30 дней до даты снимка UTC; при одном заданном конце второй — на 29 дней от него;
  - все числа — из одного снимка `READ ONLY REPEATABLE READ` с его `now()` (P43);
  - доли через `Decimal::ratioPercent2` (bcmath); часы — `floor(extract(epoch …))` в SQL;
  - `rejectedShare` упорядочен по округлённой доле (P47);
  - задачи удалённых отзывов и партий и анализы удалённых партий исключены.
- Отчёты:
  - порядок: перечисление `type` (400) → `x-report-access` из контракта (полные роли или руководитель headRole, иначе 403 без `params`) → параметры одной 400 → 404 (отзыв или организация нет или удалены) → допуск в очередь (полна → 503 BACKEND_UNAVAILABLE `{reason: "report-busy"}` до чтения данных) → данные (не больше `REPORT_MAX_ROWS` + 1 строк на лист; больше → `errors.type [validation.report.tooManyRows]`) → рендер в Sandbox (`memory_limit` 1G, 1 выполняемый + 4 ожидающих на контейнер, 120 с с ожиданием; переполнение, срок или сбой → 503 report-busy; ушедший клиент освобождает место);
  - листы, колонки, порядки и типы ячеек — по `reports.yaml`;
  - XLSX (PhpSpreadsheet): жирный заголовок, `numFmt` `0`/`0.000`/`0.00`, числа — числовые ячейки (в листах «Поле | Значение» счётчики и рейтинг тоже числа); моменты — `YYYY-MM-DD HH:MM` UTC (усечение до минут, R59);
  - PDF (dompdf): A4 альбомная, шрифт с кириллицей, заголовок таблицы на каждой странице, разрыв длинных слов;
  - заголовки: `Content-Disposition` из контракта (обе формы), `Cache-Control: no-store`, `Content-Length`.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel analytics.test.ts reports.test.ts` → FAIL. Pest:
  - `WindowTest`;
  - `ReportRenderTest` (XLSX читается обратно: типы ячеек и форматы; PDF начинается с `%PDF-`);
  - `ReportQueueTest` (5-й ожидающий → 503 до данных; срок).
- [ ] **Шаг 2: реализация.** Дашборды, листы отчётов, рендер и очередь.
- [ ] **Шаг 3: GREEN.** `./at.sh api:test laravel analytics.test.ts reports.test.ts` → PASS.
- [ ] **Шаг 4: коммит.** `feat(laravel): dashboards and reports`.

### Task 14: Сквозные проверки, метрики, CI, кросс-backend, финал

**Files:**
- `app/Infrastructure/Metrics/*`, `app/Http/Middleware/Metrics.php`, `docker/Caddyfile` (блок `:9464`).
- `tests/Unit/{LockStrengthTest,StaticStateTest,RouteTableTest,BudgetTest}.php`.
- `.github/workflows/ci.yml` (job `api-laravel`).
- `contracts/openapi.yaml` — одна фраза P61.

**tests/api:** весь набор, включая `permissions.test.ts`, `contract-coverage.test.ts`, `metrics.test.ts`, `fixture-writes.test.ts`. **tests/cross:** `session.test.ts` в парах express×laravel и laravel×express.

**Port notes:**
- Метрики (P54, L15):
  - `http_request_duration_seconds` {method, route, status, backend} и `http_request_errors_total` (статус ≥ 500), один замер на запрос в `terminate`;
  - `route` — шаблон из `ContractGate` без `/api/v1`, вне контракта — `unmatched`;
  - метод вне списка → `other`; клиент ушёл до ответа (`connection_aborted()`) → 499; поток SSE даёт один длинный замер;
  - `queue_messages{queue="agrotrace.laravel.jobs"}` — passive `queue_declare` с тайм-аутом 2 с;
  - `recalls_open` — `count(*)` OPEN неудалённых; не прочитано → `NaN`;
  - `:8000/metrics` → 404, `/api/v1/metrics` → 404 problem.
- Журналы — JSON с `backend` и `requestId`. Обработчик в воркере пишет `requestId` конверта в журнал, но не в аудит и не в outbox: системные записи остаются null.
- Статические проверки:
  - `LockStrengthTest`: `lockForUpdate(` и `/\bfor\s+update\b/i` в `app/` — только `DictionaryStore` (физическое удаление) и `deleteField`; `sharedLock()` и `for key share` разрешены;
  - `StaticStateTest`: изменяемые `static` свойства и статические кеши в `app/` — только по списку исключений с обоснованием (неизменяемые `Contract`, `RulesRepo`);
  - `RouteTableTest`: таблица маршрутов Laravel совпадает с 92 операциями контракта (метод, путь, имя = operationId);
  - `BudgetTest`: значения по умолчанию в сумме ≤ 20.
- `permissions.test.ts` генерирует матрицу из контракта: 401, 403 без `params`, x-org-admin, 400 `validation.uuid`, 404 чужой организации. Именно здесь проявляются неточности `operation`/Policies.
- `contract-coverage.test.ts` должен дать «operations 92/92 … 0 gaps» с тем же списком исключений (P55).
- P61: в `info.description` фраза «Laravel: `pm.max_children` php-fpm …» заменяется формулой L4 (Octane-воркеры, `DB_SLOTS` + сеанс LISTEN хаба + процессы `agrotrace:consume` + поллер Telegram + планировщик ≤ 20). Перед правкой выполнить `git fetch` и сверить строку с main (возможный параллельный текст Django в той же строке); правка — одной строкой, отдельным коммитом `docs(contracts): P61 Laravel budget under Octane`. Перегенерировать `packages/api-client/src/schema.d.ts`, если тест актуальности схемы этого требует (только описания).
- CI `api-laravel` (`SEED_NOW` закреплён, как у Express), шаги по порядку:
  1. `./at.sh install`;
  2. `up infra`;
  3. `reset`;
  4. `up express` (для cross);
  5. `up laravel`;
  6. `api:test laravel`;
  7. `api:test laravel --reset --tz Europe/Moscow`;
  8. `api:test laravel --ratelimits`;
  9. `cross:test express laravel`;
  10. `cross:test laravel express`;
  11. `docs:test laravel`;
  12. при неудаче — логи трёх сервисов.

- [ ] **Шаг 1: RED.** `./at.sh api:test laravel permissions.test.ts metrics.test.ts` → FAIL (метрик нет; расхождения матрицы перечислить). Pest-тесты из списка выше → FAIL до реализации.
- [ ] **Шаг 2: реализация.** Метрики, исправления по матрице, статические проверки, CI, фраза контракта.
- [ ] **Шаг 3: проверка.** Команды и ожидаемые результаты:

  | Команда | Ожидаемый результат |
  |---|---|
  | `./at.sh api:test laravel --reset`, дважды подряд | 549 passed / 4 skipped (или фактическое число набора main), строка покрытия `operations 92/92 … 0 gaps` |
  | `./at.sh api:test laravel --reset --tz Europe/Moscow` | тот же результат |
  | `./at.sh api:test laravel --ratelimits` | 4 passed |
  | `./at.sh cross:test express laravel` и `./at.sh cross:test laravel express` | 1 passed каждый |
  | `./at.sh docs:test laravel` | 1 passed |
  | `./at.sh laravel:test` и `./at.sh laravel:test --domain-coverage` | PASS, ≥ 70 % |
  | `./at.sh laravel:lint` | чисто |
  | `./at.sh at:test` | зелёный |
  | `./at.sh api:test express` | без регрессии от общих правок |
  | `./at.sh up react laravel`, `./at.sh up svelte laravel` | health через шлюз 200, `X-Backend: laravel` |
- [ ] **Шаг 4: коммиты.** `test(laravel): permission matrix, metrics, static guards, ci` и `docs(contracts): P61 Laravel budget under Octane`.
- [ ] **Шаг 5: подготовка к слиянию.** `git merge main` в `feat/plan-5-laravel`; общие файлы разрешить объединением блоков `# --- laravel ---` и `# --- django ---`; повторить шаг 3 (полный прогон один раз). Ветку не публиковать и не сливать в main без решения пользователя.

---

## Последующие шаги

Интеграционная фаза (P31, P34, P37):
- e2e `./at e2e <front> laravel` на 9 комбинациях с профилем `RATE_LIMIT_OVERRIDES`;
- отставания mock-api из списка P37 (по Laravel новых не ожидается — контракт выигрывает);
- `tests/cross` на всех 6 упорядоченных парах после Django.
