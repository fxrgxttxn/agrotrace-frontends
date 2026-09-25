# Типы баз данных: PostgreSQL и Redis на данных AgroTrace

Отчёт по практической работе «Типы баз данных» (ТЗ, раздел 13). Все числа в таблицах взяты из CSV и JSON реального прогона в [`docs/reports/data/`](data/). Таблицы вставляет скрипт `benchmark/agrobench/report_tables.py` между маркерами `report_tables:begin/end`, графики строит `benchmark/agrobench/plot.py`. Тест `benchmark/tests/test_report_tables.py` проверяет две вещи: что каждое число в таблицах есть в исходных файлах и что сгенерированные блоки не правились вручную. Дробные числа в тексте ниже тоже сверяются с таблицами.

## 1. Цель и задание

Цель: на сущностях AgroTrace сравнить реляционную СУБД (PostgreSQL 16) и хранилище «ключ — значение» (Redis 7.4) и ответить, какие задачи системы выгоднее решать в каждой из них. Результат проверяет архитектурное решение раздела 8 ТЗ: PostgreSQL служит основным хранилищем, Redis — кэшем и хранилищем короткоживущих ключей.

Задание (ТЗ §13):

- четыре сущности по 10 000 записей, одинаковые данные в обеих СУБД;
- схема PostgreSQL с внешними ключами, CHECK и индексами, в том числе покрывающим;
- схема Redis на хешах, множествах, сортированных множествах и списках со вторичными индексами, которые поддерживает приложение;
- одиннадцать запросов: чтение R1–R6, запись W1–W3, удаление D1–D2;
- замеры p50, p95, p99, среднего и оп/с при 1 и 16 клиентах, на равномерных и «горячих» (Zipf 1.1) ключах;
- две конфигурации каждой СУБД («по умолчанию» и «оптимизированная») и два режима надёжности («строгий» и «ослабленный»);
- 3 повтора каждого замера, в отчёт идёт медиана;
- графики, характеристики стенда, выводы.

## 2. Стенд

Стенд — отдельный compose-проект `agrotrace-bench` (`benchmark/docker-compose.yml`) из трёх контейнеров: `bench-postgres`, `bench-redis` и `bench-runner` (клиент на Python). Портов наружу он не публикует. Все команды запускаются через `./at.sh bench <команда>`. Характеристики стенд записывает сам в `env.json`: по одному файлу на конфигурацию в `data/env/`, сводный файл — последний из них.

<!-- report_tables:begin stand -->
| Характеристика | Значение |
|---|---|
| Процессор | AMD Ryzen 7 7700 8-Core Processor |
| Логических CPU, видимых контейнеру | 16 |
| ОЗУ, видимая контейнеру, МБ | 31 647,6 |
| ОС контейнеров (ядро WSL2) | Linux-6.18.33.2-microsoft-standard-WSL2-x86_64-with-glibc2.41 |
| Docker | Docker version 29.8.0, build 88096ef |
| Docker Compose | 5.5.1 |
| Лимиты bench-postgres и bench-redis | CPU 2,0, память 4 096 МБ (Redis: CPU 2,0, 4 096 МБ) |
| Диск с данными СУБД | /dev/sdd, ext4, 1 006,85 ГБ |
| PostgreSQL | 16.15 |
| Redis | 7.4.11 |
| Python | 3.12.14 |
| psycopg / psycopg-pool | 3.2.3 / 3.3.3 |
| redis-py / hiredis | 5.1.1 / 3.4.2 |
| numpy / matplotlib | 2.1.3 / 3.9.2 |
| Полный прогон `./at.sh bench all` | 2026-09-25T12:23:21Z … 2026-09-25T13:55:27Z, 5 526 с |
<!-- report_tables:end stand -->

Обе СУБД ограничены одинаково. Данные СУБД лежат на виртуальном диске WSL2 (ext4) внутри Docker Desktop, а не на файловой системе Windows. Поэтому fsync здесь — это сброс виртуального диска WSL2. Абсолютные времена записи в строгом режиме относятся к этому стенду и не переносятся на серверное железо.

## 3. Сущности и связи

<!-- report_tables:begin entities -->
| Сущность | Атрибуты | Записей |
|---|---|---:|
| organizations | id, type, name, inn, region_code, trust_rating, created_at | 10 000 |
| batches | id, public_code, product, origin_org_id, holder_org_id, kind, mass_kg, status, harvested_at, version | 10 000 |
| batch_links | parent_id, child_id, mass_used_kg, link_type, created_at | 10 069 |
| lab_tests | id, batch_id, lab_org_id, reason, conclusion, value, due_at | 10 000 |
<!-- report_tables:end entities -->

Связи:

- organizations 1:N batches — по происхождению (`origin_org_id`) и по держателю (`holder_org_id`);
- batches N:M batches через batch_links — ориентированный ациклический граф переработки;
- batches 1:N lab_tests;
- organizations 1:N lab_tests — через лабораторию (`lab_org_id`).

Генератор создаёт 60% сырьевых партий и 40% производных, у каждой производной 1–4 родителя из более ранних партий. Поэтому граф ацикличен по построению, а рёбер получается чуть больше, чем партий (число в таблице выше — фактическое). Число записей взято из количества ключей Redis после загрузки. В PostgreSQL загружены те же CSV, это проверяет тест эквивалентности данных (`tests/test_load_equivalence.py`).

```mermaid
erDiagram
    organizations ||--o{ batches : "origin / holder"
    batches ||--o{ batch_links : "parent"
    batches ||--o{ batch_links : "child"
    batches ||--o{ lab_tests : "batch"
    organizations ||--o{ lab_tests : "lab"
```

## 4. Схемы

### 4.1. PostgreSQL

Файл схемы — `benchmark/agrobench/schema_pg.sql`. Все ключи имеют тип `bigint`, чтобы их можно было сравнивать с числовыми id в Redis. Есть внешние ключи и CHECK на перечисления и положительные массы. Поле `batches.version` нужно для оптимистичной блокировки в W3. У `batch_links` естественный первичный ключ `(parent_id, child_id)`.

| Индекс | Зачем |
|---|---|
| `batches(public_code)` UNIQUE | R2: поиск партии по коду с QR-этикетки, уникальность кода |
| `batches(holder_org_id, status, harvested_at DESC) INCLUDE (public_code, mass_kg)` | R3: фильтр и сортировка «держатель + статус, новые сначала» берутся из индекса; R6 использует его префикс |
| `batch_links(parent_id)`, `batch_links(child_id)` | R5: обход графа вниз; D1: удаление рёбер с обеих сторон |
| `lab_tests(batch_id)` | R4: анализы партии; D1 |
| `lab_tests(due_at)` | D2: удаление по сроку |

Почему так: реляционная модель хранит каждый факт один раз, а индексы, целостность связей и атомарность изменений поддерживает сама СУБД. Любой новый запрос по этим данным — фильтр, соединение или агрегат — пишется без изменения схемы хранения.

### 4.2. Redis

| Ключ | Тип | Содержимое и зачем |
|---|---|---|
| `org:{id}`, `batch:{id}`, `test:{id}` | Hash | атрибуты записи; R1 и R4 — один `HGETALL` |
| `batch:code:{public_code}` | String | id партии: уникальный вторичный индекс для R2 |
| `batch:{id}:children`, `batch:{id}:parents` | Set | рёбра графа в обе стороны: R5 вниз, D1 чистит соседей |
| `link:{parent}:{child}` | Hash | атрибуты ребра |
| `org:{id}:held` | Sorted Set | партии держателя, score — `harvested_at` |
| `org:{id}:held:{status}` | Sorted Set | то же с разбивкой по статусу: R3 одним `ZREVRANGE` |
| `batch:{id}:tests` | List | id анализов партии для R4 |
| `tests:by_due` | Sorted Set | анализы по `due_at` для D2 |
| `stats:org:{id}` | Hash | счётчики партий по статусам: R6 без вычислений |
| `seq:{entity}` | String | генерация id через `INCR` |

Почему так: в Redis нет запросов по значениям, есть только доступ по ключу. Поэтому под каждый запрос заранее строится своя структура:

- sorted set — для «последних N» и диапазонов по времени;
- set — для рёбер графа;
- hash — для счётчиков агрегата.

Цена такой схемы в том, что каждую вторичную структуру обновляет приложение, и обновлять её надо атомарно вместе с основной записью:

- W1 выполняет пять команд в `MULTI/EXEC`;
- W3 и D1 — Lua-скрипты;
- согласованность индексов проверяют тесты-инварианты (`tests/test_redis_invariants.py`).

Все осознанные различия реализаций описаны в `benchmark/ASYMMETRIES.md`.

## 5. Генерация и загрузка данных

Данные генерирует `benchmark/agrobench/generate.py`:

- seed фиксирован, `--scale` по умолчанию 10 000;
- статусы распределены по долям ТЗ (Approved 45%, Accepted 20%, OnSale 15%, остальное поровну между прочими статусами);
- 3% анализов имеют итог FAIL;
- граф — DAG глубиной до 12;
- `harvested_at` уникален во всём наборе, это нужно для одинакового порядка в R3.

