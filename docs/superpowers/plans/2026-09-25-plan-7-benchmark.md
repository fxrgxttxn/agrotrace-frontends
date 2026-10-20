# План 7 «Бенчмарк PostgreSQL и Redis» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Практическая работа «Типы баз данных»: воспроизводимое сравнение PostgreSQL 16 и Redis 7.4 на сущностях AgroTrace (ТЗ §13) и отчёт `docs/reports/databases.md` с измерениями, графиками и выводами.

**Architecture:** Полностью изолированный стенд `benchmark/` со своим compose-файлом (`benchmark/docker-compose.yml`, проект `agrotrace-bench`): `bench-postgres`, `bench-redis`, `bench-runner` (Python 3.12). Конфигурации СУБД («по умолчанию» / «оптимизированная») и режимы надёжности («строгий» / «ослабленный») переключаются перезапуском контейнеров с разными параметрами. Код бенчмарка — пакет `benchmark/agrobench/` (генерация, загрузка, запросы для обеих СУБД, измерения, графики). Корректность запросов доказывается тестами: одинаковые входы → одинаковые логические результаты в обеих СУБД.

**Tech Stack:** Python 3.12, psycopg 3 (+pool), redis-py + hiredis, numpy (Zipf, перцентили), matplotlib, pytest, ruff; PostgreSQL 16, Redis 7.4.

**Spec:** `docs/tz-agrotrace-v2.md` §13 (обязателен дословно: сущности, объёмы 10 000 по умолчанию, схемы, запросы R1–R6/W1–W3/D1–D2, методика, оптимизации, режимы надёжности, 3 прогона → медиана, CSV, env.json, графики). **Rulings:** `docs/superpowers/rulings.md`.

## Global Constraints

