# AgroTrace — три реализации фронтенда

AgroTrace — система прослеживаемости сельхозпродукции «от поля до прилавка»: партии и их происхождение,
переработка, накладные, лабораторные анализы, отзывы продукции, жалобы покупателей и публичная страница партии
по QR-коду.

Одно и то же приложение реализовано **трижды** — на **React 18**, **Angular 18** и **Svelte 5 (SvelteKit)** — по
одному контракту OpenAPI и с одной дизайн-системой «Поле». Все три сборки работают поверх **мок-бэкенда в
браузере** (MSW 2): он реализует каждую операцию контракта, хранит состояние и воспроизводит демо-мир, так что
сервер API и база данных не нужны. Общий набор Playwright-тестов (`tests/e2e`) проходит на каждом фронтенде
одинаково — по ролям и доступным именам элементов, без привязки к фреймворку.

## Структура

| Каталог                   | Что внутри                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `frontend-react/`         | React 18 + Vite, TanStack Query, React Hook Form                                                                |
| `frontend-angular/`       | Angular 18 (standalone-компоненты, signals)                                                                     |
| `frontend-svelte/`        | Svelte 5 (runes) + SvelteKit, adapter-static                                                                    |
| `contracts/`              | контракт OpenAPI 3.1 (`openapi.yaml` + `openapi/`), бизнес-правила и тестовые векторы (`rules/`), схемы событий |
| `packages/api-client/`    | типизированный клиент API, сгенерированный из контракта                                                         |
| `packages/domain/`        | бизнес-правила (статусы, переходы, рейтинг доверия, коды партий), общие для всех фронтендов                     |
| `packages/validation/`    | схемы валидации запросов (Zod) по контракту                                                                     |
| `packages/i18n/`          | тексты интерфейса и форматирование (ru)                                                                         |
| `packages/design-system/` | дизайн-система «Поле»: токены, CSS-компоненты, иконки, иллюстрации, витрина                                     |
| `packages/mock-api/`      | мок-бэкенд в браузере (MSW 2) для всех операций контракта                                                       |
| `db/seed/`                | демо-мир: справочники, организации, пользователи, граф партий, фото и логотипы                                  |
| `tests/e2e/`              | общий e2e-набор Playwright для трёх фронтендов                                                                  |
| `tests/ds/`               | визуальные тесты витрины дизайн-системы                                                                         |
| `gateway/`                | nginx-шлюз, раздающий сборки и дизайн-систему                                                                   |
| `tools/`                  | Docker-образ с Node 22 и pnpm                                                                                   |

## Запуск

Нужны только **Docker** и **Git** (на Windows — Git Bash; вместо `./at` можно `at.cmd` или `at.ps1`). Node и pnpm
работают внутри контейнера `tools`.

```bash
./at install                      # зависимости (pnpm install в контейнере)

./at fe:build react --mock        # сборка с мок-бэкендом → frontend-react/dist-mock
./at fe:gateway react             # шлюз → http://react-mock.localhost:8089/

./at fe:build angular --mock
./at fe:gateway angular           # → http://angular-mock.localhost:8090/

./at fe:build svelte --mock
./at fe:gateway svelte            # → http://svelte-mock.localhost:8091/

./at down                         # остановить шлюзы
```

Порты задаются в `.env` (`REACT_PORT`, `ANGULAR_PORT`, `SVELTE_PORT`; создаётся из `.env.example`).
Витрина дизайн-системы — `http://localhost:8089/_ds/` (на любом из портов).

### Демо-доступ

Пароль всех пользователей — **`agrotrace-demo`**. Примеры:

| Email                             | Роль                     |
| --------------------------------- | ------------------------ |
| `zarya.head@agrotrace.test`       | хозяйство (FARMER)       |
| `molkombinat.head@agrotrace.test` | переработчик (PROCESSOR) |
| `vetlab.head@agrotrace.test`      | лаборатория (LAB)        |
| `provizia.head@agrotrace.test`    | торговая сеть (RETAILER) |
| `inspector.head@agrotrace.test`   | инспектор (INSPECTOR)    |
| `admin@agrotrace.test`            | администратор (ADMIN)    |

Полный список пользователей, организаций и ключевых объектов демо-мира — в
[docs/demo-accounts.md](docs/demo-accounts.md).

## Тесты и проверки

```bash
./at typecheck                    # TypeScript во всех пакетах
./at lint                         # ESLint (typescript-eslint, react-hooks, angular-eslint, eslint-plugin-svelte)
./at test                         # модульные тесты всех пакетов и трёх фронтендов (Vitest)
./at fe:test <react|angular|svelte>
./at e2e <react|angular|svelte> mock   # общий e2e-набор на запущенном шлюзе фронтенда
./at fe:e2e-smoke <front>         # собственные e2e-тесты фронтенда
./at ds:test                      # визуальные тесты витрины дизайн-системы
```

Прочие команды: `./at fe:build <front>` (production-сборка), `./at fe:dev <front>` (dev-сервер),
`./at fmt <путь>…` (Prettier), `./at sh` (shell в контейнере), `./at pnpm …`.

## Дизайн-система «Поле»

Общая основа трёх реализаций — чистый CSS без зависимости от фреймворка: токены цвета, типографики и отступов
(`tokens.css`, светлая и тёмная темы), компоненты с классами `at-*` (`components/`), спрайт иконок и
иллюстрации пустых состояний. [packages/design-system/README.md](packages/design-system/README.md) — контракт
разметки: каждый компонент описан через HTML-структуру, классы и поведение клавиатуры, и все три фронтенда
выдают одинаковый DOM. Витрина — `packages/design-system/showcase/`, её снимки проверяет `./at ds:test`.
