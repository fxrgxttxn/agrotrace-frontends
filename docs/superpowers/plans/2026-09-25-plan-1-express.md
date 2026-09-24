# План 1 «Express» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Первая backend-реализация AgroTrace на Express (Node 22, TypeScript), полностью соответствующая контракту `contracts/openapi.yaml`, и общий набор API-тестов `tests/api`, который затем без изменений проверит Django и Laravel.

**Architecture:** Модульный монолит `backend-express/` c слоями transport → application → domain (`@agrotrace/domain`) → infrastructure (Kysely/PostgreSQL, Redis, MinIO, RabbitMQ). Три процесса из одного образа: `api` (HTTP + SSE), `worker` (очередь `agrotrace.express.jobs`), `scheduler` (тики с advisory-lock). Поведение задаётся контрактом и правилами `contracts/rules/*`; тесты `tests/api` пишутся против HTTP-контракта, а не против внутренностей Express.

**Tech Stack:** Express 4, TypeScript 5 strict, Kysely + kysely-codegen, pg, ioredis, amqplib, @aws-sdk/client-s3, sharp, argon2, jose, otplib, altcha-lib, qrcode, pdfkit, exceljs, pino, prom-client, swagger-ui-express, Zod (`@agrotrace/validation`), Vitest, supertest (только unit), Ajv 2020 (валидация ответов по контракту в tests/api).

**Spec:** `docs/tz-agrotrace-v2.md` (§5–§8, §11, §12, §14). **Contract (binding):** `contracts/openapi.yaml` + `contracts/openapi/**`, `contracts/rules/*.json`, `contracts/events/*.schema.json`. **Rulings:** `docs/superpowers/rulings.md` (R1–R92) — обязательны.

## Global Constraints

- Контракт — единственный источник истины: пути, коды, `ProblemCode`, `rule`, `params`, заголовки, `x-roles`, `x-org-admin`, `x-access`, `x-idempotent`, `x-locks`, `x-transition`, `x-sort`, `x-rate-limit`, `x-report-access`. Любое расхождение с контрактом — дефект реализации (не контракта), кроме явно вынесенных controller rulings.
- Все ответы (включая ошибки) валидируются по контракту в `tests/api` (Ajv 2020, strict, formats); `additionalProperties:false` соблюдается.
- Массы — строки с 3 знаками; даты ISO с `Z`; ids — uuid; пустые необязательные поля — `null` согласно схемам.
- Ошибки — RFC 7807 `application/problem+json`, `type = /problems/<kebab-code>`.
- Блокировки — протокол R47/R52 (READ COMMITTED, порядок waybill → recall → lab test → complaint → organization → batches ORDER BY id → recall tasks ORDER BY id → прочее; If-Match как compare-and-set; 40P01/40001 → один повтор, затем 409 VERSION_CONFLICT). Исключение: движок отзыва — REPEATABLE READ (R54/D7).
- Идемпотентность — R48/R53 (Redis `idem:{userId}:{key}`, pending 60 s, done 24 h, Lua compare-and-set/delete, форматы значений JSON как в контракте).
- Rate limits — `contracts/rules/rate-limits.json` (R30), общий Redis, ключи из файла.
- События — outbox (R55/R56): строка `outbox_events(backend='express')` в той же транзакции; relay после commit + sweeper 5 s; consumer начинает транзакцию с `INSERT INTO processed_events … ON CONFLICT DO NOTHING`.
- Уведомления в реальном времени — SSE `/api/v1/events/stream`, LISTEN `notifications`, `Last-Event-ID`/`lastEventId`, `reauth`, `ping` 25 s (R33; replay учитывает заметку «T3-5 note for SSE plan» — повтор по `created_at`-окну/непрочитанным, а не только `seq > lastId`).
- Файлы — MinIO, варианты WebP 96/480 (sharp), подписанные ссылки по рецепту контракта (R28/R34/R39/R88: ключ подписи = HMAC-SHA256(JWT_SECRET, "agrotrace:file-url:v1"), сообщение "{id}:{exp}") TTL 3600, ETag = sha256 отдаваемых байт.
- Общие ключи Redis — таблица «Shared Redis keys» в info.description контракта (R82): `pub:batch:*`, `pwreset:*`, `invite:*`, `tgcode:*`, `totp-used:*`, `tg:poller`, ссылки писем от `PUBLIC_BASE_URL`; форматы значений побайтово как в контракте.
- Мгновенно закрытый отзыв (без задач) не рассылает OPENED после CLOSED: событие `recall.requested` для такого отзыва не формирует OPENED (R89).
- Swagger UI `/api/v1/docs` отдаёт ассеты локально (swagger-ui-express/swagger-ui-dist), без CDN и inline-скриптов — совместимо с CSP шлюза (R89/I6).
- Пароли Argon2id PHC m=65536,t=3,p=1; JWT HS256 общий `JWT_SECRET`, access 15 мин, refresh 14 дней в cookie `at_refresh` (HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth), ротация, grace 10 s, отзыв цепочки (R32/R40).
- Порядок проверок входа — R31; TOTP — R35; строки — R36 (без trim, email в нижний регистр, длины в code points).
- `X-Backend: express` во всех ответах; `X-Request-Id` принимается/генерируется, в логах pino JSON.
- `audit_log` для всех изменяющих операций (`backend='express'`, `action=operationId`, `diff {field:[before,after]}` в API-формате, секреты `"***"`).
- Никакой логики, дублирующей `@agrotrace/domain`: бизнес-правила вызываются оттуда.
- Коммиты — Conventional Commits, трейлер `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Код тестов `tests/api` не импортирует ничего из `backend-express` — только HTTP (базовый URL из `API_URL`, по умолчанию `http://api-express:8000/api/v1`).