Загрузка:

- **PostgreSQL** (`load_pg.py`): `COPY` в таблицы без вторичных индексов (первичные ключи объявлены в `CREATE TABLE`), затем создание шести вторичных индексов и `ANALYZE`.
- **Redis** (`load_redis.py`): pipeline по 10 000 команд, на время загрузки выключены `save` и `appendonly`, после загрузки включается режим надёжности конфигурации.

Загрузка выполнялась по одному разу для каждой из четырёх конфигураций, поэтому ниже одиночные замеры, а не медианы.

<!-- report_tables:begin load -->
| Конфигурация | PG COPY organizations | COPY batches | COPY batch_links | COPY lab_tests | индексы + ANALYZE | PG всего | Redis всего |
|---|---:|---:|---:|---:|---:|---:|---:|
| по умолчанию, строгий | 0,023 | 0,297 | 0,294 | 0,292 | 0,204 | 1,110 | 0,439 |
| по умолчанию, ослабленный | 0,020 | 0,346 | 0,331 | 0,303 | 0,171 | 1,170 | 0,644 |
| оптимизированная, строгий | 0,023 | 0,251 | 0,257 | 0,280 | 0,195 | 1,006 | 0,429 |
| оптимизированная, ослабленный | 0,019 | 0,253 | 0,254 | 0,266 | 0,163 | 0,955 | 0,456 |
<!-- report_tables:end load -->

![Время загрузки](img/databases/load.png)

Redis загружается быстрее: pipeline только передаёт команды в память, а PostgreSQL пишет страницы таблиц вместе с индексами первичных ключей и затем строит шесть вторичных индексов. Замеры неравноценны в одном: время Redis не включает чтение CSV в клиенте (файлы прочитаны до старта таймера), а время `COPY` включает разбор CSV на сервере. Разброс между конфигурациями (например, Redis «по умолчанию, ослабленный» против остальных) — однократный замер на неизолированном хосте, выводов о конфигурации из него делать нельзя.

Размер данных после загрузки:

<!-- report_tables:begin memory_pg -->
| Таблица | данные, МБ | индексы, МБ | всего (pg_total_relation_size), МБ |
|---|---:|---:|---:|
| organizations | 1,18 | 0,25 | 1,45 |
| batches | 1,25 | 1,34 | 2,61 |
| batch_links | 1,18 | 0,81 | 2,02 |
| lab_tests | 1,25 | 0,57 | 1,84 |
| вся база (pg_database_size, вместе с системным каталогом) |  |  | 16,31 |
<!-- report_tables:end memory_pg -->

<!-- report_tables:begin memory_redis -->
| Ключ | ключей | MEMORY USAGE, байт на ключ (выборка) | оценка, МБ |
|---|---:|---:|---:|
| `batch:{id}` (Hash) | 10 000 | 273,6 | 2,74 |
| `org:{id}` (Hash) | 10 000 | 182,2 | 1,82 |
| `test:{id}` (Hash) | 10 000 | 184,0 | 1,84 |
| `link:{parent}:{child}` (Hash) | 10 069 | 152,0 | 1,53 |
| `tests:by_due` (Sorted Set) | 1 | 917 408,0 | 0,92 |
| `org:{id}:held:{status}` (Sorted Set) | 8 625 | 88,0 | 0,76 |
| `batch:code:{code}` (String) | 10 000 | 72,0 | 0,72 |
| `batch:{id}:tests` (List) | 6 340 | 81,1 | 0,51 |
| `stats:org:{id}` (Hash) | 5 935 | 84,5 | 0,50 |
| `org:{id}:held` (Sorted Set) | 5 935 | 83,0 | 0,49 |
| `batch:{id}:children` (Set) | 5 996 | 80,0 | 0,48 |
| `batch:{id}:parents` (Set) | 4 000 | 80,0 | 0,32 |
| `seq:{entity}` (String) | 3 | 58,7 | 0,00 |
<!-- report_tables:end memory_redis -->

<!-- report_tables:begin memory_totals -->
| Конфигурация | PG: база, МБ | Redis used_memory, МБ | dataset, МБ | overhead, МБ | RSS, МБ | фрагментация | ключей |
|---|---:|---:|---:|---:|---:|---:|---:|
| по умолчанию, строгий | 15,91 | 14,93 | 9,42 | 5,51 | 23,26 | 1,56 | 86 904 |
| по умолчанию, ослабленный | 16,30 | 14,93 | 9,42 | 5,51 | 23,09 | 1,55 | 86 904 |
| оптимизированная, строгий | 16,31 | 14,93 | 9,45 | 5,47 | 23,43 | 1,58 | 86 904 |
| оптимизированная, ослабленный | 16,41 | 14,93 | 9,45 | 5,47 | 23,29 | 1,57 | 86 904 |
<!-- report_tables:end memory_totals -->

![Объём данных](img/databases/memory.png)

Как читать таблицы:

- «данные» — `pg_relation_size` (основной слой таблицы), «всего» — `pg_total_relation_size` (данные, индексы, карты видимости и свободного места).
- Размер всей базы включает системный каталог PostgreSQL.
- Оценки по ключам Redis — это средний `MEMORY USAGE` по выборке ключей, умноженный на их число. `MEMORY USAGE` учитывает и накладные расходы на сам ключ, поэтому сумма оценок не равна `used_memory_dataset`.

Выводы:

- **Объём сопоставим.** Redis держит весь набор в оперативной памяти и занимает её примерно столько же, сколько PostgreSQL на диске.
- **RSS выше из-за фрагментации.** RSS процесса Redis заметно выше `used_memory`: коэффициент фрагментации аллокатора 1,58 в оптимизированной строгой конфигурации.
- **Вторичные индексы Redis дорогие.** Структуры `held`, `held:{status}`, `stats`, `tests`, `children/parents` и `tests:by_due` — это копии связей, которые в PostgreSQL даёт один индекс или запрос.
- **Настройка listpack не повлияла на объём.** `hash-max-listpack-*` из оптимизированной конфигурации объём не изменила: хеши здесь маленькие и компактную кодировку получают уже при значениях по умолчанию.

## 6. Запросы

Реализации лежат в `benchmark/agrobench/queries/` (`pg.py`, `redis.py`, `lua/`). У функций обеих СУБД одинаковые сигнатуры. Тест `tests/test_query_equivalence.py` проверяет на малом наборе, что на одинаковых входах обе СУБД дают одинаковый логический результат для всех ключей, включая DAG с общими потомками. Каждый вызов в PostgreSQL — один SQL-оператор (один сетевой обмен). В Redis число обменов определяется моделью данных.

| # | Тип | PostgreSQL | Redis | Обменов с Redis |
|---|---|---|---|---|
| R1 | чтение | партия по id | `HGETALL batch:{id}` | один |
| R2 | чтение | партия по `public_code` | `GET batch:code:{c}`, затем `HGETALL` | два |
| R3 | чтение | партии держателя в статусе, новые сначала, `LIMIT 50` | `ZREVRANGE org:{id}:held:{s} 0 49`, затем pipeline `HGETALL` | два |
| R4 | связанные | партия + держатель + анализы: `JOIN` и `json_agg` | `HGETALL` партии и `LRANGE` анализов, затем pipeline `HGETALL` держателя и анализов | два |
| R5 | граф | потомки партии, `WITH RECURSIVE`, глубина до `20` | BFS в Python с pipeline `SMEMBERS` на уровень или Lua-скрипт | по уровням / один |
| R6 | агрегат | число партий держателя по статусам, `GROUP BY` | `HGETALL stats:org:{id}` | один |
| W1 | запись | `INSERT` партии | `MULTI`: hash, code, два zset, stats | один |
| W2 | запись | пакет партий: `COPY` и multi-row `INSERT` (`unnest`) | pipeline из W1 (без `MULTI` на весь пакет) | по `1000` партий |
| W3 | обновление | `UPDATE … WHERE version = $v` | Lua: проверка версии, `HSET`, перенос между zset, `HINCRBY` | один |
| D1 | удаление | партия с рёбрами и анализами: три `DELETE` в CTE одного оператора | Lua: hash, индексы, рёбра у соседей, анализы | один |
| D2 | удаление | `DELETE FROM lab_tests WHERE due_at < $t` | `ZRANGEBYSCORE tests:by_due`, затем pipeline удаления по `1000` | по два на пачку |

Ключевой код — обход графа (R5). PostgreSQL:

```sql
WITH RECURSIVE descendants(id, depth) AS (
    SELECT child_id, 1 FROM batch_links WHERE parent_id = %s
    UNION
    SELECT bl.child_id, d.depth + 1
    FROM batch_links bl
    JOIN descendants d ON bl.parent_id = d.id
    WHERE d.depth < %s
)
SELECT DISTINCT id FROM descendants
```

Redis, Lua-вариант (`lua/r5_descendants.lua`, вызывается через `EVALSHA`):

