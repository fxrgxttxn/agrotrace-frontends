"""Deterministic synthetic data generator for the PostgreSQL/Redis benchmark (spec §13.4).

Four entities (organizations, batches, batch_links, lab_tests), `--scale` rows each (default
10000). batches form a DAG of depth <= 12: 60% RAW (no parents), 40% DERIVED with 1-4 parents
picked only from earlier (lower-id) batches, which by construction makes the graph acyclic —
batch ids double as a topological/chronological order (harvested_at strictly increases with id).
Status shares and the lab FAIL share follow spec §13.4. A fixed --seed makes a given --scale
reproducible byte-for-byte (test_generate.py:test_deterministic_for_same_seed).

Output: four CSVs in --out-dir (default benchmark/data/, git-ignored) — organizations.csv,
batches.csv, batch_links.csv, lab_tests.csv — column order matching schema_pg.sql, consumed by
load_pg.py and load_redis.py.
"""
from __future__ import annotations

import argparse
import csv
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_SCALE = 10_000
DEFAULT_SEED = 42
MAX_DEPTH = 12
RAW_SHARE = 0.6

# Real-world status shares (spec §13.4); the remaining ~20% is split evenly across the rest.
STATUS_SHARE = {"Approved": 0.45, "Accepted": 0.20, "OnSale": 0.15}
OTHER_STATUSES = [
    "Created", "OnTest", "InTransit", "Processed", "Sold", "Blocked", "Recalled", "WrittenOff",
]

ORG_TYPES = ["FARM", "PROCESSOR", "LAB", "RETAILER", "AUTHORITY"]
# Farms dominate: every batch needs a farm as its origin, so farms must be plentiful.
ORG_TYPE_SHARE = [0.55, 0.20, 0.10, 0.10, 0.05]
REGION_CODES = ["33", "50", "37", "52", "76", "62"]
PRODUCTS = ["Пшеница", "Картофель", "Молоко", "Яблоки", "Морковь", "Говядина", "Мука", "Сыр"]
# Bench-only classification of a batch_links edge (spec §13.3's link_type; not part of the main
# AgroTrace schema, which has no such field).
LINK_TYPES = ["PROCESSING", "REPACKAGE", "MIX"]
LAB_REASONS = ["PLANNED", "RISK", "COMPLAINT", "INSPECTOR"]
FAIL_SHARE = 0.03

EPOCH = datetime(2023, 1, 1, tzinfo=timezone.utc)


@dataclass
class GenResult:
    organizations: list[dict]
    batches: list[dict]
    batch_links: list[dict]
    lab_tests: list[dict]


def _status_for(rng: random.Random) -> str:
    r = rng.random()
    acc = 0.0
    for status, share in STATUS_SHARE.items():
        acc += share
        if r < acc:
            return status
    return rng.choice(OTHER_STATUSES)


def generate(scale: int, seed: int) -> GenResult:
    rng = random.Random(seed)

    organizations: list[dict] = []
    farm_ids: list[int] = []
    for org_id in range(1, scale + 1):
        org_type = rng.choices(ORG_TYPES, weights=ORG_TYPE_SHARE, k=1)[0]
        is_farm = org_type == "FARM"
        if is_farm:
            farm_ids.append(org_id)
        organizations.append({
            "id": org_id,
            "type": org_type,
            "name": f"{org_type.title()} {org_id}",
            "inn": f"{rng.randrange(10**9, 10**10):010d}",
            "region_code": rng.choice(REGION_CODES),
            "trust_rating": rng.randint(0, 100) if is_farm else "",
            "created_at": (EPOCH + timedelta(days=rng.randint(0, 900))).isoformat(),
        })
    if not farm_ids:  # tiny --scale edge case: still need at least one batch origin
        farm_ids = [organizations[0]["id"]]
    holder_candidates = [
        o["id"] for o in organizations if o["type"] in ("FARM", "PROCESSOR", "RETAILER")
    ] or farm_ids
    lab_org_ids = [o["id"] for o in organizations if o["type"] == "LAB"] or [organizations[0]["id"]]

    batches: list[dict] = []
    depth_of: dict[int, int] = {}
    raw_count = round(scale * RAW_SHARE)
    t = EPOCH
    for batch_id in range(1, scale + 1):
        t += timedelta(minutes=rng.randint(1, 120))  # strictly increasing -> valid topological order
        kind = "RAW" if batch_id <= raw_count else "DERIVED"
        depth_of[batch_id] = 0
        batches.append({
            "id": batch_id,
            "public_code": f"BENCH-{batch_id:08d}",
            "product": rng.choice(PRODUCTS),
            "origin_org_id": rng.choice(farm_ids),
            "holder_org_id": rng.choice(holder_candidates),
            "kind": kind,
            "mass_kg": round(rng.uniform(5, 5000), 3),
            "status": _status_for(rng),
            "harvested_at": t.isoformat(),
            "version": 1,
        })

    batch_links: list[dict] = []
    for batch_id in range(raw_count + 1, scale + 1):
        n_parents = rng.randint(1, 4)
        # Only earlier batches (acyclicity), and only ones that keep this batch's depth <= MAX_DEPTH.
        eligible = [b for b in range(1, batch_id) if depth_of[b] < MAX_DEPTH]
        if not eligible:
            eligible = list(range(1, batch_id))
        n_parents = min(n_parents, len(eligible))
        parents = rng.sample(eligible, n_parents)
        depth_of[batch_id] = max(depth_of[p] for p in parents) + 1
        for parent_id in parents:
            batch_links.append({
                "parent_id": parent_id,
                "child_id": batch_id,
                "mass_used_kg": round(rng.uniform(1, 500), 3),
                "link_type": rng.choice(LINK_TYPES),
                "created_at": batches[batch_id - 1]["harvested_at"],
            })

    lab_tests: list[dict] = []
    for test_id in range(1, scale + 1):
        is_fail = rng.random() < FAIL_SHARE
        lab_tests.append({
            "id": test_id,
            "batch_id": rng.randint(1, scale),
            "lab_org_id": rng.choice(lab_org_ids),
            "reason": rng.choice(LAB_REASONS),
            "conclusion": "FAIL" if is_fail else "PASS",
            "value": round(rng.uniform(0, 10), 4),
            "due_at": (EPOCH + timedelta(days=rng.randint(0, 900))).isoformat(),
        })

    return GenResult(organizations, batches, batch_links, lab_tests)


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scale", type=int, default=DEFAULT_SCALE)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parent.parent / "data")
    args = parser.parse_args(argv)

    result = generate(args.scale, args.seed)
    write_csv(result.organizations, args.out_dir / "organizations.csv")
    write_csv(result.batches, args.out_dir / "batches.csv")
    write_csv(result.batch_links, args.out_dir / "batch_links.csv")
    write_csv(result.lab_tests, args.out_dir / "lab_tests.csv")
    print(
        f"generated scale={args.scale} seed={args.seed}: "
        f"{len(result.organizations)} organizations, {len(result.batches)} batches, "
        f"{len(result.batch_links)} batch_links, {len(result.lab_tests)} lab_tests -> {args.out_dir}"
    )


if __name__ == "__main__":
    main()
