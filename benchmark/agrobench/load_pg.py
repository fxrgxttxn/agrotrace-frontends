"""Loads the CSVs produced by agrobench.generate into PostgreSQL (spec §13.2, §13.4): tables
created without indexes, data loaded via COPY, then indexes built and ANALYZE run. Records COPY
time and `pg_total_relation_size` per table to results/load_pg.csv.

Usable as a CLI (`python -m agrobench.load_pg`) and as a library (`load(data_dir)`, used by
tests/test_load_equivalence.py).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import time
from pathlib import Path

import psycopg

from agrobench import config

SCHEMA_FILE = config.BENCH_DIR / "agrobench" / "schema_pg.sql"
INDEX_MARKER = "-- === INDEXES (created after COPY + ANALYZE) ==="

# (table, csv filename, column order) - matches schema_pg.sql and generate.py exactly, and is the
# FK-safe creation/load order (organizations before batches, batches before batch_links/lab_tests).
TABLES = [
    ("organizations", "organizations.csv",
     ["id", "type", "name", "inn", "region_code", "trust_rating", "created_at"]),
    ("batches", "batches.csv",
     ["id", "public_code", "product", "origin_org_id", "holder_org_id", "kind", "mass_kg",
      "status", "harvested_at", "version"]),
    ("batch_links", "batch_links.csv",
     ["parent_id", "child_id", "mass_used_kg", "link_type", "created_at"]),
    ("lab_tests", "lab_tests.csv",
     ["id", "batch_id", "lab_org_id", "reason", "conclusion", "value", "due_at"]),
]


def _split_schema() -> tuple[str, str]:
    text = SCHEMA_FILE.read_text(encoding="utf-8")
    before, marker, after = text.partition(INDEX_MARKER)
    if not marker:
        raise RuntimeError(f"{SCHEMA_FILE}: index marker {INDEX_MARKER!r} not found")
    return before, after


def load(data_dir: Path) -> dict:
    """Drops+recreates the four tables, COPYs the CSVs in `data_dir`, then builds indexes and
    ANALYZEs. Returns {"timings_seconds": {...}, "sizes_bytes": {...}}.
    """
    data_dir = Path(data_dir)
    table_ddl, index_ddl = _split_schema()
    timings: dict[str, float] = {}
    sizes: dict[str, int] = {}

    with psycopg.connect(autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS lab_tests, batch_links, batches, organizations CASCADE")
            cur.execute(table_ddl)

        for table, csv_name, columns in TABLES:
            csv_path = data_dir / csv_name
            cols = ", ".join(columns)
            start = time.perf_counter()
            with conn.cursor() as cur, cur.copy(
                f"COPY {table} ({cols}) FROM STDIN WITH (FORMAT csv, HEADER true)"
            ) as copy:
                with csv_path.open("rb") as f:
                    while chunk := f.read(1024 * 1024):
                        copy.write(chunk)
            timings[table] = time.perf_counter() - start

        start = time.perf_counter()
        with conn.cursor() as cur:
            cur.execute(index_ddl)
            cur.execute("ANALYZE")
        timings["indexes_and_analyze"] = time.perf_counter() - start

        with conn.cursor() as cur:
            for table, _, _ in TABLES:
                cur.execute("SELECT pg_total_relation_size(%s)", (table,))
                sizes[table] = cur.fetchone()[0]

    return {"timings_seconds": timings, "sizes_bytes": sizes}


def _write_results(stats: dict, results_dir: Path) -> None:
    results_dir.mkdir(parents=True, exist_ok=True)
    with (results_dir / "load_pg.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["table", "copy_seconds", "total_relation_size_bytes"])
        for table, _, _ in TABLES:
            writer.writerow([
                table,
                f"{stats['timings_seconds'][table]:.6f}",
                stats["sizes_bytes"][table],
            ])
        writer.writerow(["__indexes_and_analyze__", f"{stats['timings_seconds']['indexes_and_analyze']:.6f}", ""])


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("DATA_DIR", str(config.BENCH_DIR / "data"))))
    parser.add_argument("--results-dir", type=Path, default=Path(os.environ.get("RESULTS_DIR", str(config.BENCH_DIR / "results"))))
    args = parser.parse_args(argv)

    stats = load(args.data_dir)
    _write_results(stats, args.results_dir)
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
