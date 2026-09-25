"""Loads the CSVs produced by agrobench.generate into Redis (spec §13.3, §13.4): every write goes
through one big pipeline flushed every 10000 commands, with persistence disabled for the duration
(`CONFIG SET save ""` / `appendonly no`) — restored to the requested durability mode
(appendonly yes, appendfsync per DURABILITY) once loading is done. No `KEYS`/`SCAN` is ever used:
every key this script writes is tracked in Python as it's written, both for the per-type
MEMORY USAGE sampling below and for later query/test code.

Usable as a CLI (`python -m agrobench.load_redis`) and as a library (`load(data_dir)`, used by
tests/test_load_equivalence.py).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import time
from pathlib import Path

import redis

from agrobench import config, redis_keys

PIPELINE_BATCH = 10_000
SAMPLE_SIZE = 100
DURABILITY_APPENDFSYNC = {"strict": "always", "relaxed": "everysec"}

# Key classes sampled for MEMORY USAGE and extrapolated to a total (spec §13.4).
_BUCKETS = [
    "org_hash", "batch_hash", "test_hash", "link_hash", "code_string", "seq_string",
    "children_set", "parents_set", "held_zset", "held_status_zset", "tests_by_due_zset",
    "stats_hash", "tests_list",
]


def _client() -> redis.Redis:
    return redis.Redis.from_url(
        os.environ.get("REDIS_URL", "redis://bench-redis:6379/0"), decode_responses=True,
    )


def _read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load(data_dir: Path) -> dict:
    data_dir = Path(data_dir)
    client = _client()

    original_save = client.config_get("save").get("save", "")
    client.config_set("save", "")
    client.config_set("appendonly", "no")
    client.flushall()

    organizations = _read_csv(data_dir / "organizations.csv")
    batches = _read_csv(data_dir / "batches.csv")
    batch_links = _read_csv(data_dir / "batch_links.csv")
    lab_tests = _read_csv(data_dir / "lab_tests.csv")

    # dict-as-ordered-set: several of these buckets (children_set, parents_set, held_zset,
    # held_status_zset, stats_hash, tests_by_due_zset) share one physical key across many writes
    # (e.g. every lab test RPUSH/ZADDs the *same* tests:by_due key) — counting writes instead of
    # distinct keys would wildly overstate both the sampled key's weight and the extrapolated
    # total, so this dedups by key name and only its length is ever used as the count.
    key_names: dict[str, dict[str, None]] = {name: {} for name in _BUCKETS}

    def touch(bucket: str, key: str) -> None:
        key_names[bucket][key] = None

    pipe = client.pipeline(transaction=False)
    pending = 0

    def queued() -> None:
        nonlocal pending
        pending += 1
        if pending >= PIPELINE_BATCH:
            pipe.execute()
            pending = 0

    start = time.perf_counter()

    for org in organizations:
        key = redis_keys.org_key(org["id"])
        fields = {
            "type": org["type"], "name": org["name"], "inn": org["inn"],
            "region_code": org["region_code"], "created_at": org["created_at"],
        }
        if org["trust_rating"] != "":
            fields["trust_rating"] = org["trust_rating"]
        pipe.hset(key, mapping=fields)
        queued()
        touch("org_hash", key)
    if organizations:
        seq_key = redis_keys.seq_key("organizations")
        pipe.set(seq_key, max(int(o["id"]) for o in organizations))
        queued()
        touch("seq_string", seq_key)

    for batch in batches:
        bid = batch["id"]
        key = redis_keys.batch_key(bid)
        pipe.hset(key, mapping={
            "public_code": batch["public_code"], "product": batch["product"],
            "origin_org_id": batch["origin_org_id"], "holder_org_id": batch["holder_org_id"],
            "kind": batch["kind"], "mass_kg": batch["mass_kg"], "status": batch["status"],
            "harvested_at": batch["harvested_at"], "version": batch["version"],
        })
        queued()
        touch("batch_hash", key)

        code_key = redis_keys.batch_code_key(batch["public_code"])
        pipe.set(code_key, bid)
        queued()
        touch("code_string", code_key)

        score = redis_keys.to_score(batch["harvested_at"])
        held_key = redis_keys.org_held_key(batch["holder_org_id"])
        pipe.zadd(held_key, {bid: score})
        queued()
        touch("held_zset", held_key)

        held_status_key = redis_keys.org_held_status_key(batch["holder_org_id"], batch["status"])
        pipe.zadd(held_status_key, {bid: score})
        queued()
        touch("held_status_zset", held_status_key)

        stats_key = redis_keys.stats_org_key(batch["holder_org_id"])
        pipe.hincrby(stats_key, batch["status"], 1)
        queued()
        touch("stats_hash", stats_key)
    if batches:
        seq_key = redis_keys.seq_key("batches")
        pipe.set(seq_key, max(int(b["id"]) for b in batches))
        queued()
        touch("seq_string", seq_key)

    for link in batch_links:
        key = redis_keys.link_key(link["parent_id"], link["child_id"])
        pipe.hset(key, mapping={
            "mass_used_kg": link["mass_used_kg"], "link_type": link["link_type"],
            "created_at": link["created_at"],
        })
        queued()
        touch("link_hash", key)

        children_key = redis_keys.batch_children_key(link["parent_id"])
        pipe.sadd(children_key, link["child_id"])
        queued()
        touch("children_set", children_key)

        parents_key = redis_keys.batch_parents_key(link["child_id"])
        pipe.sadd(parents_key, link["parent_id"])
        queued()
        touch("parents_set", parents_key)

    for test in lab_tests:
        tid = test["id"]
        key = redis_keys.test_key(tid)
        pipe.hset(key, mapping={
            "batch_id": test["batch_id"], "lab_org_id": test["lab_org_id"], "reason": test["reason"],
            "conclusion": test["conclusion"], "value": test["value"], "due_at": test["due_at"],
        })
        queued()
        touch("test_hash", key)

        tests_key = redis_keys.batch_tests_key(test["batch_id"])
        pipe.rpush(tests_key, tid)
        queued()
        touch("tests_list", tests_key)

        by_due_key = redis_keys.tests_by_due_key()
        pipe.zadd(by_due_key, {tid: redis_keys.to_score(test["due_at"])})
        queued()
        touch("tests_by_due_zset", by_due_key)
    if lab_tests:
        seq_key = redis_keys.seq_key("lab_tests")
        pipe.set(seq_key, max(int(t["id"]) for t in lab_tests))
        queued()
        touch("seq_string", seq_key)

    if pending:
        pipe.execute()
    load_seconds = time.perf_counter() - start

    durability = os.environ.get("DURABILITY", "relaxed")
    client.config_set("appendonly", "yes")
    client.config_set("appendfsync", DURABILITY_APPENDFSYNC[durability])
    if original_save:
        client.config_set("save", original_save)

    memory_info = client.info("memory")
    memory_by_bucket: dict[str, dict] = {}
    for bucket, names in key_names.items():
        count = len(names)
        if count == 0:
            continue
        sample_keys = list(names)[:SAMPLE_SIZE]
        usages = [client.memory_usage(k) or 0 for k in sample_keys]
        avg = sum(usages) / len(usages)
        memory_by_bucket[bucket] = {
            "count": count,
            "sample_size": len(sample_keys),
            "avg_bytes": avg,
            "extrapolated_bytes": round(avg * count),
        }

    return {
        "load_seconds": load_seconds,
        "used_memory_bytes": memory_info.get("used_memory"),
        "memory_by_bucket": memory_by_bucket,
    }


def _write_results(stats: dict, results_dir: Path) -> None:
    results_dir.mkdir(parents=True, exist_ok=True)
    with (results_dir / "load_redis.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["key_type", "count", "sample_size", "avg_bytes", "extrapolated_bytes"])
        for bucket, info in stats["memory_by_bucket"].items():
            writer.writerow([
                bucket, info["count"], info["sample_size"], f"{info['avg_bytes']:.2f}", info["extrapolated_bytes"],
            ])
        writer.writerow(["__load_seconds__", f"{stats['load_seconds']:.6f}", "", "", ""])
        writer.writerow(["__used_memory_bytes__", stats["used_memory_bytes"], "", "", ""])


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("DATA_DIR", str(config.BENCH_DIR / "data"))))
    parser.add_argument("--results-dir", type=Path, default=Path(os.environ.get("RESULTS_DIR", str(config.BENCH_DIR / "results"))))
    args = parser.parse_args(argv)

    stats = load(args.data_dir)
    _write_results(stats, args.results_dir)
    print(json.dumps(stats, indent=2, default=str))


if __name__ == "__main__":
    main()
