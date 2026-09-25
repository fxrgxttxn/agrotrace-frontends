"""Generated tables of the database benchmark report (Task 5, spec §13).

Every table in docs/reports/databases.md is written by this module between two markers,
`<!-- report_tables:begin NAME -->` and `<!-- report_tables:end NAME -->`, from the published run
data in docs/reports/data/ (CSV, env/run JSON, EXPLAIN plans, Redis diagnostics). Nothing inside a
block is typed by hand: `python -m agrobench.report_tables` rewrites all blocks, and `--check`
(also run by tests/test_report_tables.py) verifies that

- every block is exactly what the script generates from the data now (a hand edit fails),
- every number in a generated table exists in that block's source files (as written there, or
  rounded / scaled by 10^-3, 10^-6 or 100 for µs -> ms, bytes -> MB and shares -> %), or is a
  value the block's builder derived from them through `Data.derive` (sums, ratios, per-op CPU)
  — the checker re-runs the builder, so a derived number is recomputed from the data, not trusted,
- no table outside a generated block carries numbers (code spans and row labels aside),
- every number in the prose that is a result rather than a structural label — any number with a
  decimal comma, a thousands group, a `%` or a `×`, and any other integer >= 100 — appears as a
  whole token in some generated block. Method constants that are not in the data (warm-up sizes,
  pipeline chunk sizes) are written as code (`1000`) and are not checked,
- no prose number uses a decimal point (versions and constants go in code; section numbers after
  `п.`/`§` and headings are exempt) and no factor is written with a letter x instead of `×`,
- every prose paragraph has an even number of backticks (a stray one would pair with a later
  backtick and hide the text in between from the checks above).

Not detectable: a prose number that exists in the tables but is attributed to the wrong query,
configuration or metric (the prose check proves a number is a real result, not that the sentence
around it describes it correctly).

Numbers are formatted the Russian way: decimal comma, no-break space between thousands.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from agrobench import config

REPORT_DIR = Path(os.environ.get("REPORT_DIR", str(config.BENCH_DIR.parent / "docs" / "reports")))
DATA_DIR = REPORT_DIR / "data"
REPORT_PATH = REPORT_DIR / "databases.md"

NBSP = " "
DASH = "–"

PROFILES = ("default", "tuned")
DURABILITIES = ("strict", "relaxed")
PROFILE_RU = {"default": "по умолчанию", "tuned": "оптимизированная"}
DUR_RU = {"strict": "строгий", "relaxed": "ослабленный"}
DBMS_RU = {"pg": "PostgreSQL", "redis": "Redis"}


class ReportError(Exception):
    pass


# ---------------------------------------------------------------------------------------------
# formatting
# ---------------------------------------------------------------------------------------------

def fmt_num(value: float, digits: int) -> str:
    """Russian number format: `1 075 443,6` (no-break space thousands, decimal comma)."""
    s = f"{value:,.{digits}f}"
    return s.replace(",", NBSP).replace(".", ",")


def us(v) -> str:
    return fmt_num(float(v), 1)


def ms(v) -> str:
    return fmt_num(float(v) / 1e3, 1)


def ops(v) -> str:
    return fmt_num(float(v), 0)


def mb(v) -> str:
    return fmt_num(float(v) / 1e6, 2)


def spread_us(row: dict) -> str:
    """Median p50 with the min–max p50 of the three runs."""
    return f"{us(row['p50_us'])} ({us(row['p50_us_min'])}{DASH}{us(row['p50_us_max'])})"


def spread_ms(row: dict, digits: int = 1) -> str:
    f = lambda k: fmt_num(float(row[k]) / 1e3, digits)  # noqa: E731
    return f"{f('p50_us')} ({f('p50_us_min')}{DASH}{f('p50_us_max')})"


def md_table(header: list[str], rows: Iterable[list[str]], align: str | None = None) -> str:
    align = align or ("l" + "r" * (len(header) - 1))
    sep = ["---" if a == "l" else "---:" for a in align]
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join(sep) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------
# data access
# ---------------------------------------------------------------------------------------------

class Data:
    """Read-only view of a published data directory (docs/reports/data)."""

    def __init__(self, root: Path | str):
        self.root = Path(root)
        self._cache: dict[str, object] = {}
        self.derived: set[str] = set()

    def derive(self, value: float) -> float:
        """Registers a number computed from source values (sum, ratio, per-op CPU) so the checker
        accepts its formatted forms in the block being built; returns it unchanged."""
        self.derived |= _float_forms(value)
        return value

    def text(self, name: str) -> str:
        if name not in self._cache:
            self._cache[name] = (self.root / name).read_text(encoding="utf-8")
        return self._cache[name]  # type: ignore[return-value]

    def csv(self, name: str) -> list[dict]:
        key = "csv:" + name
        if key not in self._cache:
            with (self.root / name).open(newline="", encoding="utf-8") as f:
                self._cache[key] = list(csv.DictReader(f))
        return self._cache[key]  # type: ignore[return-value]

    def json(self, name: str) -> dict:
        key = "json:" + name
        if key not in self._cache:
            self._cache[key] = json.loads(self.text(name))
        return self._cache[key]  # type: ignore[return-value]

    def median(self, dbms: str, profile: str, durability: str, query: str, variant: str,
               distribution: str, concurrency: int) -> dict:
        want = (dbms, profile, durability, query, variant, distribution, str(concurrency))
        for r in self.csv("measurements_median.csv"):
            if (r["dbms"], r["profile"], r["durability"], r["query"], r["variant"],
                    r["distribution"], r["concurrency"]) == want:
                return r
        raise ReportError(f"no median row for {want}")

    def run_range(self, dbms: str, profile: str, durability: str, query: str, variant: str,
                  distribution: str, concurrency: int, metric: str) -> tuple[float, float]:
        """Min and max of `metric` across the runs (measurements.csv, one row per run)."""
        want = (dbms, profile, durability, query, variant, distribution, str(concurrency))
        values = [float(r[metric]) for r in self.csv("measurements.csv")
                  if (r["dbms"], r["profile"], r["durability"], r["query"], r["variant"],
                      r["distribution"], r["concurrency"]) == want]
        if not values:
            raise ReportError(f"no per-run rows for {want}")
        return min(values), max(values)

    def dataset(self, metric: str) -> float:
        for r in self.csv("dataset.csv"):
            if r["metric"] == metric:
                return float(r["value"])
        raise ReportError(f"no dataset metric {metric}")

    def memory(self, dbms: str, profile: str, durability: str, obj: str, metric: str) -> str:
        for r in self.csv("memory.csv"):
            if (r["dbms"], r["profile"], r["durability"], r["object"], r["metric"]) == (
                    dbms, profile, durability, obj, metric):
                return r["value"]
        raise ReportError(f"no memory row for {(dbms, profile, durability, obj, metric)}")

    def setting(self, dbms: str, profile: str, durability: str, name: str) -> str:
        for r in self.csv("settings.csv"):
            if (r["dbms"], r["profile"], r["durability"], r["setting"]) == (dbms, profile, durability, name):
                return r["live"]
        raise ReportError(f"no setting row for {(dbms, profile, durability, name)}")

    def load(self, dbms: str, profile: str, durability: str, phase: str) -> str:
        for r in self.csv("load.csv"):
            if (r["dbms"], r["profile"], r["durability"], r["phase"]) == (dbms, profile, durability, phase):
                return r["seconds"]
        raise ReportError(f"no load row for {(dbms, profile, durability, phase)}")


# ---------------------------------------------------------------------------------------------
# blocks
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Block:
    sources: tuple[str, ...]
    build: Callable[[Data], str]


def begin(name: str) -> str:
    return f"<!-- report_tables:begin {name} -->"


def end(name: str) -> str:
    return f"<!-- report_tables:end {name} -->"


_MARKER_RE = re.compile(r"<!-- report_tables:(begin|end) ([\w-]+) -->")

# Reads: (row label, query, pg variant or None, redis variant or None)
READS = [
    ("R1", "R1", "base", "base"),
    ("R2", "R2", "base", "base"),
    ("R3", "R3", "base", "base"),
    ("R4", "R4", "base", "base"),
    ("R5 (PG: WITH RECURSIVE, Redis: Lua)", "R5", "recursive_cte", "lua"),
    ("R5 (Redis: BFS в Python)", "R5", None, "bfs_pipeline"),
    ("R6", "R6", "base", "base"),
]
READ_RUNS = [(label, q, dbms, v) for label, q, pv, rv in READS
             for dbms, v in (("pg", pv), ("redis", rv)) if v]
WRITES = ("W1", "W3", "D1")


def ops_spread(d: Data, key: tuple, row: dict) -> str:
    """Median ops/s with the min–max ops/s of the three runs (per-run rows, measurements.csv)."""
    lo, hi = d.run_range(*key, "ops_s")
    return f"{ops(row['ops_s'])} ({ops(lo)}{DASH}{ops(hi)})"


def _reads(profile: str) -> Callable[[Data], str]:
    def build(d: Data) -> str:
        rows = []
        for label, q, pv, rv in READS:
            cells = [label]
            for dbms, v in (("pg", pv), ("redis", rv)):
                if v is None:
                    cells += ["—"] * 4
                    continue
                key = (dbms, profile, "strict", q, v, "uniform", 1)
                r = d.median(*key)
                cells += [spread_us(r), us(r["p95_us"]), us(r["p99_us"]), ops_spread(d, key, r)]
            rows.append(cells)
        return md_table(["Запрос", "PG p50, мкс (мин–макс)", "PG p95, мкс", "PG p99, мкс", "PG оп/с (мин–макс)",
                         "Redis p50, мкс (мин–макс)", "Redis p95, мкс", "Redis p99, мкс",
                         "Redis оп/с (мин–макс)"], rows)
    return build


def _reads_pg_configs(d: Data) -> str:
    """PostgreSQL read p50 in all four configurations: shows the host noise across columns."""
    rows = []
    for label, q, pv, _ in READS:
        if pv is None:
            continue
        rows.append([label] + [spread_us(d.median("pg", p, dur, q, pv, "uniform", 1))
                               for p in PROFILES for dur in DURABILITIES])
    return md_table(["Запрос (PostgreSQL, 1 клиент)"] + [f"{PROFILE_RU[p]}, {DUR_RU[dur]}"
                                                         for p in PROFILES for dur in DURABILITIES], rows)


def _reads_zipf(d: Data) -> str:
    rows = []
    for label, q, pv, rv in READS:
        cells = [label]
        for dbms, v in (("pg", pv), ("redis", rv)):
            for dist in ("uniform", "zipf"):
                cells.append("—" if v is None else us(d.median(dbms, "tuned", "strict", q, v, dist, 1)["p50_us"]))
        rows.append(cells)
    return md_table(["Запрос", "PG равномерно", "PG Zipf 1.1", "Redis равномерно", "Redis Zipf 1.1"], rows)


def _reads_c16(d: Data) -> str:
    rows = []
    for label, q, dbms, v in READ_RUNS:
        key = (dbms, "tuned", "strict", q, v, "uniform", 16)
        r = d.median(*key)
        rows.append([f"{label} · {DBMS_RU[dbms]}", us(r["p50_us"]), us(r["mean_us"]), us(r["p99_us"]),
                     ops_spread(d, key, r), fmt_num(float(r["effective_concurrency"]), 2),
                     fmt_num(float(r["client_cpu_cores"]), 2)])
    return md_table(["Запрос · СУБД", "p50, мкс", "среднее, мкс", "p99, мкс", "оп/с (мин–макс)",
                     "эффективный параллелизм", "CPU клиента, ядер"], rows)


def _client_cpu(d: Data) -> str:
    """Client CPU per operation = client_cpu_cores / ops_s (µs of client CPU per call)."""
    rows = []
    for label, q, pv, rv in READS:
        cells = [label]
        for c in (1, 16):
            for dbms, v in (("pg", pv), ("redis", rv)):
                if v is None:
                    cells += ["—", "—"]
                    continue
                r = d.median(dbms, "tuned", "strict", q, v, "uniform", c)
                cores = float(r["client_cpu_cores"])
                per_op = d.derive(cores / float(r["ops_s"]) * 1e6)
                cells += [fmt_num(cores, 2), fmt_num(per_op, 1)]
        rows.append(cells)
    return md_table(["Запрос", "1 клиент: PG, ядер", "PG, мкс CPU/оп", "Redis, ядер", "Redis, мкс CPU/оп",
                     "16 клиентов: PG, ядер", "PG, мкс CPU/оп", "Redis, ядер", "Redis, мкс CPU/оп"], rows)


def _client_gap(d: Data) -> str:
    """How much of the PG–Redis p50 gap at 1 client the client CPU difference could explain."""
    rows = []
    for q in ("R1", "R6"):
        for p in PROFILES:
            pg = d.median("pg", p, "strict", q, "base", "uniform", 1)
            rd = d.median("redis", p, "strict", q, "base", "uniform", 1)
            gap = d.derive(float(pg["p50_us"]) - float(rd["p50_us"]))
            cpu_pg = d.derive(float(pg["client_cpu_cores"]) / float(pg["ops_s"]) * 1e6)
            cpu_rd = d.derive(float(rd["client_cpu_cores"]) / float(rd["ops_s"]) * 1e6)
            cpu_gap = d.derive(cpu_pg - cpu_rd)
            rows.append([f"{q} · {PROFILE_RU[p]}", us(pg["p50_us"]), us(rd["p50_us"]), fmt_num(gap, 1),
                         fmt_num(cpu_pg, 1), fmt_num(cpu_rd, 1), fmt_num(cpu_gap, 1),
                         fmt_num(d.derive(cpu_gap / gap * 100), 0) + "%"])
    return md_table(["Запрос · конфигурация (1 клиент)", "PG p50, мкс", "Redis p50, мкс", "разница p50, мкс",
                     "PG, мкс CPU клиента/оп", "Redis, мкс CPU клиента/оп", "разница CPU, мкс",
                     "доля разницы p50"], rows)


def _optimization(d: Data) -> str:
    rows = []
    for label, q, dbms, v in READ_RUNS:
        cells = [f"{label} · {DBMS_RU[dbms]}"]
        for p in PROFILES:
            cells.append(spread_us(d.median(dbms, p, "strict", q, v, "uniform", 1)))
        for p in PROFILES:
            key = (dbms, p, "strict", q, v, "uniform", 16)
            cells.append(ops_spread(d, key, d.median(*key)))
        rows.append(cells)
    return md_table(["Запрос · СУБД", "p50 при 1 клиенте, мкс: по умолчанию", "оптимизированная",
                     "оп/с при 16 клиентах (мин–макс): по умолчанию", "оптимизированная"], rows)


def _prepared(d: Data) -> str:
    rows = []
    for label, q, pv, _ in READS:
        if pv is None:
            continue
        cells = [label if q != "R5" else "R5 (WITH RECURSIVE)"]
        for p in PROFILES:
            prep = float(d.median("pg", p, "strict", q, pv, "uniform", 1)["p50_us"])
            unprep = float(d.median("pg", p, "strict", q, "unprepared", "uniform", 1)["p50_us"])
            cells += [us(prep), us(unprep), fmt_num(d.derive(unprep / prep), 2) + "×"]
        rows.append(cells)
    return md_table(["Запрос", "по умолчанию: подготовленный", "без подготовки", "без / с подготовкой",
                     "оптимизированная: подготовленный", "без подготовки", "без / с подготовкой"], rows)


def _writes(profile: str) -> Callable[[Data], str]:
    def build(d: Data) -> str:
        rows = []
        for q in WRITES:
            for c in (1, 16):
                for dbms in ("pg", "redis"):
                    cells = [f"{q} · {c} · {DBMS_RU[dbms]}"]
                    for dur in DURABILITIES:
                        key = (dbms, profile, dur, q, "base", "prepared", c)
                        r = d.median(*key)
                        cells += [spread_us(r), us(r["mean_us"]), us(r["p99_us"]), ops_spread(d, key, r)]
                    rows.append(cells)
        return md_table(["Запрос · клиентов · СУБД", "строгий: p50, мкс (мин–макс)", "среднее, мкс", "p99, мкс",
                         "оп/с (мин–макс)", "ослабленный: p50, мкс (мин–макс)", "среднее, мкс", "p99, мкс",
                         "оп/с (мин–макс)"], rows)
    return build


BULK = [
    ("W2 · PostgreSQL COPY", "pg", "W2", "copy"),
    ("W2 · PostgreSQL multi-row INSERT", "pg", "W2", "multirow"),
    ("W2 · Redis pipeline", "redis", "W2", "pipeline"),
    ("D2 · PostgreSQL", "pg", "D2", "base"),
    ("D2 · Redis", "redis", "D2", "base"),
]


def _bulk(d: Data) -> str:
    rows = []
    for label, dbms, q, v in BULK:
        cells = [label]
        for p in PROFILES:
            for dur in DURABILITIES:
                r = d.median(dbms, p, dur, q, v, "prepared", 1)
                digits = 1 if q == "W2" else 2
                cells.append(f"{spread_ms(r, digits)}; {fmt_num(float(r['mean_us']) / 1e3, digits)}")
        rows.append(cells)
    header = ["Операция (p50, мс (мин–макс); среднее, мс)"] + [f"{PROFILE_RU[p]}, {DUR_RU[dur]}" for p in PROFILES for dur in DURABILITIES]
    return md_table(header, rows)


def _load(d: Data) -> str:
    rows = []
    for p in PROFILES:
        for dur in DURABILITIES:
            cells = [f"{PROFILE_RU[p]}, {DUR_RU[dur]}"]
            for phase in ("copy_organizations", "copy_batches", "copy_batch_links", "copy_lab_tests",
                          "indexes_and_analyze", "total"):
                cells.append(fmt_num(float(d.load("pg", p, dur, phase)), 3))
            cells.append(fmt_num(float(d.load("redis", p, dur, "total")), 3))
            rows.append(cells)
    return md_table(["Конфигурация", "PG COPY organizations", "COPY batches", "COPY batch_links",
                     "COPY lab_tests", "индексы + ANALYZE", "PG всего", "Redis всего"], rows)


ENTITIES = [
    ("organizations", "id, type, name, inn, region_code, trust_rating, created_at", "org_hash"),
    ("batches", "id, public_code, product, origin_org_id, holder_org_id, kind, mass_kg, status, "
                "harvested_at, version", "batch_hash"),
    ("batch_links", "parent_id, child_id, mass_used_kg, link_type, created_at", "link_hash"),
    ("lab_tests", "id, batch_id, lab_org_id, reason, conclusion, value, due_at", "test_hash"),
]


def _entities(d: Data) -> str:
    rows = [[name, attrs, fmt_num(float(d.memory("redis", "tuned", "strict", key, "key_count")), 0)]
            for name, attrs, key in ENTITIES]
    return md_table(["Сущность", "Атрибуты", "Записей"], rows, align="llr")


PG_TABLES = ("organizations", "batches", "batch_links", "lab_tests")


def _memory_pg(d: Data) -> str:
    rows = []
    for t in PG_TABLES:
        rows.append([t, mb(d.memory("pg", "tuned", "strict", t, "table_bytes")),
                     mb(d.memory("pg", "tuned", "strict", t, "indexes_bytes")),
                     mb(d.memory("pg", "tuned", "strict", t, "total_relation_size_bytes"))])
    rows.append(["вся база (pg_database_size, вместе с системным каталогом)", "", "",
                 mb(d.memory("pg", "tuned", "strict", "__database__", "total_bytes"))])
    return md_table(["Таблица", "данные (pg_relation_size), МБ", "индексы (pg_indexes_size), МБ",
                     "всего (pg_total_relation_size, с картами FSM/VM), МБ"], rows)


REDIS_KEYS = [
    ("batch_hash", "`batch:{id}` (Hash)"),
    ("org_hash", "`org:{id}` (Hash)"),
    ("test_hash", "`test:{id}` (Hash)"),
    ("link_hash", "`link:{parent}:{child}` (Hash)"),
    ("tests_by_due_zset", "`tests:by_due` (Sorted Set)"),
    ("held_status_zset", "`org:{id}:held:{status}` (Sorted Set)"),
    ("code_string", "`batch:code:{code}` (String)"),
    ("tests_list", "`batch:{id}:tests` (List)"),
    ("stats_hash", "`stats:org:{id}` (Hash)"),
    ("held_zset", "`org:{id}:held` (Sorted Set)"),
    ("children_set", "`batch:{id}:children` (Set)"),
    ("parents_set", "`batch:{id}:parents` (Set)"),
    ("seq_string", "`seq:{entity}` (String)"),
]


def _memory_redis(d: Data) -> str:
    rows = []
    for key, label in REDIS_KEYS:
        rows.append([label, fmt_num(float(d.memory("redis", "tuned", "strict", key, "key_count")), 0),
                     fmt_num(float(d.memory("redis", "tuned", "strict", key, "avg_bytes")), 1),
                     mb(d.memory("redis", "tuned", "strict", key, "extrapolated_bytes"))])
    return md_table(["Ключ", "ключей", "MEMORY USAGE, байт на ключ (выборка)", "оценка, МБ"], rows)


def _memory_compare(d: Data) -> str:
    """Like-for-like size: the four PG tables with their indexes (sum of pg_total_relation_size)
    against Redis memory; ratios to that PG sum."""
    p, dur = "tuned", "strict"
    tables = d.derive(sum(float(d.memory("pg", p, dur, t, "total_relation_size_bytes")) for t in PG_TABLES))
    database = float(d.memory("pg", p, dur, "__database__", "total_bytes"))
    catalog = d.derive(database - tables)
    items = [
        ("PostgreSQL: четыре таблицы с индексами (сумма pg_total_relation_size)", tables),
        ("PostgreSQL: системный каталог и прочее (база минус таблицы)", catalog),
        ("PostgreSQL: база целиком (pg_database_size)", database),
        ("Redis: used_memory_dataset", float(d.memory("redis", p, dur, "__instance__", "used_memory_dataset"))),
        ("Redis: used_memory", float(d.memory("redis", p, dur, "__instance__", "used_memory"))),
        ("Redis: RSS процесса", float(d.memory("redis", p, dur, "__instance__", "used_memory_rss"))),
    ]
    rows = [[label, mb(v), "—" if "каталог" in label else fmt_num(d.derive(v / tables), 2) + "×"]
            for label, v in items]
    return md_table(["Что (оптимизированная, строгий)", "МБ", "к таблицам PG с индексами"], rows)


def _dataset(d: Data) -> str:
    """Generator targets (spec §13.4) next to what the loaded data actually contains."""
    batches, tests, derived_n = d.dataset("rows_batches"), d.dataset("rows_lab_tests"), d.dataset("batches_derived")

    def share(n: float, total: float) -> str:
        return fmt_num(d.derive(n / total * 100), 1) + "%"

    def target(v: float) -> str:
        return fmt_num(d.derive(v * 100), 0) + "%"

    raw_spec = d.dataset("spec_raw_share")
    rows = [
        ["сырьевые партии (RAW)", target(raw_spec), fmt_num(d.dataset("batches_raw"), 0),
         share(d.dataset("batches_raw"), batches)],
        ["производные партии (DERIVED)", target(d.derive(1 - raw_spec)), fmt_num(derived_n, 0),
         share(derived_n, batches)],
    ]
    for status in ("Approved", "Accepted", "OnSale"):
        rows.append([f"статус {status}", target(d.dataset(f"spec_status_share_{status}")),
                     fmt_num(d.dataset(f"status_{status}"), 0), share(d.dataset(f"status_{status}"), batches)])
    others = [r["metric"] for r in d.csv("dataset.csv")
              if r["metric"].startswith("status_") and r["metric"][7:] not in ("Approved", "Accepted", "OnSale")]
    other_n = d.derive(sum(d.dataset(m) for m in others))
    spec_named = sum(d.dataset(f"spec_status_share_{s}") for s in ("Approved", "Accepted", "OnSale"))
    rows.append([f"прочие статусы ({fmt_num(d.derive(len(others)), 0)} шт., поровну)", target(d.derive(1 - spec_named)),
                 fmt_num(other_n, 0), share(other_n, batches)])
    rows.append(["анализы с итогом FAIL", target(d.dataset("spec_fail_share")),
                 fmt_num(d.dataset("lab_tests_fail"), 0), share(d.dataset("lab_tests_fail"), tests)])
    for k in (1, 2, 3, 4):
        n = d.dataset(f"derived_with_{k}_parents")
        rows.append([f"производные с {k} родител{'ем' if k == 1 else 'ями'}", "1–4, равновероятно",
                     fmt_num(n, 0), share(n, derived_n)])
    rows.append(["рёбер графа (batch_links)", "—", fmt_num(d.dataset("rows_batch_links"), 0), "—"])
    rows.append(["наибольшая глубина графа, рёбер", f"до {fmt_num(d.dataset('spec_max_depth'), 0)}",
                 fmt_num(d.dataset("max_depth"), 0), "—"])
    return md_table(["Показатель", "по ТЗ / генератору", "в данных", "доля в данных"], rows)


def _memory_totals(d: Data) -> str:
    rows = []
    for p in PROFILES:
        for dur in DURABILITIES:
            m = lambda metric: d.memory("redis", p, dur, "__instance__", metric)  # noqa: E731
            rows.append([f"{PROFILE_RU[p]}, {DUR_RU[dur]}",
                         mb(d.memory("pg", p, dur, "__database__", "total_bytes")),
                         mb(m("used_memory")), mb(m("used_memory_dataset")), mb(m("used_memory_overhead")),
                         mb(m("used_memory_rss")), fmt_num(float(m("mem_fragmentation_ratio")), 2),
                         fmt_num(float(m("dbsize")), 0)])
    return md_table(["Конфигурация", "PG: база, МБ", "Redis used_memory, МБ", "dataset, МБ", "overhead, МБ",
                     "RSS, МБ", "фрагментация", "ключей"], rows)


PG_SETTINGS = ["shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem",
               "random_page_cost", "effective_io_concurrency", "max_wal_size"]
REDIS_SETTINGS = ["maxmemory", "maxmemory-policy", "hash-max-listpack-entries", "hash-max-listpack-value",
                  "lazyfree-lazy-user-del", "lazyfree-lazy-server-del", "io-threads", "save"]


def _settings(d: Data) -> str:
    rows = []
    for name in PG_SETTINGS:
        rows.append([f"PostgreSQL {name}"] + [d.setting("pg", p, "strict", name) for p in PROFILES])
    for name in REDIS_SETTINGS:
        rows.append([f"Redis {name}"] + [d.setting("redis", p, "strict", name) or "\"\" (выключено)"
                                         for p in PROFILES])
    return md_table(["Параметр", "по умолчанию", "оптимизированная"], rows, align="lll")


def _durability(d: Data) -> str:
    rows = []
    for dbms, names in (("pg", ["synchronous_commit", "fsync", "full_page_writes", "wal_sync_method"]),
                        ("redis", ["appendonly", "appendfsync"])):
        for name in names:
            rows.append([f"{DBMS_RU[dbms]} {name}"] + [d.setting(dbms, "tuned", dur, name) for dur in DURABILITIES])
    return md_table(["Параметр (значение с работающего сервера)", "строгий", "ослабленный"], rows, align="lll")


def _stand(d: Data) -> str:
    env = d.json("env.json")
    meta = d.json("run_meta.json")
    host, ver, lim, disk = env["host"], env["versions"], env["resource_limits"], env["db_data_disk"]["postgres"]
    rows = [
        ["Процессор", host["cpu_model"]],
        ["Логических CPU, видимых контейнеру", str(host["cpu_count_visible_to_runner"])],
        ["ОЗУ, видимая контейнеру, МБ", fmt_num(host["mem_total_mb_visible_to_runner"], 1)],
        ["ОС контейнеров (ядро WSL2)", host["os"]],
        ["Docker", env["docker"]["docker_version"]],
        ["Docker Compose", env["docker"]["compose_version"]],
        ["Лимиты bench-postgres и bench-redis",
         f"CPU {fmt_num(lim['postgres']['cpus'], 1)}, память {fmt_num(lim['postgres']['mem_mb'], 0)} МБ "
         f"(Redis: CPU {fmt_num(lim['redis']['cpus'], 1)}, {fmt_num(lim['redis']['mem_mb'], 0)} МБ)"],
        ["Диск с данными СУБД", f"{disk['device']}, {disk['fstype']}, {fmt_num(disk['total_gb'], 2)} ГБ"],
        ["PostgreSQL", ver["postgres"]],
        ["Redis", ver["redis"]],
        ["Python", ver["python"]],
        ["psycopg / psycopg-pool", f"{ver['psycopg']} / {ver['psycopg_pool']}"],
        ["redis-py / hiredis", f"{ver['redis_py']} / {ver['hiredis']}"],
        ["numpy / matplotlib", f"{ver['numpy']} / {ver['matplotlib']}"],
        ["Полный прогон `./at.sh bench all`", f"{meta['started_at']} … {meta['finished_at']}, "
                                              f"{fmt_num(meta['duration_seconds'], 0)} с"],
    ]
    return md_table(["Характеристика", "Значение"], rows, align="ll")


REDIS_DIAG_SERIES = [
    ("W1 · 1 клиент", "w1_insert_batch c=1"),
    ("W1 · 16 клиентов", "w1_insert_batch c=16"),
    ("W3 · 1 клиент", "w3_update_status c=1"),
    ("D1 · 1 клиент", "d1_delete_batch c=1"),
    ("W2", "w2_insert_batches"),
    ("D2", "d2_delete_tests_due_before"),
]
REDIS_DIAG_COMMANDS = ["hgetall", "get", "zrevrange", "smembers", "evalsha", "exec", "hset", "zadd"]


def _diag_file(profile: str, durability: str, run: int) -> str:
    return f"redis/redis_{profile}_{durability}_run{run}.txt"


def _redis_fsync(d: Data) -> str:
    """LATENCY `aof-fsync-always` per series: measured windows that had the event, and its max ms.
    A window is the whole warm-up + series for W1/W3/D1, one call (warm-up included) for W2/D2."""
    rows = []
    for label, series in REDIS_DIAG_SERIES:
        cells = [label]
        for run in (1, 2, 3):
            text = d.text(_diag_file("tuned", "strict", run))
            m = re.search(rf"^\[redis {re.escape(series)}\] aof-fsync-always: windows=(\d+) max_ms=(\d+)$",
                          text, re.M)
            cells += [m.group(1), m.group(2)] if m else ["—", "—"]
        rows.append(cells)
    return md_table(["Серия (Redis, оптимизированная, строгий)", "прогон 1: окон с событием", "макс. мс",
                     "прогон 2: окон", "макс. мс", "прогон 3: окон", "макс. мс"], rows)


def _redis_fsync_relaxed(d: Data) -> str:
    """Same diagnostics in the relaxed mode: number of `aof-fsync-always` lines per run."""
    rows = [["событий aof-fsync-always в LATENCY, оптимизированная, ослабленный"]
            + [str(d.text(_diag_file("tuned", "relaxed", run)).count("aof-fsync-always")) for run in (1, 2, 3)]]
    return md_table(["Диагностика Redis", "прогон 1", "прогон 2", "прогон 3"], rows)


def _redis_commands(d: Data) -> str:
    rows = []
    for cmd in REDIS_DIAG_COMMANDS:
        cells = [cmd.upper()]
        for run in (1, 2, 3):
            text = d.text(_diag_file("tuned", "strict", run))
            m = re.search(rf"^{cmd}: calls=\d+ usec=\d+ usec_per_call=([\d.]+)$", text, re.M)
            cells.append(m.group(1).replace(".", ",") if m else "—")
        rows.append(cells)
    return md_table(["Команда", "прогон 1, мкс/вызов", "прогон 2, мкс/вызов", "прогон 3, мкс/вызов"], rows)


PLAN_BLOCKS = [("R3", "default"), ("R3", "tuned"), ("R4", "default"), ("R4", "tuned"),
               ("R5_max", "default"), ("R5_max", "tuned"), ("D1", "default"), ("D1", "tuned")]


def _plan_file(query: str, profile: str) -> str:
    return f"plans/pg_{profile}_strict_{query}.txt"


def _plan(query: str, profile: str) -> Callable[[Data], str]:
    def build(d: Data) -> str:
        text = d.text(_plan_file(query, profile)).rstrip("\n")
        head, _, plan = text.partition("\n\n")
        params = [line for line in head.splitlines() if line.startswith("-- parameters")]
        return "```text\n" + "\n".join(params + [plan]) + "\n```"
    return build


_REDIS_DIAG = tuple(_diag_file("tuned", "strict", r) for r in (1, 2, 3))

_MED = ("measurements_median.csv",)
_MED_RUNS = ("measurements_median.csv", "measurements.csv")

BLOCKS: dict[str, Block] = {
    "stand": Block(("env.json", "run_meta.json"), _stand),
    "entities": Block(("memory.csv",), _entities),
    "dataset": Block(("dataset.csv",), _dataset),
    "settings": Block(("settings.csv",), _settings),
    "durability": Block(("settings.csv",), _durability),
    "load": Block(("load.csv",), _load),
    "memory_pg": Block(("memory.csv",), _memory_pg),
    "memory_redis": Block(("memory.csv",), _memory_redis),
    "memory_totals": Block(("memory.csv",), _memory_totals),
    "memory_compare": Block(("memory.csv",), _memory_compare),
    "reads_default": Block(_MED_RUNS, _reads("default")),
    "reads_tuned": Block(_MED_RUNS, _reads("tuned")),
    "reads_pg_configs": Block(_MED, _reads_pg_configs),
    "reads_zipf": Block(_MED, _reads_zipf),
    "reads_c16": Block(_MED_RUNS, _reads_c16),
    "client_cpu": Block(_MED, _client_cpu),
    "client_gap": Block(_MED, _client_gap),
    "optimization": Block(_MED_RUNS, _optimization),
    "prepared": Block(_MED, _prepared),
    "writes_tuned": Block(_MED_RUNS, _writes("tuned")),
    "writes_default": Block(_MED_RUNS, _writes("default")),
    "bulk": Block(_MED, _bulk),
    "redis_fsync": Block(_REDIS_DIAG, _redis_fsync),
    "redis_fsync_relaxed": Block(tuple(_diag_file("tuned", "relaxed", r) for r in (1, 2, 3)), _redis_fsync_relaxed),
    "redis_commands": Block(_REDIS_DIAG, _redis_commands),
    **{f"plan_{q}_{p}": Block((_plan_file(q, p),), _plan(q, p)) for q, p in PLAN_BLOCKS},
}


# ---------------------------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------------------------

@dataclass
class _Span:
    name: str
    start: int      # index right after the begin marker
    stop: int       # index of the end marker


def _spans(text: str, blocks: dict[str, Block]) -> list[_Span]:
    spans: list[_Span] = []
    seen: set[str] = set()
    open_: tuple[str, int] | None = None
    for m in _MARKER_RE.finditer(text):
        kind, name = m.group(1), m.group(2)
        if kind == "begin":
            if open_ is not None:
                raise ReportError(f"block {open_[0]}: begin of {name} before its end marker")
            if name not in blocks:
                raise ReportError(f"unknown block {name}")
            if name in seen:
                raise ReportError(f"block {name} appears more than once")
            seen.add(name)
            open_ = (name, m.end())
        else:
            if open_ is None or open_[0] != name:
                raise ReportError(f"end marker of {name} without its begin")
            spans.append(_Span(name, open_[1], m.start()))
            open_ = None
    if open_ is not None:
        raise ReportError(f"block {open_[0]} has no end marker")
    return spans


def render(text: str, data: Data, blocks: dict[str, Block] | None = None) -> str:
    blocks = BLOCKS if blocks is None else blocks
    out, pos = [], 0
    for s in _spans(text, blocks):
        out += [text[pos:s.start], "\n" + blocks[s.name].build(data) + "\n"]
        pos = s.stop
    out.append(text[pos:])
    return "".join(out)


# ---------------------------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------------------------

_NUM_RE = re.compile(r"(?<![\w.,])\d+(?: \d{3})*(?:[.,]\d+)?")
# A prose number: grouped (regular or no-break space) or plain digits, optional decimal comma,
# optional % or ×. Whole tokens only: not glued to letters, digits, dots or commas on either side.
_PROSE_RE = re.compile(r"(?<![\w.,])(?:\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:,\d+)?(?: ?%|×)?(?!\w|[.,]\d)")
_LINK_TARGET_RE = re.compile(r"\]\([^)]*\)")
_SECTION_REF_RE = re.compile(r"(?:п\.|§)\s*\d+(?:\.\d+)*")
_DOT_DECIMAL_RE = re.compile(r"(?<![\w.])\d+\.\d+")
_LATIN_X_RE = re.compile(r"(?<![\w.,])\d+(?:[.,]\d+)?\s?[xх](?!\w)")
_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
_RAW_RE = re.compile(r"\d+(?:\.\d+)?")
_CODE_SPAN_RE = re.compile(r"`[^`]*`")
_SEPARATOR_RE = re.compile(r"^\|[\s:|-]+\|$")


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _table_value_cells(text: str) -> list[str]:
    """Value cells (not header, not separator, not the row-label column) of every markdown table
    in `text`, code spans removed."""
    cells: list[str] = []
    in_table = False
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            in_table = False
            continue
        if not in_table:            # header row
            in_table = True
            continue
        if _SEPARATOR_RE.match(line.strip()):
            continue
        cells += [_CODE_SPAN_RE.sub("", c) for c in _cells(line)[1:]]
    return cells


def table_numbers(text: str) -> list[str]:
    return [n for cell in _table_value_cells(text) for n in _NUM_RE.findall(cell)]


def _float_forms(v: float) -> set[str]:
    return {fmt_num(v * scale, digits) for scale in (1, 1e-3, 1e-6, 100) for digits in range(4)}


def _forms(token: str) -> set[str]:
    return {token, token.replace(".", ",")} | _float_forms(float(token))


def _leaves(obj) -> Iterable[str]:
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _leaves(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _leaves(v)
    else:
        yield str(obj)


def source_numbers(data: Data, sources: Iterable[str]) -> set[str]:
    """Every string a number from `sources` may legitimately appear as in a generated table."""
    allowed: set[str] = set()
    for name in sources:
        if name.endswith(".csv"):
            strings: Iterable[str] = (v for row in data.csv(name) for v in row.values())
        elif name.endswith(".json"):
            strings = _leaves(data.json(name))
        else:
            strings = [data.text(name)]
        for s in strings:
            for token in _RAW_RE.findall(s or ""):
                allowed |= _forms(token)
    return allowed


def _strip_fences(text: str) -> str:
    out, fenced = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            out.append(line)
    return "\n".join(out)


def verify(text: str, data: Data, blocks: dict[str, Block] | None = None) -> list[str]:
    blocks = BLOCKS if blocks is None else blocks
    try:
        spans = _spans(text, blocks)
    except ReportError as e:
        return [str(e)]
    problems: list[str] = []
    generated: list[str] = []
    outside, pos = [], 0
    for s in spans:
        body = text[s.start:s.stop]
        generated.append(body)
        outside.append(text[pos:s.start])
        pos = s.stop
        block = blocks[s.name]
        data.derived = set()
        if body != "\n" + block.build(data) + "\n":
            problems.append(f"block {s.name} differs from what report_tables generates now "
                            "(edited by hand or data changed: run python -m agrobench.report_tables)")
        allowed = source_numbers(data, block.sources) | data.derived
        for n in table_numbers(body):
            if n not in allowed:
                problems.append(f"block {s.name}: {n} not in {', '.join(block.sources)}")
    outside.append(text[pos:])
    rest = _strip_fences("".join(outside))
    for cell in _table_value_cells(rest):
        for n in _NUM_RE.findall(cell):
            problems.append(f"number {n} in a table outside the generated blocks")
    in_blocks = {_norm(t) for t in _PROSE_RE.findall("\n".join(generated))}
    prose = "\n".join(line for line in rest.splitlines() if not line.lstrip().startswith("|"))
    prose = _COMMENT_RE.sub("", prose)
    for para in re.split(r"\n\s*\n", prose):
        if para.count("`") % 2:
            first = para.strip().splitlines()[0][:60]
            problems.append(f"prose paragraph has an odd number of backticks (a stray backtick would hide "
                            f"the rest from the check): {first!r}")
    prose = _LINK_TARGET_RE.sub("", _CODE_SPAN_RE.sub("", prose))
    body = "\n".join(line for line in prose.splitlines() if not line.lstrip().startswith("#"))
    body = _SECTION_REF_RE.sub("", body)
    for token in _DOT_DECIMAL_RE.findall(body):
        problems.append(f"prose number {token} uses a decimal point: write it with a comma (a result) "
                        "or as code (a version or a constant)")
    for token in _LATIN_X_RE.findall(body):
        problems.append(f"prose factor {token.strip()} uses a letter x: write × (and generate the ratio)")
    for token in _PROSE_RE.findall(prose):
        if _checked(token) and _norm(token) not in in_blocks:
            problems.append(f"prose number {token.strip()} does not appear in any generated table")
    return problems


def _norm(token: str) -> str:
    return token.strip().replace(" ", NBSP).replace(NBSP + "%", "%")


def _checked(token: str) -> bool:
    """Results, not labels: decimals, thousands groups, percentages, ratios, integers >= 100."""
    t = _norm(token)
    if any(ch in t for ch in (",", NBSP, "%", "×")):
        return True
    return int(t) >= 100


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify only, do not rewrite the report")
    parser.add_argument("--report", type=Path, default=REPORT_PATH)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    args = parser.parse_args(argv)
    data = Data(args.data_dir)
    text = args.report.read_text(encoding="utf-8")
    if not args.check:
        text = render(text, data)
        args.report.write_text(text, encoding="utf-8", newline="\n")
    problems = verify(text, data)
    for p in problems:
        print(f"report_tables: {p}", file=sys.stderr)
    if not problems:
        print(f"report_tables: {args.report} OK ({len(_spans(text, BLOCKS))} generated blocks)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