## Review Focus

1. **Конкурентные операции** — два одновременных `sendWaybill` на одну партию, `sendWaybill` против `processBatches`, `acceptWaybill` против отзыва: ровно один успех, второй 409; тесты с `Promise.all` в tests/api (Task 7, 8, 10).
2. **Видимость чужих данных** — любая операция над ресурсом вне видимости возвращает 404 (не 403, не 200 с чужими данными) для каждой роли; генерируемые из `x-roles`/матрицы тесты (Task 1, 14).
3. **Идемпотентность при сбоях** — повтор с тем же ключом во время выполнения → 409 IN_PROGRESS; после 5xx → повторное выполнение; другой body → 409 REUSED (Task 7).
4. **Время и часовые пояса** — сроки BR-01/BR-08/эскалации на границе суток UTC; сервер в любом TZ (контейнер с `TZ=Europe/Moscow` в одном тестовом прогоне) (Task 9, 10).
5. **Файлы на границе лимита** — ровно лимит (≤) принимается, лимит+1 → 413 FILE_TOO_LARGE; MIME по сигнатуре, SVG-санитизация (скрипты/`on*`/внешние ссылки удаляются) (Task 3).

---

## Карта файлов

```
backend-express/
  package.json tsconfig.json Dockerfile .dockerignore
  src/
    main-api.ts main-worker.ts main-scheduler.ts
    config.ts                 env (zod), единая конфигурация
    app.ts                    сборка express-приложения (composition root)
    container.ts              ручной DI: db, redis, s3, amqp, repos, services
    http/                     middleware: requestId, backendHeader, auth, roles, rateLimit, idempotency, ifMatch, problem, validate, audit
    db/                       kysely (db.ts, types.generated.ts, tx.ts: withTx(isolation, retry))
    infra/                    redis.ts s3.ts amqp.ts outbox.ts mailer.ts telegram.ts dadata.ts mercury.ts images.ts qr.ts pdf.ts xlsx.ts altcha.ts
    modules/<module>/         routes.ts controller.ts service.ts repository.ts mappers.ts (по модулям контракта)
    events/                   consumers/*.ts, dispatch.ts
    scheduler/                jobs/*.ts
    sse/                      hub.ts (LISTEN notifications)
  test/                       unit-тесты (mappers, services с фейковыми репозиториями — только где логика не покрыта tests/api)
tests/api/
  package.json vitest.config.ts
  lib/                        client.ts (fetch + cookies), auth.ts (login per role из seed), contract.ts (Ajv по бандлу, validateResponse(opId,status,body,headers)), fixtures.ts (фабрики данных через API), matrix.ts (x-roles → ожидания), db.ts (read-only проверки побочных эффектов, только где контракт требует)
  <module>.test.ts            по модулю контракта
tests/cross/                  (каркас в Task 14; наполняется в Плане 3)
```

