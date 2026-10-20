# План «Три фронтенда на моках» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Пакет из трёх одинаковых frontend-реализаций AgroTrace — React (План 2), Angular (План 4), Svelte (План 6) — полностью работающих на общем мок-бэкенде в браузере; бэкенды подключаются позже без изменений фронтендов (тот же `/api/v1` и контракт).

**Decision (пользователь, 2026-09-26):** сначала три фронтенда на мок-данных, бэкенды потом. Express (План 1) приостановлен после Task 4–5.

**Architecture:**
- `packages/mock-api` — `@agrotrace/mock-api`: MSW 2 handlers для всех операций контракта + stateful in-memory store (демо-данные эквивалентны seed по составу и сценариям), бизнес-правила из `@agrotrace/domain`, роли/видимость/ошибки по контракту, JWT-подобные токены (непрозрачные), SSE-имитация (`/events/stream` через ReadableStream). Режим «mock» каждого фронта регистрирует service worker MSW при старте; production-сборка без мока.
- Каждый фронт собирает `dist-mock/` и отдаётся своим стендом `gateway-<front>` (react 8089, angular 8090, svelte 8091) на хосте `<front>-mock.localhost` — сервер API не нужен.
- `tests/e2e` — один Playwright-набор (роли/доступные имена, `data-testid` только из README), запускается против любого `<front>-mock` и позже `<front>-<back>`.
- Эталон поведения экранов — React (План 2); разметка — README дизайн-системы (обязательна); маршруты — §9.4; тексты — `@agrotrace/i18n`; формы — `@agrotrace/validation`.

**Streams / worktrees:** React `C:/project-wt/plan-2` (feat/plan-2-react), mock-api `C:/project-wt/mock-api` (feat/mock-api), Angular `C:/project-wt/plan-4` (feat/plan-4-angular), Svelte `C:/project-wt/plan-6` (feat/plan-6-svelte). Controller merges mock-api and README/design-system updates into the three branches.

## Global Constraints
- Все ограничения Плана 2 (без неона и лишнего текста, дизайн-система «Поле», README-DOM, §9.4 маршруты, 360 px, WCAG AA, i18n, CSP без inline-скриптов) действуют для всех трёх фронтов.
- Поведение трёх фронтов идентично: одинаковые маршруты, DOM компонентов, тексты, фокус (F4), состояния ошибок и пустых данных, реакции на коды ошибок контракта.
- Мок следует контракту: каждый ответ валиден по схеме (проверяется в тестах мока), коды ошибок/params — как в контракте; никаких «удобных» отклонений.
- Коммиты — Conventional Commits, трейлер `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Tasks

### M1 (mock-api): stateful mock backend
- [ ] Store + seed-эквивалентные данные (организации всех типов, пользователи всех ролей с паролем `agrotrace-demo`, поля, партии с графом, накладные во всех статусах, анализы, два открытых отзыва и закрытый, жалобы, уведомления, справочники с фото продуктов из db/seed/images).
- [ ] Handlers всех 92 операций: auth (вход, 2FA для inspector.head, refresh, logout), профиль, пользователи, организации, файлы (object URLs/blob для загрузок), справочники+импорт, admin, audit, поля/обработки, партии/граф/путь/документы/QR (PNG генерация на клиенте), накладные (DRAFT→SENT→ACCEPTED/REJECTED, BR-01/06/07), переработка (BR-04/05), анализы (BR-02 → Blocked → отзыв), движок отзыва (обход графа, задачи, BR-08/10), жалобы, уведомления+SSE, дашборды, отчёты (XLSX через exceljs в браузере или заглушка-файл по контракту), публичная страница+жалоба.
- [ ] Права по x-roles/x-org-admin, видимость → 404, валидация тел через `@agrotrace/validation` → 400 по контракту.
- [ ] Тесты: каждый ответ валиден по контракту (Ajv), ключевые сценарии (сквозной отзыв) проходят на моке; сброс состояния (`resetMock()`); персистентность в sessionStorage по желанию (выключено по умолчанию).
- [ ] Commit `feat(mock-api): stateful in-browser backend for all contract operations`.

### R-tasks (React): План 2 Tasks 3–9 выполняются против mock-api (dev/e2e) вместо живого Express; компонентные тесты остаются на MSW из примеров контракта.

### A1–A9 (Angular 18): зеркало задач React 1–9
- A1 каркас (standalone components, Router + `CanActivateFn`, signals-сервисы сессии, HttpClient-адаптер к api-client, обёртки компонентов дизайн-системы с DOM из README, route focus F4, тема, тосты, MSW-моки для тестов, сборка, `gateway-angular` 8090, e2e-smoke); A2 вход/профиль/уведомления; A3 поля/партии; A4 накладные/склад/переработка/QR; A5 лаборатория/дашборды; A6 отзывы/задачи/жалобы; A7 администрирование/отчёты; A8 публичная страница (≤60 КБ); A9 прохождение общего `tests/e2e` на `angular-mock`.
- Angular-специфика: Reactive Forms + адаптер Zod → ValidatorFn; RxJS для SSE; `inlineCritical: false` (CSP, R89); Vitest (`@analogjs/vitest-angular`) + Angular Testing Library.

### S1–S9 (Svelte 5 / SvelteKit adapter-static, ssr=false): зеркало задач React 1–9
- S1 каркас (файловая маршрутизация по §9.4, guard в `+layout.ts`, runes-сторы сессии, обёртки компонентов с DOM из README, route focus F4, тема, тосты, MSW для тестов, сборка без inline-bootstrap (CSP, R89), `gateway-svelte` 8091, e2e-smoke); S2–S8 как у React; S9 общий `tests/e2e` на `svelte-mock`.
- Svelte-специфика: формы — нативные + Zod через action `use:form`; SSE — стор-обёртка; Vitest + Svelte Testing Library.

### E1: общий e2e-набор и визуальное сравнение трёх фронтов
- [ ] `tests/e2e` (из React Task 9) проходит без изменений на `react-mock`, `angular-mock`, `svelte-mock`; визуальные снимки 12 ключевых экранов × 2 темы × 2 ширины совпадают между фронтами (порог ≤1% пикселей); отчёт о расхождениях.