```lua
local visited, frontier, result, depth = { [ARGV[1]] = true }, { ARGV[1] }, {}, 0
while #frontier > 0 and depth < tonumber(ARGV[2]) do
  local next_frontier = {}
  for _, bid in ipairs(frontier) do
    for _, child in ipairs(redis.call('SMEMBERS', 'batch:' .. bid .. ':children')) do
      if not visited[child] then
        visited[child] = true
        table.insert(next_frontier, child); table.insert(result, child)
      end
    end
  end
  frontier, depth = next_frontier, depth + 1
end
return result
```

Смена статуса с проверкой версии (W3). В PostgreSQL это одна строка `UPDATE batches SET status = %s, version = version + 1 WHERE id = %s AND version = %s`. В Redis то же самое делает Lua-скрипт, который вручную переносит партию между индексами:

```lua
local current_version = redis.call('HGET', batch_key, 'version')
if not current_version or tonumber(current_version) ~= expected_version then return 0 end
local old_status = redis.call('HGET', batch_key, 'status')
local holder = redis.call('HGET', batch_key, 'holder_org_id')
redis.call('HSET', batch_key, 'status', new_status, 'version', tostring(expected_version + 1))
if old_status ~= new_status then
  redis.call('ZREM', 'org:' .. holder .. ':held:' .. old_status, id)
  local score = redis.call('ZSCORE', 'org:' .. holder .. ':held', id) or 0
  redis.call('ZADD', 'org:' .. holder .. ':held:' .. new_status, score, id)
  redis.call('HINCRBY', 'stats:org:' .. holder, old_status, -1)
  redis.call('HINCRBY', 'stats:org:' .. holder, new_status, 1)
end
return 1
```

Удаление с каскадом (D1) в PostgreSQL — один оператор. Проверки внешних ключей откладываются до конца оператора, поэтому `ON DELETE CASCADE` не нужен:

```sql
WITH deleted_tests AS (DELETE FROM lab_tests WHERE batch_id = %s),
     deleted_links AS (DELETE FROM batch_links WHERE parent_id = %s OR child_id = %s),
     deleted_batch AS (DELETE FROM batches WHERE id = %s RETURNING id)
SELECT count(*) FROM deleted_batch
```

## 7. Оптимизация

### 7.1. Что изменено и почему

<!-- report_tables:begin settings -->
| Параметр | по умолчанию | оптимизированная |
|---|---|---|
| PostgreSQL shared_buffers | 128MB | 1GB |
| PostgreSQL effective_cache_size | 4GB | 2867MB |
| PostgreSQL work_mem | 4MB | 32MB |
| PostgreSQL maintenance_work_mem | 64MB | 512MB |
| PostgreSQL random_page_cost | 4 | 1.1 |
| PostgreSQL effective_io_concurrency | 1 | 200 |
| PostgreSQL max_wal_size | 1GB | 4GB |
| Redis maxmemory | 0 | 3221225472 |
| Redis maxmemory-policy | noeviction | noeviction |
| Redis hash-max-listpack-entries | 128 | 512 |
| Redis hash-max-listpack-value | 64 | 128 |
| Redis lazyfree-lazy-user-del | no | yes |
| Redis lazyfree-lazy-server-del | no | yes |
| Redis io-threads | 1 | 2 |
| Redis save | 3600 1 300 100 60 10000 | "" (выключено) |
<!-- report_tables:end settings -->

**PostgreSQL.** Значения рассчитаны на лимит контейнера 4 ГБ:

- `shared_buffers` = 25% памяти, `effective_cache_size` = 70%;
- `work_mem` увеличен, чтобы сортировки и хеш-агрегаты не уходили на диск;
- `maintenance_work_mem` увеличен для построения индексов после `COPY`;
- `random_page_cost = 1.1`: данные в кэше и на SSD, случайное чтение почти не дороже последовательного;
- `effective_io_concurrency` — под SSD;
- `max_wal_size` увеличен, чтобы при записи реже срабатывали контрольные точки.

В обеих конфигурациях одинаковы покрывающий индекс для R3, `ANALYZE` после загрузки, пул соединений (`psycopg_pool`) и подготовленные запросы (psycopg готовит оператор на сервере с пятого выполнения на соединении). Конфигурация меняет только параметры сервера. Вклад подготовленных запросов измерен отдельно (п. 7.3).

**Redis:**

- `maxmemory` ниже лимита контейнера, политика `noeviction`: это хранилище данных, а не кэш, вытеснять ничего нельзя;
- крупнее пороги listpack для компактных хешей;
- `lazyfree-lazy-*`: освобождение памяти в фоновом потоке;
- `io-threads 2`: чтение и запись сокетов в двух потоках;
- `save ""`: RDB-снимки отключены, надёжность обеспечивает только AOF.

В обеих конфигурациях одинаковы pipelining, Lua вместо цепочек запросов (R5 вариант 2, W3, D1), отказ от `KEYS` и отключение персистентности на время загрузки. `SLOWLOG` и `LATENCY` включены для диагностики.

Режимы надёжности (ТЗ §13.6) заданы одинаково для обеих конфигураций. Значения в таблице прочитаны с работающих серверов (`SHOW` и `CONFIG GET`), расхождение с профилем прерывает прогон:

<!-- report_tables:begin durability -->
| Параметр (значение с работающего сервера) | строгий | ослабленный |
|---|---|---|
| PostgreSQL synchronous_commit | on | off |
| PostgreSQL fsync | on | on |
| PostgreSQL full_page_writes | on | on |
| PostgreSQL wal_sync_method | fdatasync | fdatasync |
| Redis appendonly | yes | yes |
| Redis appendfsync | always | everysec |
<!-- report_tables:end durability -->

### 7.2. Планы до и после

`EXPLAIN (ANALYZE, BUFFERS)` сохранён для R3, R4, R5 (медианный и самый большой набор потомков), R6, D1 и D2 во всех конфигурациях (`data/plans/`). Главное изменение даёт `random_page_cost`.

R3 «по умолчанию» (`random_page_cost = 4`): планировщик выбирает Bitmap Index Scan, затем Bitmap Heap Scan и отдельную сортировку.

<!-- report_tables:begin plan_R3_default -->
```text
-- parameters: holder=7656 status=Approved (the pair with most batches: 6)
Limit  (cost=15.12..15.13 rows=3 width=83) (actual time=0.101..0.102 rows=6 loops=1)
  Buffers: shared hit=15 read=2
  ->  Sort  (cost=15.12..15.13 rows=3 width=83) (actual time=0.100..0.101 rows=6 loops=1)
        Sort Key: harvested_at DESC, id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=15 read=2
        ->  Bitmap Heap Scan on batches  (cost=4.32..15.10 rows=3 width=83) (actual time=0.041..0.064 rows=6 loops=1)
              Recheck Cond: ((holder_org_id = '7656'::smallint) AND ((status)::text = 'Approved'::text))
              Heap Blocks: exact=6
              Buffers: shared hit=9 read=2
              ->  Bitmap Index Scan on ix_batches_holder_status_harvested  (cost=0.00..4.32 rows=3 width=0) (actual time=0.033..0.033 rows=6 loops=1)
                    Index Cond: ((holder_org_id = '7656'::smallint) AND ((status)::text = 'Approved'::text))
                    Buffers: shared hit=3 read=2
Planning:
  Buffers: shared hit=161 read=2
Planning Time: 0.716 ms
Execution Time: 0.155 ms
```
<!-- report_tables:end plan_R3_default -->

R3 «оптимизированная» (`random_page_cost = 1.1`): простой Index Scan по покрывающему индексу. Порядок `harvested_at DESC` берётся из индекса, поэтому остаётся только Incremental Sort для добивки по `id`.

<!-- report_tables:begin plan_R3_tuned -->
```text
-- parameters: holder=7656 status=Approved (the pair with most batches: 6)
Limit  (cost=1.78..4.88 rows=3 width=83) (actual time=0.177..0.179 rows=6 loops=1)
  Buffers: shared hit=18 read=2
  ->  Incremental Sort  (cost=1.78..4.88 rows=3 width=83) (actual time=0.177..0.177 rows=6 loops=1)
        Sort Key: harvested_at DESC, id DESC
        Presorted Key: harvested_at
        Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
        Buffers: shared hit=18 read=2
        ->  Index Scan using ix_batches_holder_status_harvested on batches  (cost=0.29..4.74 rows=3 width=83) (actual time=0.065..0.121 rows=6 loops=1)
              Index Cond: ((holder_org_id = '7656'::smallint) AND ((status)::text = 'Approved'::text))
              Buffers: shared hit=9 read=2
Planning:
  Buffers: shared hit=160 read=2
Planning Time: 0.858 ms
Execution Time: 0.215 ms
```
<!-- report_tables:end plan_R3_tuned -->

Покрывающая часть индекса (`INCLUDE`) в этом запросе не даёт Index Only Scan: R3 возвращает все поля партии, и за ними всё равно нужно идти в таблицу.

R4 до и после: анализы партии читаются через Bitmap Heap Scan или Index Scan по `ix_lab_tests_batch`. Остальная часть плана одинакова — два Index Scan по первичным ключам и Nested Loop.