Seed (`./at.sh reset`) — исходное состояние для tests/api; тесты, меняющие данные, создают собственные сущности через API (фабрики), чтобы наборы были независимы и перезапускаемы. Перед полным прогоном — `./at.sh reset` (SEED_NOW фиксирован в CI).

---

### Task 1: Каркас Express, инфраструктура запросов, тестовый харнесс

**Files:** `backend-express/**` (skeleton), `docker-compose.yml` (services `api-express`, `worker-express`, `scheduler-express`), `at.sh` (`api:test [backend]`, `gen:db-types`), `tests/api/lib/*`, `tests/api/health.test.ts`, `tests/api/contract-shape.test.ts`

**Produces:** `createApp(container)`; middleware `requestId`, `backendHeader('express')`, `problem` (единый error handler: ZodError → 400 VALIDATION с `toFieldErrors`; `AppProblem(status, code, {rule, params, errors})`; неизвестное → 500 INTERNAL без утечки стека); `withTx(db, {isolation, retryOnce})`; Kysely типы из схемы (`kysely-codegen` против `agrotrace_test`); `GET /health/live`, `GET /health/ready` (db, redis, rabbitmq, s3; 503 при отказе по контракту); Swagger UI `/api/v1/docs` отдаёт бандл контракта; `tests/api` харнесс: `api(role?)` клиент с cookie-jar, `loginAs(role, {head?})` по `docs/demo-accounts.md`/seed-данным, `expectContract(res, operationId)` (валидирует статус ∈ описанных, тело и заголовки по схеме), `API_URL` из env.

- [ ] Шаг 0 — остаточные правки контракта и инфраструктуры из финального ревью Плана 0 (R91, R92 в `docs/superpowers/rulings.md`): видимость `labProtocols`/`qr` в getBatchDocuments; таблица §8.5 ТЗ; Lua compare-and-PEXPIRE для `tg:poller`; сравнение строк по code point в tie-break; `pub:batch` отдаётся побайтово; расширенный список инвалидации; валидация тела до GETDEL; `error_log` без query string; шаблоны Telegram без эмодзи; пара `outbox_events.backend` ↔ envelope в механическом тесте; prefetch/конкурентность воркера для `vsd.import`; относительные даты документов в mercury-mock (R90). Контрактные тесты и lint зелёные, отдельный коммит `fix(contracts): plan-0 final review residuals`.
- [ ] Тесты (RED): health live/ready формы и `X-Backend`, `X-Request-Id` echo/генерация (формат R79), неизвестный путь → 404 problem+json, битый JSON → 400 VALIDATION problem, контракт-валидатор ловит лишнее поле (мета-тест харнесса).
- [ ] Реализация, compose-сервисы (порт 8000 в сети `at`, healthcheck `/api/v1/health/live`), шлюз уже проксирует `react-express.localhost`.
- [ ] `./at.sh api:test express` зелёный; `./at.sh up gateway` + запрос через шлюз.
- [ ] Commit `feat(express): skeleton, problem handling, api test harness`.

### Task 2: Аутентификация и сессии

**Operations:** login, refreshToken, logout, setupTwoFactor, verifyTwoFactor, forgotPassword, resetPassword, registerOrganization, acceptInvite. **Infra:** argon2, jose, otplib, rate limiter (R30), mailer (Mailpit), DaData adapter (нет ключа → MANUAL_CHECK; таймаут/ошибка → MANUAL_CHECK), ALTCHA не здесь.

- [ ] Тесты tests/api/auth.test.ts (RED): успешный вход каждой ролью; порядок R31 (неизвестный email → INVALID_CREDENTIALS без блокировки; 5 неверных → ACCOUNT_LOCKED с lockedUntil; при блокировке верный пароль → ACCOUNT_LOCKED; статусы → 403 reason); 2FA (setup two-step, verify ±1 шаг, повтор шага отклонён, 5 неверных → challenge недействителен, TTL); refresh ротация, повтор старого токена ≤10 s → 401 TOKEN_EXPIRED без отзыва цепочки, >10 s → отзыв цепочки (другие сессии живы), logout-отозванный → 401 + clear cookie; cookie-атрибуты; forgot → письмо в Mailpit (API Mailpit), reset → новый пароль работает, старые refresh отозваны; register-organization (валидный ИНН, checksum 400, дубль ИНН/email → 400 `validation.<field>.taken`, без DaData → MANUAL_CHECK); accept-invite; rate limit login-ip/forgot с Retry-After и params.
- [ ] Реализация `modules/auth`, `http/auth` (Bearer verify, claims), `http/rateLimit`.
- [ ] Commit `feat(express): authentication, sessions, 2fa, registration`.