- Стенд не пересекается с рабочей системой: отдельный compose-проект `agrotrace-bench`, свои тома, никаких опубликованных портов (runner ходит по сети compose).
- На хосте только Docker + Git: все команды — `./at.sh bench <sub>`; вся логика команд — в `benchmark/bench.sh` (at.sh только делегирует одной строкой).
- Детерминизм: фиксированный seed генератора; одинаковые данные в обеих СУБД (проверяется тестом).
- Честность замеров: прогрев; время — `time.perf_counter_ns`; быстрые операции — пачками по 1000 с делением; клиентский overhead одинаков для обеих СУБД (один язык, одинаковая форма вызова); замеры записи/удаления не портят основной набор (отдельно подготовленные записи, восстановление после серии).
- Все числа в отчёте — из CSV реального прогона, графики генерируются скриптом; никаких выдуманных цифр.
- Отчёт на русском, по требованиям ПР: вся проделанная работа (схемы, генерация, запросы, оптимизация, методика), сравнение, плюсы/минусы, вывод «для каких задач какая СУБД» с привязкой к архитектуре AgroTrace.
- Коммиты — Conventional Commits, трейлер `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Эквивалентность запросов** — R4/R5 в Redis (ручная сборка, BFS, Lua) возвращают ровно то же, что JOIN/`WITH RECURSIVE` в PostgreSQL, включая DAG с общими потомками и глубину; тест на всех ключах малого набора.
2. **Согласованность индексов Redis** — после W1/W3/D1 все вторичные структуры (code, held, held:status, stats, children/parents, tests, tests:by_due) консистентны; тест-инвариант.
3. **Смещения замеров** — кэш-эффекты (прогрев одинаков), повтор одних и тех же ключей (распределения равномерное и Zipf), пул соединений, pipeline vs round-trip — задокументированы и одинаково применены.
4. **Режимы надёжности** — «строгий»: PG `synchronous_commit=on` + fsync; Redis `appendonly yes` + `appendfsync always`; «ослабленный»: `synchronous_commit=off` / `appendfsync everysec`; проверить, что конфигурация реально применена (SHOW / CONFIG GET) и записана в CSV.
5. **Воспроизводимость** — `./at.sh bench all` с нуля на чистых томах даёт CSV/графики/отчётные таблицы без ручных шагов.

---

### Task 1: Стенд и инфраструктура

**Files:** `benchmark/docker-compose.yml`, `benchmark/runner.Dockerfile`, `benchmark/requirements.txt`, `benchmark/pg/{default.conf,tuned.conf}`, `benchmark/redis/{default.conf,tuned.conf}`, `benchmark/bench.sh`, `at.sh` (одна строка `bench) exec benchmark/bench.sh "$@" ;;`), `benchmark/agrobench/{__init__.py,config.py,env.py}`, `benchmark/tests/test_env.py`, `benchmark/results/.gitkeep`.

- [ ] Compose: `bench-postgres` (postgres:16-alpine, конфиг выбирается переменной `PG_PROFILE=default|tuned` и `DURABILITY=strict|relaxed`), `bench-redis` (redis:7.4-alpine, аналогично), `bench-runner` (python:3.12-slim + requirements, монтирует `benchmark/`), лимиты ресурсов одинаковые для обеих СУБД (cpus, mem) и записаны.
- [ ] `bench.sh`: `up <pg_profile> <redis_profile> <durability>`, `down`, `test`, `gen`, `load`, `run`, `plot`, `report`, `all`; `env` пишет `results/env.json` (CPU, RAM, диск, ОС, версии Docker/PG/Redis/Python/библиотек, профили).
- [ ] Тест: после `up tuned tuned strict` реальные значения параметров (`SHOW shared_buffers`, `SHOW synchronous_commit`, `CONFIG GET appendfsync`, …) совпадают с профилем.
- [ ] Commit `feat(bench): isolated benchmark stand`.

### Task 2: Генерация данных, схемы и загрузка

**Files:** `benchmark/agrobench/{generate.py,schema_pg.sql,load_pg.py,load_redis.py,redis_keys.py}`, `benchmark/tests/{test_generate.py,test_load_equivalence.py}`.

- [ ] Генератор (§13.4): 4 сущности × `--scale` (по умолчанию 10 000), DAG глубиной ≤ 12 (60% RAW, 40% DERIVED с 1–4 родителями, только из более ранних партий → ацикличность), доли статусов, 3% FAIL, детерминизм по seed; выход — CSV в `benchmark/data/` (git-ignored).
- [ ] PG-схема §13.2 (bigint PK, FK, CHECK, индексы включая покрывающий), загрузка `COPY` без индексов → индексы → `ANALYZE`; время загрузки и `pg_total_relation_size` по таблицам.
- [ ] Redis-схема §13.3 (все структуры), загрузка pipeline по 10 000 с отключённой персистентностью, затем включение нужного режима; `INFO memory`, `MEMORY USAGE` по выборке ключей каждого типа (экстраполяция по типам).
- [ ] Тесты: ацикличность и глубина графа; распределения в допусках; эквивалентность данных (для каждой сущности множество записей из PG == из Redis; рёбра; вторичные индексы Redis соответствуют данным).
- [ ] Commit `feat(bench): data generator, schemas and loaders`.

### Task 3: Запросы R1–R6, W1–W3, D1–D2 для обеих СУБД

**Files:** `benchmark/agrobench/queries/{pg.py,redis.py,lua/*.lua}`, `benchmark/tests/test_query_equivalence.py`, `benchmark/tests/test_redis_invariants.py`.

- [ ] Реализация по таблице §13.5 (одинаковые сигнатуры функций для обеих СУБД; R5 в Redis — два варианта: BFS с pipeline по уровням и Lua; W3/D1 в Redis — Lua атомарно; W2 — COPY и multi-row INSERT против pipeline).
- [ ] Тесты эквивалентности на малом наборе (`--scale 500`): для всех ключей/организаций/статусов R1–R6 дают одинаковые логические результаты; W1/W3/D1/D2 приводят обе СУБД к одинаковому состоянию; инварианты вторичных индексов Redis после каждой записи/удаления (Review Focus 1, 2); оптимистичная блокировка W3 (устаревшая версия → отказ в обеих СУБД).
- [ ] Commit `feat(bench): equivalent query implementations`.

### Task 4: Методика измерений и прогон

**Files:** `benchmark/agrobench/{measure.py,workload.py,run.py,stats.py}`, `benchmark/tests/{test_stats.py,test_workload.py}`.

- [ ] Нагрузка по §13.6: прогрев 1 000; чтение — 10 000 измерений, ключи равномерно и Zipf 1.1 (фиксированный seed); быстрые операции пачками по 1 000; запись/удаление — 1 000 измерений на подготовленных записях с восстановлением набора; параллелизм 1 и 16 (asyncio: psycopg AsyncConnectionPool, redis.asyncio).
- [ ] Матрица прогона: {PG default, PG tuned} × {Redis default, Redis tuned} × {strict, relaxed} → в каждой конфигурации все запросы, 3 повтора, медиана; метрики p50/p95/p99/mean/ops/s; `EXPLAIN (ANALYZE, BUFFERS)` для R3/R4/R5 в обеих PG-конфигурациях сохраняется в `results/plans/`; Redis `SLOWLOG`/`LATENCY` снимки.
- [ ] CSV `results/measurements.csv` (длинный формат: dbms, profile, durability, query, distribution, concurrency, run, p50_us, p95_us, p99_us, mean_us, ops_s, n) + `results/memory.csv`, `results/load.csv`.
- [ ] Тесты: перцентили/медиана на известных данных; Zipf-генератор детерминирован; пачечное измерение делит корректно; восстановление набора после W/D (размер данных до и после совпадает).
- [ ] Полный прогон `./at.sh bench all` (время прогона записать в отчёт).
- [ ] Commit `feat(bench): measurement harness and full run` (CSV результатов коммитятся — они основа отчёта; .gitignore для `benchmark/results/*.csv` снять для итогового набора или хранить итоговые в `docs/reports/data/`).

### Task 5: Графики и отчёт

**Files:** `benchmark/agrobench/plot.py`, `docs/reports/databases.md`, `docs/reports/img/databases/*.png`, `docs/reports/data/*.csv`.

- [ ] Графики (matplotlib, единый стиль, подписи на русском, единицы — мкс/оп/с/МБ): по каждому запросу p50/p95 PG vs Redis в обеих конфигурациях; влияние оптимизации (до/после) по СУБД; влияние режима надёжности на W1/W2/W3; масштабирование 1→16 клиентов; память/диск; время загрузки. Загрузить `dataviz` skill для правил графиков.
- [ ] Отчёт `docs/reports/databases.md` (русский): цель и задание; стенд (env.json); сущности и связи; схемы PG и Redis с обоснованием структур; генерация и загрузка; запросы (таблица + код ключевых); оптимизация (что и почему, планы до/после); методика; результаты (таблицы из CSV + графики); анализ; плюсы и минусы каждой СУБД; вывод: какие задачи AgroTrace куда (связь с архитектурой §8: PG — хранилище/граф/транзакции/аналитика; Redis — кэш QR-страниц, rate limit, идемпотентность, одноразовые коды) — все числа из CSV.
- [ ] Тест: скрипт сверки — каждая цифра в таблицах отчёта присутствует в CSV (генерация таблиц отчёта скриптом `report_tables.py`, отчёт включает сгенерированный блок между маркерами).
- [ ] Commit `docs(bench): database benchmark report`.