<!-- report_tables:begin plan_R4_default -->
```text
-- parameters: batch=6760 (most lab tests: 7)
Nested Loop  (cost=0.57..28.29 rows=1 width=166) (actual time=0.148..0.149 rows=1 loops=1)
  Buffers: shared hit=13 read=2
  ->  Index Scan using batches_pkey on batches b  (cost=0.29..8.30 rows=1 width=83) (actual time=0.026..0.026 rows=1 loops=1)
        Index Cond: (id = '6760'::smallint)
        Buffers: shared hit=3
  ->  Index Scan using organizations_pkey on organizations o  (cost=0.29..8.30 rows=1 width=51) (actual time=0.018..0.018 rows=1 loops=1)
        Index Cond: (id = b.holder_org_id)
        Buffers: shared hit=3
  SubPlan 1
    ->  Aggregate  (cost=11.67..11.68 rows=1 width=32) (actual time=0.098..0.099 rows=1 loops=1)
          Buffers: shared hit=7 read=2
          ->  Sort  (cost=11.65..11.65 rows=2 width=51) (actual time=0.072..0.073 rows=7 loops=1)
                Sort Key: t.id
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=7 read=2
                ->  Bitmap Heap Scan on lab_tests t  (cost=4.30..11.64 rows=2 width=51) (actual time=0.029..0.060 rows=7 loops=1)
                      Recheck Cond: (batch_id = b.id)
                      Heap Blocks: exact=7
                      Buffers: shared hit=7 read=2
                      ->  Bitmap Index Scan on ix_lab_tests_batch  (cost=0.00..4.30 rows=2 width=0) (actual time=0.022..0.022 rows=7 loops=1)
                            Index Cond: (batch_id = b.id)
                            Buffers: shared read=2
Planning:
  Buffers: shared hit=145 read=4
Planning Time: 0.811 ms
Execution Time: 0.214 ms
```
<!-- report_tables:end plan_R4_default -->

<!-- report_tables:begin plan_R4_tuned -->
```text
-- parameters: batch=6760 (most lab tests: 7)
Nested Loop  (cost=0.57..8.67 rows=1 width=166) (actual time=0.142..0.143 rows=1 loops=1)
  Buffers: shared hit=13 read=2
  ->  Index Scan using batches_pkey on batches b  (cost=0.29..2.50 rows=1 width=83) (actual time=0.023..0.024 rows=1 loops=1)
        Index Cond: (id = '6760'::smallint)
        Buffers: shared hit=3
  ->  Index Scan using organizations_pkey on organizations o  (cost=0.29..2.50 rows=1 width=51) (actual time=0.017..0.017 rows=1 loops=1)
        Index Cond: (id = b.holder_org_id)
        Buffers: shared hit=3
  SubPlan 1
    ->  Aggregate  (cost=3.66..3.67 rows=1 width=32) (actual time=0.097..0.098 rows=1 loops=1)
          Buffers: shared hit=7 read=2
          ->  Sort  (cost=3.63..3.63 rows=2 width=51) (actual time=0.071..0.071 rows=7 loops=1)
                Sort Key: t.id
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=7 read=2
                ->  Index Scan using ix_lab_tests_batch on lab_tests t  (cost=0.29..3.62 rows=2 width=51) (actual time=0.031..0.059 rows=7 loops=1)
                      Index Cond: (batch_id = b.id)
                      Buffers: shared hit=7 read=2
Planning:
  Buffers: shared hit=145 read=4
Planning Time: 0.884 ms
Execution Time: 0.204 ms
```
<!-- report_tables:end plan_R4_tuned -->

R5 на самом большом наборе потомков: рекурсия идёт по индексу `ix_batch_links_parent`, по одному Index Scan на каждую найденную вершину.

<!-- report_tables:begin plan_R5_max_tuned -->
```text
-- parameters: batch=917 (largest descendant set: 22), max_depth=20
HashAggregate  (cost=562.48..564.48 rows=200 width=8) (actual time=0.169..0.171 rows=22 loops=1)
  Group Key: descendants.id
  Batches: 1  Memory Usage: 40kB
  Buffers: shared hit=60 read=8
  CTE descendants
    ->  Recursive Union  (cost=0.29..555.84 rows=295 width=12) (actual time=0.028..0.162 rows=22 loops=1)
          Buffers: shared hit=60 read=8
          ->  Index Scan using ix_batch_links_parent on batch_links  (cost=0.29..6.75 rows=5 width=12) (actual time=0.027..0.045 rows=5 loops=1)
                Index Cond: (parent_id = '917'::smallint)
                Buffers: shared hit=5 read=2
          ->  Nested Loop  (cost=0.29..54.61 rows=29 width=12) (actual time=0.008..0.022 rows=3 loops=5)
                Buffers: shared hit=55 read=6
                ->  WorkTable Scan on descendants d  (cost=0.00..1.12 rows=17 width=12) (actual time=0.000..0.000 rows=4 loops=5)
                      Filter: (depth < '20'::smallint)
                ->  Index Scan using ix_batch_links_parent on batch_links bl  (cost=0.29..3.12 rows=2 width=16) (actual time=0.003..0.005 rows=1 loops=22)
                      Index Cond: (parent_id = d.id)
                      Buffers: shared hit=55 read=6
  ->  CTE Scan on descendants  (cost=0.00..5.90 rows=295 width=8) (actual time=0.028..0.164 rows=22 loops=1)
        Buffers: shared hit=60 read=8
Planning:
  Buffers: shared hit=52 read=2
Planning Time: 0.356 ms
Execution Time: 0.265 ms
```
<!-- report_tables:end plan_R5_max_tuned -->

D1: три удаления в одном операторе. Заметная часть времени уходит на проверку внешних ключей (строки `Trigger for constraint`): это цена целостности, которой в Redis нет.

<!-- report_tables:begin plan_D1_tuned -->
```text
-- parameters: batch=6760 (rolled back)
Aggregate  (cost=18.80..18.81 rows=1 width=8) (actual time=0.089..0.089 rows=1 loops=1)
  Buffers: shared hit=13
  CTE deleted_tests
    ->  Delete on lab_tests  (cost=1.44..9.08 rows=0 width=0) (actual time=0.023..0.023 rows=0 loops=1)
          Buffers: shared hit=16
          ->  Bitmap Heap Scan on lab_tests  (cost=1.44..9.08 rows=7 width=6) (actual time=0.014..0.022 rows=7 loops=1)
                Recheck Cond: (batch_id = '6760'::smallint)
                Heap Blocks: exact=7
                Buffers: shared hit=9
                ->  Bitmap Index Scan on ix_lab_tests_batch  (cost=0.00..1.44 rows=7 width=0) (actual time=0.012..0.012 rows=7 loops=1)
                      Index Cond: (batch_id = '6760'::smallint)
                      Buffers: shared hit=2
  CTE deleted_links
    ->  Delete on batch_links  (cost=2.80..7.20 rows=0 width=0) (actual time=0.037..0.037 rows=0 loops=1)
          Buffers: shared hit=7 read=2
          ->  Bitmap Heap Scan on batch_links  (cost=2.80..7.20 rows=4 width=6) (actual time=0.034..0.036 rows=3 loops=1)
                Recheck Cond: ((parent_id = '6760'::smallint) OR (child_id = '6760'::smallint))
                Heap Blocks: exact=2
                Buffers: shared hit=4 read=2
                ->  BitmapOr  (cost=2.80..2.80 rows=4 width=0) (actual time=0.026..0.026 rows=0 loops=1)
                      Buffers: shared hit=2 read=2
                      ->  Bitmap Index Scan on ix_batch_links_parent  (cost=0.00..1.40 rows=2 width=0) (actual time=0.003..0.003 rows=1 loops=1)
                            Index Cond: (parent_id = '6760'::smallint)
                            Buffers: shared hit=2
                      ->  Bitmap Index Scan on ix_batch_links_child  (cost=0.00..1.40 rows=2 width=0) (actual time=0.022..0.022 rows=2 loops=1)
                            Index Cond: (child_id = '6760'::smallint)
                            Buffers: shared read=2
  CTE deleted_batch
    ->  Delete on batches  (cost=0.29..2.50 rows=1 width=6) (actual time=0.085..0.086 rows=1 loops=1)
          Buffers: shared hit=13
          ->  Index Scan using batches_pkey on batches  (cost=0.29..2.50 rows=1 width=6) (actual time=0.016..0.016 rows=1 loops=1)
                Index Cond: (id = '6760'::smallint)
                Buffers: shared hit=3
  ->  CTE Scan on deleted_batch  (cost=0.00..0.02 rows=1 width=0) (actual time=0.086..0.087 rows=1 loops=1)
        Buffers: shared hit=13
Planning Time: 0.070 ms
Trigger for constraint batch_links_parent_id_fkey on batches: time=0.184 calls=1
Trigger for constraint batch_links_child_id_fkey on batches: time=0.083 calls=1
Trigger for constraint lab_tests_batch_id_fkey on batches: time=0.086 calls=1
Execution Time: 0.703 ms
```
<!-- report_tables:end plan_D1_tuned -->