### Task 3: Профиль, пользователи, организации, файлы

**Operations:** getMe, updateMe, uploadMyAvatar, deleteMyAvatar, getMyChannels, updateMyChannels, createTelegramCode, listUsers, inviteUser, updateUser, getUserAvatar, getOrganization, listOrganizations, uploadOrganizationLogo, getOrganizationLogo, downloadFile, downloadPublicFile.

- [ ] Тесты (RED): x-roles/x-org-admin матрица (403 без params для роли вне x-roles; 404 для невидимого); инвайт → письмо; UserPatch переходы (R37); загрузки: форматы по сигнатуре (PNG под .jpg принимается как PNG; текст под .png → 415), лимит ровно/+1, SVG логотипа санитизирован, варианты 96/480 WebP; скачивание: ETag = sha256 отдаваемых байт, 304 на If-None-Match, Content-Disposition (R34), подписанная ссылка без Bearer работает, просроченная/подделанная → 403, variant не подписан (R39), публичные файлы (логотипы, фото продуктов) без авторизации, аватар через public → 404.
- [ ] Реализация `infra/s3`, `infra/images`, `modules/files`, `modules/me`, `modules/users`, `modules/organizations`, signer.
- [ ] Commit `feat(express): profile, users, organizations, files`.

### Task 4: Справочники, администрирование, журнал аудита

**Operations:** listDictionary, createDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry, importDictionary, uploadProductImage, listAdminOrganizations, updateAdminOrganization, approveOrganization, listAuditLog, listPublicRegions. **Cross-cutting:** `http/audit` + `auditService.record(tx, …)` используется всеми изменяющими операциями (дописывается в Tasks 2–3 ретроактивно в этом таске).

- [ ] Тесты (RED): CRUD каждого справочника, soft/hard delete (R54/D29, REFERENCE_IN_USE), восстановление soft-deleted по имени, импорт CSV (`;`, BOM, кавычки, first-row-wins, unchanged числово, ошибки строк) и XLSX, 415/400 по R58, лимит строк; одобрение/отклонение/SUSPENDED организаций и эффект на вход (R54/D26); аудит: каждая изменяющая операция Tasks 2–4 пишет строку с корректным diff (секреты `***`), фильтры журнала, INSPECTOR читает.
- [ ] Реализация. Commit `feat(express): dictionaries, admin, audit log`.

### Task 5: Поля и обработки

**Operations:** listFields, createField, getField, updateField, deleteField, listFieldTreatments, createTreatment, updateTreatment.

- [ ] Тесты (RED): видимость (FARMER своё, INSPECTOR/ADMIN чтение, остальные 404/403 по x-roles); GeoJSON валидация; окно редактирования 24 ч (403 EDIT_WINDOW_CLOSED, граница включительно); фильтры `from/to` UTC-даты (R41/D31), `organizationId` роль-ограничен (R51).
- [ ] Реализация. Commit `feat(express): fields and treatments`.

### Task 6: Партии — создание, чтение, граф, QR, продажа

**Operations:** createBatch, listBatches, getBatch, getBatchHistory, getBatchPath, getBatchGraph, createBatchQr, downloadBatchQr, putBatchOnSale, markBatchSold.

- [ ] Тесты (RED): создание сырьевой партии (коды AT-YYYY-NNNNNN, риск-модель BR-03 через домен, выбор лаборатории D18 и 409 NO_LAB_AVAILABLE с откатом, уведомление LAB_ASSIGNED в outbox); видимость S ∪ N (D14) по ролям; `actions` = availableActions ∩ права; фильтры и x-sort, `origin`/`holder`/`orgId` (R49/R51); граф depth 1..5, `accessible:false` для узлов вне видимости (D16); путь с harvestedAt/producedAt (R45); QR: права R43/R44, хранение файлов, повторная генерация заменяет, GET до генерации → 404, PNG/PDF контент-тип; on-sale только из Accepted у RETAILER-держателя (R20), sold; If-Match compare-and-set (VERSION_CONFLICT с currentVersion).
- [ ] Документы партии и «Меркурий» (R81): `GET /batches/{id}/documents`, `POST /batches/{id}/documents/vsd/retry`; при createBatch для категорий DAIRY/MEAT — строка `batch_documents` PENDING + outbox `vsd.import`; consumer в воркере (`infra/mercury.ts`, адаптер с таймаутом и повторами 2…32 s) → IMPORTED / NOT_FOUND / FAILED; тесты: успешный импорт по данным mercury-mock, NOT_FOUND, отказ (`X-Mock-Fail` через env адаптера в тестовом профиле) → FAILED после повторов, retry допустим только из NOT_FOUND/FAILED, партия создаётся всегда.
- [ ] Кэш публичной страницы (R82): инвалидация `pub:batch:{publicCode}` после commit во всех операциях, меняющих статус/держателя/анализы/путь, включая каскад отзыва — тест: публичная страница отражает изменение сразу после операции.
- [ ] Реализация `modules/batches`, `modules/documents`, `infra/qr`, `infra/pdf`, `infra/mercury`. Commit `feat(express): batches, graph, qr, documents`.

### Task 7: Накладные и идемпотентность

**Operations:** createWaybill, getWaybill, listWaybills, sendWaybill, acceptWaybill, rejectWaybill, deleteWaybill. **Cross-cutting:** `http/idempotency` (R48/R53), `http/ifMatch`, lock helpers (R47/R52).

- [ ] Тесты (RED): полный цикл DRAFT→SENT→ACCEPTED/REJECTED (waybill-state-machine.json); send: порядок проверок D6, BR-01 422 с params {publicCode, until, substance}, BR-06, INVALID_TRANSITION; accept: BR-07 act обязателен при >2%, masses, смена держателя, уведомления; reject: возврат в Approved, переназначение задачи отзыва (R50c); delete только DRAFT; идемпотентность (повтор → тот же ответ + `Idempotent-Replayed: true`; другой body → REUSED; параллельный повтор → IN_PROGRESS + Retry-After; после 5xx — повторное выполнение); гонки из Review Focus 1 (`Promise.all` двух send с общей партией → ровно один 200).
- [ ] Реализация. Commit `feat(express): waybills, idempotency, locking`.

### Task 8: Переработка

**Operations:** processBatches.

- [ ] Тесты (RED): BR-04 (params inputKg/allowedKg/outputKg = домен), BR-05, BR-06, NOT_HOLDER, входы → Processed, связи графа (D20), производные партии Approved (D19), MassTotal для сумм; гонка processing vs send.
- [ ] Реализация. Commit `feat(express): processing`.

### Task 9: Лаборатория

**Operations:** listLabTests, createLabTest, getLabTest, registerLabSample, submitLabResults, uploadLabProtocol, downloadLabProtocol. **Scheduler:** `lab-escalation`.

- [ ] Тесты (RED): очередь лаборатории (видимость только своей лаборатории), фильтр `batchId` для участников (T9 note a); ровный набор показателей (D4), BR-02 строгое `>`, снимок норматива, PASS → Approved, FAIL → Blocked + автозапуск отзыва (recallId в ответе и в `lab_tests.recall_id`, R57); протокол PDF ≤10 МБ, замена; эскалация через 5 рабочих дней (тест управляет временем через `SCHEDULER_NOW`-override только в test-профиле или через прямую установку due_at в тестовой БД — выбрать и описать); TZ-тест (Review Focus 4).
- [ ] Реализация `modules/lab`, `scheduler/jobs/lab-escalation`. Commit `feat(express): lab tests and escalation`.

### Task 10: Движок отзыва и задачи изъятия

**Operations:** createRecall, listRecalls, getRecall, getRecallGraph, listRecallTasks, confirmRecallTask. **Scheduler:** `recall-task-overdue`. **Consumer:** `recall.requested` (уведомления), `rating.recalculate`.

- [ ] Тесты (RED): шаги 1–7 Recalls tag (обход вниз, вверх при blockUpstream, статусы по §5.1 примечанию, soft-deleted транзитом, задачи держателям/получателям InTransit, due по BR-08, мгновенное закрытие без задач BR-10 + событие CLOSED, повторный запуск по источнику с OPEN → 200 существующий); confirm задачи → WrittenOff, закрытие отзыва после последней; просрочка → OVERDUE + эскалация + уведомления; рейтинг BR-09 (свёртка, eventually consistent — тест ждёт с дедлайном); гонка accept vs recall.
- [ ] Реализация `modules/recalls`, `events/consumers/*`. Commit `feat(express): recall engine`.