На этом наборе данных все планы выполняются за доли миллисекунды: весь набор помещается в `shared_buffers` даже в конфигурации по умолчанию. Смена плана заметна в `EXPLAIN`, но почти не видна в задержке клиента (п. 9.3).

### 7.3. Подготовленные запросы PostgreSQL

Та же нагрузка (1 клиент, равномерные ключи, p50 в мкс) с отключённой подготовкой операторов:

<!-- report_tables:begin prepared -->
| Запрос | по умолчанию: подготовленный | по умолчанию: без подготовки | оптимизированная: подготовленный | оптимизированная: без подготовки |
|---|---:|---:|---:|---:|
| R1 | 199,9 | 233,2 | 184,9 | 226,0 |
| R2 | 196,1 | 237,0 | 185,4 | 237,2 |
| R3 | 196,3 | 284,4 | 195,0 | 258,3 |
| R4 | 271,0 | 603,0 | 273,3 | 561,2 |
| R5 (WITH RECURSIVE) | 265,6 | 411,9 | 249,6 | 400,4 |
| R6 | 194,2 | 226,9 | 182,8 | 222,5 |
<!-- report_tables:end prepared -->

![Подготовленные запросы](img/databases/prepared.png)

Из всех оптимизаций PostgreSQL на этом наборе это самая заметная. Сильнее всего она влияет на запросы со сложным планированием: R4 (соединение с подзапросом) — 273,3 против 561,2 мкс, R5 (рекурсия) — 249,6 против 400,4 мкс в оптимизированной конфигурации. У простых R1 и R6 выигрыш — десятки микросекунд.

## 8. Методика

Как проводились замеры:

- **Клиент.** Python 3.12, psycopg 3 (`AsyncConnectionPool`) и redis-py с hiredis (`redis.asyncio`). Время каждого вызова измеряется `time.perf_counter_ns` вокруг `await op(conn, *args)`. Сборщик мусора на время серии выключен.
- **Форма вызова.** Одинакова для обеих СУБД: один язык, одна форма вызова, одинаковые последовательности ключей и одинаковые подготовленные записи. Код: `benchmark/agrobench/measure.py`, `workload.py`, `run.py`.
- **Чтение.** Прогрев — 1 000 вызовов, затем 10 000 измерений на случайных ключах. Ключи выбираются равномерно и по Zipf 1.1: seed фиксирован, «горячее» множество одинаково для обеих СУБД.
- **Пачки для быстрых операций.** ТЗ предписывает замерять пачками по 1 000 операции быстрее 50 мкс. Здесь таких не нашлось: сетевой переход Docker плюс клиент дают около 140 мкс на любой вызов. Поэтому все серии измерены поштучно, это записано в колонке `method` CSV.
- **Запись и удаление.** Операции идут на заранее подготовленных записях с id от 10⁹, так что основной набор не меняется. После каждой серии набор возвращается к исходному состоянию, и это проверяется отпечатком: для PostgreSQL — число строк и md5 всех строк, для Redis — `DBSIZE` и `DEBUG DIGEST`.
- **Объём серий записи.**
  - W1, W3, D1: 1 000 измерений при 1 клиенте и 10 000 при 16 клиентах.
  - W2 (пакет из 10 000 партий): 20 измерений на прогон. Поэтому для W2 приводятся только p50 и среднее, p95 и p99 на 20 точках не показательны.
  - D2 (удаление 1 000 анализов): 1 000 измерений на прогон.
  - W2 и D2 измерялись только при 1 клиенте.
- **16 клиентов.** Это 8 процессов по 2 asyncio-клиента, всего 16 соединений. Одного цикла событий Python не хватает, чтобы нагрузить СУБД. Каждый клиент прогревает своё соединение (не меньше 10 вызовов, то есть подготовленные операторы уже созданы), затем все берут вызовы из одной общей очереди.
  - «Эффективный параллелизм» (среднее × оп/с, закон Литтла) показывает, сколько вызовов в среднем реально выполнялось одновременно.
  - При 16 клиентах p50 всегда приводится вместе со средним и оп/с: хвост задержек здесь определяет пропускную способность.
- **Матрица.** Каждая СУБД измерялась отдельно во всех четырёх сочетаниях {по умолчанию, оптимизированная} × {строгий, ослабленный}; вторая СУБД в это время простаивала. Профиль простаивающей соседки на замер не влияет, поэтому полное произведение {PG} × {Redis} × {режим} свелось к этим четырём конфигурациям.
- **Повторы.** Каждая конфигурация прогнана 3 раза. В таблицах медиана трёх прогонов, в скобках — минимум и максимум p50 по прогонам.
- **Длительность.** Полный прогон `./at.sh bench all` с чистых томов — в таблице стенда (п. 2).

Ограничения, которые нужно учитывать при чтении чисел:

1. **Хост не был выделенным.** Параллельно работали другие compose-проекты (стек AgroTrace и т. п.), поэтому каждая конфигурация и прогнана трижды, а разброс показан. Пример шума: в конфигурации «оптимизированная, строгий» второй прогон W1 у PostgreSQL дал p50 2 932,5 мкс против примерно 1 300 мкс в двух других (см. п. 9.4). Колонка «по умолчанию, ослабленный» у PostgreSQL на чтении медленнее остальных по той же причине. Такие расхождения конфигурации не приписываются.
2. **Задержки включают сетевой переход Docker и клиентское время Python/asyncio.** При 1 клиенте клиент занимает около 0,7 ядра. Абсолютные значения поэтому клиентские. Сравнение СУБД между собой честное, потому что эта добавка одинакова, но разница серверного времени (единицы микросекунд у Redis, п. 9.4) тонет в ней.
3. **Redis при 16 клиентах частично упирается в клиента.** Клиентские процессы тратят около 6–7 ядер из 8. Реальный предел Redis выше, чем показано.
4. **PostgreSQL при 16 клиентах упирается в свои 2 CPU.** CFS-квота контейнера приостанавливает процессы. В результате у тяжёлых запросов (R4, R5, D1) p99 измеряется десятками миллисекунд, и среднее бывает больше p99: несколько очень долгих вызовов из самого верхнего процента сдвигают среднее сильнее, чем меняют сам p99.
5. **Данные маленькие** (десятки мегабайт) и целиком помещаются в память обеих СУБД. Замеры описывают работу с горячими данными, а не с диском.

## 9. Результаты

### 9.1. Чтение, 1 клиент

p50 и p95 в микросекундах, равномерные ключи, режим «строгий» (на чтение режим надёжности не влияет).

<!-- report_tables:begin reads_default -->
| Запрос | PG p50, мкс (мин–макс) | PG p95, мкс | Redis p50, мкс (мин–макс) | Redis p95, мкс |
|---|---:|---:|---:|---:|
| R1 | 199,9 (184,7–202,0) | 243,9 | 157,1 (143,0–158,2) | 195,4 |
| R2 | 196,1 (185,5–207,3) | 246,5 | 308,1 (278,6–309,4) | 376,4 |
| R3 | 196,3 (196,0–207,0) | 254,7 | 319,8 (294,4–324,6) | 392,0 |
| R4 | 271,0 (261,4–283,5) | 346,5 | 346,9 (312,0–361,8) | 415,0 |
| R5 (PG: WITH RECURSIVE, Redis: Lua) | 265,6 (249,4–280,6) | 343,3 | 163,8 (153,1–169,8) | 210,6 |
| R5 (Redis: BFS в Python) | — | — | 302,5 (279,2–318,9) | 738,4 |
| R6 | 194,2 (184,5–196,5) | 237,4 | 139,2 (138,2–157,9) | 188,4 |
<!-- report_tables:end reads_default -->

<!-- report_tables:begin reads_tuned -->
| Запрос | PG p50, мкс (мин–макс) | PG p95, мкс | Redis p50, мкс (мин–макс) | Redis p95, мкс |
|---|---:|---:|---:|---:|
| R1 | 184,9 (184,7–186,6) | 239,0 | 143,4 (143,2–145,4) | 197,7 |
| R2 | 185,4 (185,2–188,4) | 238,1 | 278,3 (277,6–279,8) | 373,1 |
| R3 | 195,0 (194,1–196,9) | 250,2 | 293,4 (293,0–307,0) | 401,1 |
| R4 | 273,3 (259,3–275,3) | 345,4 | 316,0 (315,4–317,9) | 424,5 |
| R5 (PG: WITH RECURSIVE, Redis: Lua) | 249,6 (248,6–259,9) | 323,4 | 156,7 (154,5–158,4) | 215,6 |
| R5 (Redis: BFS в Python) | — | — | 280,7 (280,3–282,2) | 729,7 |
| R6 | 182,8 (182,1–185,5) | 237,1 | 139,1 (139,0–139,4) | 189,4 |
<!-- report_tables:end reads_tuned -->

![Чтение: p50 и p95](img/databases/reads_latency.png)

Равномерные ключи против Zipf 1.1 (конфигурация «оптимизированная», p50, мкс):