### Task 11: Жалобы и публичная часть

**Operations:** listComplaints, getComplaint, startComplaintReview, decideComplaint, getPublicBatch, createPublicComplaint, getCaptchaChallenge (+ listPublicRegions, downloadPublicFile уже есть).

- [ ] Тесты (RED): публичная страница (кэш Redis `pub:batch:{code}` TTL 5 мин, сброс при смене статуса, без персональных данных, safety), ALTCHA (неверное решение → 400 CAPTCHA_FAILED), rate limit complaint-ip 10/час, жалоба → уведомление инспекторам; review/decision переходы (entity-state-machines), LAB_TEST создаёт анализ (labOrgId), RECALL запускает/переиспользует отзыв (R54/D15 ссылки).
- [ ] Реализация. Commit `feat(express): complaints and public pages`.

### Task 12: Уведомления, outbox, SSE, воркер

**Operations:** listNotifications, markNotificationsRead, streamEvents. **Infra:** outbox relay + sweeper, RabbitMQ consumer (`agrotrace.express.jobs`, DLQ), processed_events, notification.dispatch (IN_APP/EMAIL/TELEGRAM, 3 попытки, NOT_CONFIGURED), SSE hub (LISTEN), unread.

- [ ] Тесты (RED): каждое событие из `contracts/rules/notifications.json` доставляет IN_APP нужным получателям (уже частично в Tasks 6–11 — здесь сводный тест матрицы); EMAIL в Mailpit; TELEGRAM без токена → NOT_CONFIGURED; повтор события (двойная публикация) не дублирует (processed_events); SSE: поток получает `notification` и `unread`, `Last-Event-ID`/`lastEventId` replay, `reauth` при истечении токена, `ping`; уведомление, созданное прямой вставкой в БД (имитация другого backend), доставляется в SSE (кросс-backend основа); markRead ids/upToSeq.
- [ ] Реализация `infra/outbox`, `events/*`, `sse/hub`, `main-worker`, `main-scheduler`. Commit `feat(express): notifications, outbox, sse`.

### Task 13: Аналитика и отчёты

**Operations:** getDashboard, downloadReport.

- [ ] Тесты (RED): дашборд по scope и ролям (validation.scope.notAllowed), окна 30/366 дней, поля по описаниям схемы на seed-данных (ожидаемые числа вычисляются в тесте SQL-запросом read-only к БД или фиксированы от seed); отчёты xlsx/pdf: права x-report-access, листы/колонки/порядок/типы ячеек (ExcelJS чтение в тесте), имена файлов, >50 000 строк → 400, timestamps усечены до минут.
- [ ] Реализация `modules/analytics`, `modules/reports`, `infra/xlsx`. Commit `feat(express): dashboards and reports`.

### Task 14: Сквозные проверки, метрики, CI

- [ ] `tests/api/permissions.test.ts`: генерация из `x-roles`/`x-org-admin`/`x-access` бандла — для каждой операции и каждой роли вне x-roles ожидание 403 (или 401 без токена), для публичных — доступ без токена; для ресурсов чужой организации — 404 (набор представительных операций на seed-данных).
- [ ] `tests/api/contract-coverage.test.ts`: каждая operationId контракта вызвана хотя бы одним тестом (реестр вызовов в харнессе) и каждый объявленный код ответа (кроме 5xx/429 без сценария) встречен хотя бы раз — отчёт о пробелах, падение при непокрытых операциях.
- [ ] `tests/cross/` каркас: запуск одного сценария против двух `API_URL` (заглушка до Плана 3).
- [ ] Метрики prom-client `/metrics` (метка backend=express): http duration/errors, queue length, open recalls; логи pino с request id.
- [ ] CI job `api-express`: `./at.sh reset` (SEED_NOW фиксирован) → up api/worker/scheduler → `./at.sh api:test express`.
- [ ] Commit `test(express): permission matrix, contract coverage, metrics, ci`.

---

## Последующие планы

План 2 — React (все экраны §9.4–9.6 на дизайн-системе «Поле» против Express через шлюз; общий набор `tests/e2e`). План 3 — Django (прохождение `tests/api` без изменений тестов + `tests/cross`).