<!-- report_tables:begin reads_zipf -->
| Запрос | PG равномерно | PG Zipf 1.1 | Redis равномерно | Redis Zipf 1.1 |
|---|---:|---:|---:|---:|
| R1 | 184,9 | 188,0 | 143,4 | 143,6 |
| R2 | 185,4 | 185,7 | 278,3 | 277,5 |
| R3 | 195,0 | 194,8 | 293,4 | 287,9 |
| R4 | 273,3 | 267,2 | 316,0 | 311,5 |
| R5 (PG: WITH RECURSIVE, Redis: Lua) | 249,6 | 246,8 | 156,7 | 158,4 |
| R5 (Redis: BFS в Python) | — | — | 280,7 | 262,3 |
| R6 | 182,8 | 182,3 | 139,1 | 138,7 |
<!-- report_tables:end reads_zipf -->

«Горячие» ключи почти ничего не меняют: весь набор уже в памяти обеих СУБД, и кэшировать дополнительно нечего.

### 9.2. Чтение, 16 клиентов

Конфигурация «оптимизированная», равномерные ключи.

<!-- report_tables:begin reads_c16 -->
| Запрос · СУБД | p50, мкс | среднее, мкс | p99, мкс | оп/с | эффективный параллелизм | CPU клиента, ядер |
|---|---:|---:|---:|---:|---:|---:|
| R1 · PostgreSQL | 329,5 | 639,6 | 616,3 | 24 672 | 15,78 | 4,13 |
| R1 · Redis | 219,9 | 228,3 | 449,5 | 68 332 | 15,57 | 6,57 |
| R2 · PostgreSQL | 327,9 | 589,1 | 557,4 | 26 747 | 15,76 | 4,48 |
| R2 · Redis | 434,3 | 447,8 | 767,2 | 35 272 | 15,81 | 6,48 |
| R3 · PostgreSQL | 349,1 | 674,9 | 853,2 | 22 338 | 15,77 | 3,84 |
| R3 · Redis | 437,2 | 439,7 | 747,4 | 35 934 | 15,80 | 6,78 |
| R4 · PostgreSQL | 445,5 | 1 675,4 | 69 328,8 | 9 498 | 15,91 | 2,07 |
| R4 · Redis | 453,2 | 450,0 | 811,5 | 35 164 | 15,81 | 7,04 |
| R5 (PG: WITH RECURSIVE, Redis: Lua) · PostgreSQL | 466,8 | 1 898,8 | 73 654,1 | 8 384 | 15,91 | 1,67 |
| R5 (PG: WITH RECURSIVE, Redis: Lua) · Redis | 358,0 | 363,6 | 604,4 | 43 331 | 15,77 | 4,46 |
| R5 (Redis: BFS в Python) · Redis | 382,9 | 465,9 | 1 495,9 | 33 948 | 15,82 | 6,76 |
| R6 · PostgreSQL | 312,6 | 700,8 | 587,9 | 22 534 | 15,79 | 3,54 |
| R6 · Redis | 196,2 | 210,9 | 399,2 | 73 817 | 15,47 | 6,88 |
<!-- report_tables:end reads_c16 -->

![Масштабирование чтения](img/databases/scaling.png)

### 9.3. Оптимизация: до и после

Режим «строгий», равномерные ключи.

<!-- report_tables:begin optimization -->
| Запрос · СУБД | p50 при 1 клиенте, мкс: по умолчанию | оптимизированная | оп/с при 16 клиентах: по умолчанию | оптимизированная |
|---|---:|---:|---:|---:|
| R1 · PostgreSQL | 199,9 (184,7–202,0) | 184,9 (184,7–186,6) | 23 760 | 24 672 |
| R1 · Redis | 157,1 (143,0–158,2) | 143,4 (143,2–145,4) | 40 873 | 68 332 |
| R2 · PostgreSQL | 196,1 (185,5–207,3) | 185,4 (185,2–188,4) | 25 400 | 26 747 |
| R2 · Redis | 308,1 (278,6–309,4) | 278,3 (277,6–279,8) | 20 892 | 35 272 |
| R3 · PostgreSQL | 196,3 (196,0–207,0) | 195,0 (194,1–196,9) | 20 274 | 22 338 |
| R3 · Redis | 319,8 (294,4–324,6) | 293,4 (293,0–307,0) | 20 333 | 35 934 |
| R4 · PostgreSQL | 271,0 (261,4–283,5) | 273,3 (259,3–275,3) | 9 502 | 9 498 |
| R4 · Redis | 346,9 (312,0–361,8) | 316,0 (315,4–317,9) | 19 052 | 35 164 |
| R5 (PG: WITH RECURSIVE, Redis: Lua) · PostgreSQL | 265,6 (249,4–280,6) | 249,6 (248,6–259,9) | 8 053 | 8 384 |
| R5 (PG: WITH RECURSIVE, Redis: Lua) · Redis | 163,8 (153,1–169,8) | 156,7 (154,5–158,4) | 32 102 | 43 331 |
| R5 (Redis: BFS в Python) · Redis | 302,5 (279,2–318,9) | 280,7 (280,3–282,2) | 19 254 | 33 948 |
| R6 · PostgreSQL | 194,2 (184,5–196,5) | 182,8 (182,1–185,5) | 23 661 | 22 534 |
| R6 · Redis | 139,2 (138,2–157,9) | 139,1 (139,0–139,4) | 44 503 | 73 817 |
<!-- report_tables:end optimization -->

![Влияние оптимизации](img/databases/optimization.png)

### 9.4. Запись и режимы надёжности

W1, W3, D1 в конфигурации «оптимизированная»: мкс и оп/с, «клиентов» — 1 или 16.

<!-- report_tables:begin writes_tuned -->
| Запрос · клиентов · СУБД | строгий: p50, мкс (мин–макс) | среднее, мкс | оп/с | ослабленный: p50, мкс (мин–макс) | среднее, мкс | оп/с |
|---|---:|---:|---:|---:|---:|---:|
| W1 · 1 · PostgreSQL | 1 345,9 (1 286,9–2 932,5) | 1 361,5 | 734 | 254,1 (248,4–257,1) | 261,1 | 3 809 |
| W1 · 1 · Redis | 2 528,4 (2 445,1–2 556,3) | 2 636,2 | 379 | 205,2 (204,9–207,6) | 213,6 | 4 655 |
| W1 · 16 · PostgreSQL | 2 319,7 (2 309,6–2 324,9) | 2 393,8 | 6 658 | 400,9 (395,5–434,2) | 1 514,4 | 10 499 |
| W1 · 16 · Redis | 5 351,1 (5 273,1–5 364,9) | 5 423,6 | 2 944 | 459,9 (435,3–495,7) | 460,1 | 34 305 |
| W3 · 1 · PostgreSQL | 1 326,7 (1 275,2–3 079,4) | 1 366,7 | 731 | 235,7 (234,0–238,3) | 246,4 | 4 025 |
| W3 · 1 · Redis | 2 472,9 (2 439,9–2 524,4) | 2 534,7 | 394 | 167,4 (165,8–197,0) | 178,6 | 5 556 |
| W3 · 16 · PostgreSQL | 2 292,4 (2 289,5–2 293,2) | 2 397,1 | 6 651 | 585,5 (563,4–590,0) | 1 686,5 | 9 444 |
| W3 · 16 · Redis | 5 366,0 (5 312,6–5 806,8) | 5 446,1 | 2 932 | 424,7 (417,9–426,1) | 432,6 | 36 546 |
| D1 · 1 · PostgreSQL | 1 436,6 (1 436,4–1 452,2) | 1 519,4 | 657 | 360,4 (357,2–368,2) | 376,2 | 2 648 |
| D1 · 1 · Redis | 2 490,2 (2 416,4–2 495,3) | 2 548,4 | 392 | 174,5 (172,5–175,1) | 182,3 | 5 447 |
| D1 · 16 · PostgreSQL | 2 260,4 (2 257,4–2 274,5) | 3 713,4 | 4 282 | 767,4 (762,6–784,1) | 4 002,3 | 3 987 |
| D1 · 16 · Redis | 5 492,4 (5 468,7–5 540,1) | 5 612,7 | 2 846 | 534,3 (525,5–537,5) | 561,0 | 28 270 |
<!-- report_tables:end writes_tuned -->

То же в конфигурации «по умолчанию»:

<!-- report_tables:begin writes_default -->
| Запрос · клиентов · СУБД | строгий: p50, мкс (мин–макс) | среднее, мкс | оп/с | ослабленный: p50, мкс (мин–макс) | среднее, мкс | оп/с |
|---|---:|---:|---:|---:|---:|---:|
| W1 · 1 · PostgreSQL | 1 353,6 (1 291,8–1 389,0) | 1 399,9 | 713 | 319,2 (281,8–410,5) | 329,7 | 3 016 |
| W1 · 1 · Redis | 2 458,4 (2 436,9–2 671,4) | 2 564,7 | 390 | 246,7 (240,6–257,1) | 250,9 | 3 962 |
| W1 · 16 · PostgreSQL | 2 319,6 (2 313,3–2 326,2) | 2 444,4 | 6 520 | 544,9 (402,5–810,5) | 1 818,6 | 8 741 |
| W1 · 16 · Redis | 5 864,1 (5 790,5–6 113,8) | 5 898,2 | 2 707 | 649,2 (640,3–795,3) | 658,6 | 24 093 |
| W3 · 1 · PostgreSQL | 1 277,4 (1 230,6–1 311,7) | 1 327,0 | 752 | 255,6 (211,8–365,6) | 269,0 | 3 694 |
| W3 · 1 · Redis | 2 409,1 (2 387,4–2 534,2) | 2 503,2 | 399 | 187,8 (169,4–237,3) | 190,4 | 5 209 |
| W3 · 16 · PostgreSQL | 2 310,2 (2 295,4–2 332,9) | 2 392,1 | 6 665 | 682,6 (551,2–872,3) | 1 870,8 | 8 493 |
| W3 · 16 · Redis | 5 580,0 (5 577,0–5 945,1) | 5 169,8 | 3 089 | 586,9 (566,4–778,1) | 610,3 | 26 009 |
| D1 · 1 · PostgreSQL | 1 465,4 (1 448,9–1 475,6) | 1 542,1 | 648 | 400,9 (375,4–644,7) | 427,2 | 2 332 |
| D1 · 1 · Redis | 2 454,9 (2 397,5–2 529,0) | 2 570,9 | 389 | 198,8 (175,1–214,5) | 202,9 | 4 893 |
| D1 · 16 · PostgreSQL | 2 326,5 (2 269,7–2 339,1) | 3 951,4 | 4 037 | 976,5 (798,1–1 110,6) | 4 385,6 | 3 636 |
| D1 · 16 · Redis | 5 448,7 (5 416,1–6 119,8) | 5 119,7 | 3 120 | 749,3 (681,6–1 038,3) | 808,6 | 19 666 |
<!-- report_tables:end writes_default -->

![Режим надёжности, 1 клиент](img/databases/durability.png)

![Режим надёжности, 16 клиентов](img/databases/durability_c16.png)

Диагностика Redis в конфигурации «оптимизированная, строгий» (`data/redis/`). Первая таблица — максимальная длительность события `aof-fsync-always` из `LATENCY` за серию (события от 1 мс). Вторая — серверное время команды по `INFO commandstats`, в микросекундах на вызов:

<!-- report_tables:begin redis_fsync -->
| Серия (Redis, оптимизированная, строгий) | прогон 1: макс. мс | прогон 2: макс. мс | прогон 3: макс. мс |
|---|---:|---:|---:|
| W1 · 1 клиент | 9 | 9 | 9 |
| W1 · 16 клиентов | 9 | 9 | 9 |
| W3 · 1 клиент | 12 | 9 | 9 |
| D1 · 1 клиент | 9 | 8 | 9 |
| W2 | 9 | 11 | 9 |
| D2 | 15 | 13 | 20 |
<!-- report_tables:end redis_fsync -->

<!-- report_tables:begin redis_commands -->
| Команда | прогон 1, мкс/вызов | прогон 2, мкс/вызов | прогон 3, мкс/вызов |
|---|---:|---:|---:|
| HGETALL | 2,01 | 1,88 | 1,93 |
| GET | 1,10 | 1,00 | 1,01 |
| ZREVRANGE | 1,42 | 1,47 | 1,41 |
| SMEMBERS | 0,88 | 0,80 | 0,80 |
| EVALSHA | 13,56 | 13,31 | 13,16 |
| EXEC | 9,39 | 9,22 | 9,69 |
| HSET | 2,21 | 2,16 | 2,16 |
| ZADD | 1,18 | 1,13 | 1,12 |
<!-- report_tables:end redis_commands -->

### 9.5. Пакетные операции

W2 (10 000 партий за вызов) и D2 (1 000 анализов за вызов). В каждой ячейке: p50 в мс (мин–макс по прогонам); среднее в мс.

<!-- report_tables:begin bulk -->
| Операция (p50, мс (мин–макс); среднее, мс) | по умолчанию, строгий | по умолчанию, ослабленный | оптимизированная, строгий | оптимизированная, ослабленный |
|---|---:|---:|---:|---:|
| W2 · PostgreSQL COPY | 327,7 (320,5–345,8); 336,3 | 377,7 (313,8–481,8); 396,9 | 302,8 (299,3–304,1); 303,6 | 295,5 (292,6–303,7); 309,1 |
| W2 · PostgreSQL multi-row INSERT | 383,6 (380,8–413,1); 387,9 | 465,5 (366,4–562,8); 470,2 | 354,7 (352,5–363,1); 362,3 | 348,8 (348,4–361,3); 356,0 |
| W2 · Redis pipeline | 1 098,4 (1 087,9–1 156,8); 1 103,5 | 371,2 (350,5–437,8); 376,4 | 1 075,4 (1 058,4–1 109,7); 1 071,2 | 334,1 (333,1–349,5); 344,7 |
| D2 · PostgreSQL | 3,94 (3,93–5,27); 4,12 | 3,74 (2,57–4,06); 4,11 | 4,02 (3,91–4,17); 4,46 | 4,09 (3,32–4,56); 4,31 |
| D2 · Redis | 36,67 (35,63–41,05); 41,03 | 16,16 (16,14–28,70); 16,70 | 35,85 (35,04–36,39); 39,58 | 16,06 (15,98–16,10); 16,41 |
<!-- report_tables:end bulk -->

![Пакетные операции](img/databases/bulk.png)

## 10. Анализ

**Чтение по одному ключу — преимущество Redis, но небольшое.**

- R1 (партия по id): 143,4 мкс у Redis против 184,9 у PostgreSQL.
- R6 (счётчики по статусам): 139,1 против 182,8.

Почти вся задержка — это сеть и клиент. Серверное время `HGETALL` — около 2,01 мкс. Значит, разница в десятки микросекунд — это разбор SQL, планирование и исполнение оператора в PostgreSQL против прямого доступа к хешу в Redis. При 16 клиентах разрыв растёт: Redis выполняет 68 332 оп/с на R1, PostgreSQL — 24 672. При этом Redis упирается в клиентские процессы (6,57 ядра клиента), а не в себя.

**Каждый лишний сетевой обмен стоит Redis больше, чем PostgreSQL платит за SQL.** R2, R3 и R4 требуют в Redis два последовательных обмена, и Redis проигрывает:

- R2: 278,3 мкс против 185,4;
- R3: 293,4 против 195,0;
- R4: 316,0 против 273,3.

Один `JOIN` с `json_agg` в PostgreSQL обходится дешевле, чем ручная сборка результата из двух pipeline. Для Redis это означает правило: данные для одного ответа надо хранить под одним ключом.

**Граф.** Lua-скрипт, который обходит граф на сервере за один вызов, быстрее рекурсивного CTE: 156,7 против 249,6 мкс. BFS из Python делает обмен на каждый уровень и медленнее обоих (280,7), с тяжёлым хвостом (p95 729,7). В графе этого набора у партии не больше двух десятков потомков, и Lua здесь выигрывает, по-видимому, за счёт того, что обход идёт прямо по структурам в памяти, без исполнителя SQL с рабочей таблицей рекурсии и хеш-агрегатом `DISTINCT`. Но за этот выигрыш Redis требует хранить рёбра дважды (`children` и `parents`) и поддерживать их вручную. Скрипт при этом блокирует однопоточный Redis на всё время обхода, а целостности связей в Redis нет.

**Нагрузка на CPU: PostgreSQL упирается в свои ядра.** При 16 клиентах тяжёлые запросы PostgreSQL (R4, R5) дают около 9 тысяч оп/с (R4 — 9 498). Хвост у них огромный: p99 R4 — 69 328,8 мкс. Это троттлинг CFS на лимите 2 CPU. Redis тратит на тот же R4 микросекунды процессора и держит 35 164 оп/с.

**Запись в строгом режиме: PostgreSQL быстрее Redis.** Это главный результат, противоречащий привычному представлению о Redis как о «быстром» хранилище.

- При 1 клиенте W1 стоит 1 345,9 мкс у PostgreSQL против 2 528,4 у Redis. W3 и D1 ведут себя так же.
- При 16 клиентах PostgreSQL выполняет 6 658 вставок в секунду, Redis — 2 944.
- Серверная работа Redis ничтожна: `EXEC` с пятью командами — 9,39 мкс, `EVALSHA` — 13,56 мкс.
- Всё остальное время — ожидание fsync. В `LATENCY` на каждой серии записи есть события `aof-fsync-always` длительностью до 9–20 мс.

Вероятные причины разницы:

1. **Разный характер сброса на диск.** PostgreSQL при `synchronous_commit = on` сбрасывает WAL вызовом `fdatasync` в заранее выделенный сегмент WAL: меняются только данные, метаданные файла — нет. Redis при `appendfsync always` дописывает команду в конец AOF и синхронизирует его. Файл растёт, поэтому вместе с данными приходится фиксировать в журнале ext4 и метаданные (размер). Это дополнительный сброс, и p50 Redis действительно почти вдвое выше.
2. **Разное устройство многопоточности.** В Redis fsync выполняется в единственном основном потоке, и пока он идёт, сервер не обслуживает никого. Один fsync покрывает только команды, накопленные за одну итерацию цикла событий. В PostgreSQL каждый процесс-обработчик ждёт своего сброса WAL независимо. Один сброс WAL покрывает коммиты всех процессов, которые успели их записать (групповой коммит), а остальные процессы тем временем продолжают выполнять запросы.

Эти объяснения согласуются с измерениями, но отдельно, например через `strace`, не проверялись.

**Запись в ослабленном режиме: Redis быстрее.** Без синхронного fsync у Redis остаётся только собственная работа:

- при 1 клиенте W1 — 205,2 мкс против 254,1 у PostgreSQL, W3 — 167,4 против 235,7, D1 — 174,5 против 360,4;
- при 16 клиентах W1 — 34 305 оп/с против 10 499.

PostgreSQL в ослабленном режиме при 16 клиентах снова упирается в CPU: среднее W1 1 514,4 мкс при p50 400,9. У D1 ослабление надёжности пропускную способность вообще не подняло (3 987 оп/с против 4 282 в строгом режиме): удаление с проверкой трёх внешних ключей ограничено процессором, а не fsync.

**Пакетная запись.**

- В строгом режиме COPY в PostgreSQL вставляет 10 000 партий за 302,8 мс, multi-row `INSERT` — за 354,7 мс, pipeline Redis — за 1 075,4 мс. Вероятная причина: pipeline из 5 000 команд сервер читает за несколько итераций цикла событий, и в строгом режиме на каждой итерации выполняется свой fsync (в `LATENCY` серии W2 есть события `aof-fsync-always`, таблица п. 9.4).
- В ослабленном режиме все три близки: 295,5, 348,8 и 334,1 мс.
- Удаление по диапазону (D2) — область PostgreSQL: один `DELETE … WHERE due_at < $t` по индексу выполняется за единицы миллисекунд во всех конфигурациях. Redis тратит 35,85 мс в строгом режиме и 16,06 в ослабленном. Причины: выборка id, чтение `batch_id` каждого анализа и три команды удаления на анализ (hash, `tests:by_due`, `LREM` из списка партии) — всё это pipeline, который собирает и разбирает клиент.

**Оптимизация конфигурации.**

- **PostgreSQL.** На чтении при 1 клиенте конфигурации отличаются меньше, чем прогоны между собой. Например, R1: 199,9 (184,7–202,0) против 184,9 (184,7–186,6). Планы стали проще (п. 7.2), но на наборе, который помещается в `shared_buffers`, это почти не видно. Пропускная способность при 16 клиентах тоже почти не изменилась: предел задают 2 CPU. Заметно на PostgreSQL сработали только подготовленные запросы (п. 7.3).
- **Redis.** Настройка дала большой эффект при 16 клиентах: R1 — с 40 873 до 68 332 оп/с, R4 — с 19 052 до 35 164. По-видимому, это работа `io-threads 2`: чтение и запись сокетов вынесены из основного потока. При 1 клиенте эффект малый, потому что сокет один.
- **Запись.** Ни одна настройка конфигурации не меняет запись в строгом режиме: её цена — fsync.

**Память.** Объёмы сопоставимы: база PostgreSQL занимает 16,31 МБ на диске, Redis — 14,93 МБ `used_memory` и 23,43 МБ RSS. Но у Redis это оперативная память, и больше трети оценённого через `MEMORY USAGE` объёма приходится на структуры-индексы, которые приложение строит само (все ключи из таблицы п. 5, кроме хешей записей и рёбер). Рост данных в Redis упирается в объём ОЗУ, в PostgreSQL — в объём диска.

## 11. Плюсы и минусы

**PostgreSQL.**

Плюсы:

- любой запрос по данным без изменения схемы: соединения, фильтры, агрегаты, рекурсивный обход графа;
- целостность и каскады проверяет сама СУБД (внешние ключи, CHECK, уникальность);
- транзакции над несколькими таблицами;
- в строгом режиме надёжности запись дешевле, чем у Redis: групповой коммит, WAL в заранее выделенных сегментах;
- пакетная загрузка (`COPY`) и удаление по диапазону — самые быстрые в замерах;
- данные ограничены диском, а не памятью.

Минусы:

- каждый запрос несёт разбор, планирование и исполнение SQL — на простых чтениях это десятки микросекунд;
- без подготовленных операторов сложные запросы вдвое медленнее;
- CPU на запрос выше, поэтому при ограниченных ядрах пропускная способность ниже, а хвост задержек под нагрузкой тяжёлый;
- нужна настройка под железо (`shared_buffers`, `random_page_cost` и т. д.).

**Redis.**

Плюсы:

- минимальная задержка и максимальная пропускная способность для доступа к данным по одному ключу;
- серверное время команд — единицы микросекунд;
- атомарные операции над структурами (`INCR`, `SET NX`, `GETDEL`, `ZADD`) и Lua-скрипты за один обмен;
- TTL у ключей;
- в ослабленном режиме надёжности самая быстрая запись.

Минусы:

- нет запросов по значениям: каждый путь доступа нужно заранее построить как отдельную структуру и поддерживать её в приложении атомарно;
- нет внешних ключей и целостности связей;
- любой ответ, собранный из нескольких ключей, требует нескольких обменов и проигрывает одному SQL-запросу;
- в строгом режиме (`appendfsync always`) запись медленнее PostgreSQL, а fsync блокирует весь сервер;
- все данные в оперативной памяти, RSS заметно больше полезных данных;
- однопоточное исполнение команд: долгий Lua-скрипт или `LREM` на большом списке задерживает всех клиентов.

## 12. Вывод: какие задачи AgroTrace решать в какой СУБД

Замеры подтверждают распределение ролей из раздела 8 ТЗ.

**В PostgreSQL:**

- **Основное хранилище и транзакции** — партии, передачи, анализы, отзывы. Нужны внешние ключи, каскады и оптимистичная блокировка (W3 — один `UPDATE`). В строгом режиме надёжности, обязательном для учётных данных, PostgreSQL ещё и пишет быстрее Redis: 1 345,9 против 2 528,4 мкс на W1, 6 658 против 2 944 оп/с при 16 клиентах.
- **Граф происхождения и отзыв.** Обход вниз `WITH RECURSIVE` работает за сотни микросекунд. Отзыв по §8.2 создаётся в транзакции `REPEATABLE READ` вместе с изменением статусов, и обход графа должен видеть тот же согласованный снимок. Lua-обход в Redis быстрее на маленьком графе, но потребовал бы держать рёбра в двух местах без целостности и синхронизировать их с PostgreSQL.
- **Аналитика и отчёты.** Произвольные `GROUP BY`, фильтры и соединения. Счётчик в Redis (R6) быстрее только потому, что заранее посчитан под один конкретный вопрос.
- **Массовые операции** — импорт (`COPY`), удаление и выборка по диапазонам (D2).

**В Redis** — там, где нужен один ключ, атомарная операция и TTL, а потеря последней секунды изменений допустима:

- **Кэш публичных QR-страниц** (`pub:batch:{publicCode}`): один `GET` готового JSON. Это самая дешёвая операция стенда, и она лучше всех масштабируется на 16 клиентов (R1: 68 332 оп/с против 24 672 у PostgreSQL). Кэшировать нужно готовую страницу одним ключом. R2–R4 показывают, что сборка ответа из нескольких ключей Redis медленнее одного SQL-запроса.
- **Rate limiting** (`rl:{scope}:{id}`) и **ключи идемпотентности** (`idem:{userId}:{key}`): `INCR`/`SET NX` с TTL, одна команда. Ключи общие для всех трёх backend-реализаций. Режим `appendfsync everysec` для них оправдан: запись стоит около 200 мкс вместо 2,5 мс в строгом режиме, а потеря последней секунды счётчиков безопасна.
- **Одноразовые коды** (`pwreset:`, `invite:`, `tgcode:`, `totp-used:`, `2fa:`) — `SET` с TTL и `GETDEL`, чтение и удаление атомарны.

Redis не должен быть системой учёта. Строгая надёжность в нём дороже, чем в PostgreSQL. Вторичные индексы и целостность связей пришлось бы переписывать в приложении, а объём ограничен оперативной памятью.

## 13. Воспроизведение

```bash
./at.sh bench all      # чистые тома → генерация → 4 конфигурации × (загрузка + 3 прогона)
                       # → публикация CSV в docs/reports/data → графики → таблицы отчёта
./at.sh bench plot     # только графики из docs/reports/data
./at.sh bench report   # только таблицы отчёта; report_tables --check — только проверка
./at.sh bench test     # тесты бенчмарка, включая сверку отчёта с CSV
```

Таблицы и графики после нового прогона обновятся автоматически. Если числа изменятся, проверка укажет на дробные значения в тексте анализа, которых больше нет в таблицах: этот текст нужно будет переписать вручную.
