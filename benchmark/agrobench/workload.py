"""Workload for the measurement harness (spec §13.6): key sequences (uniform and Zipf 1.1, fixed
seeds, identical for both DBMS), prepared records for writes/deletes, and the untimed per-DBMS
fixtures that insert those records, clean them up and prove the main dataset is back to exactly
its pre-series state.

Key sequences depend only on the dataset (the generated CSVs both DBMS were loaded from), the
query name, the distribution and the phase (warmup/measure) — never on the DBMS — so PostgreSQL
and Redis are asked for exactly the same keys in exactly the same order
(tests/test_workload.py). Zipf ranks are mapped onto keys through a fixed per-keyspace permutation
(seeded by the keyspace name only), so the hot set is the same for warm-up and measurement and
across queries sharing a keyspace, and is not simply "the lowest ids" (which in this generator are
the RAW roots of the DAG).

Writes and deletes never touch the 10 000-record main set (spec §13.6): every prepared entity has
an id >= PREP_ID_BASE, prepared batches have harvested_at values after every generated one (the
unique-harvested_at invariant, see redis_keys.org_held_status_key), prepared lab tests for D2 are
due before every generated one. After each series the prepared entities are removed, Redis
stats:org:* counters touched by the series are restored from a snapshot (a status counter created
by the series would otherwise remain as a "0" field), PostgreSQL is VACUUM ANALYZEd, and a full
dataset fingerprint (PostgreSQL: row count + md5 of every table's ordered rows; Redis: DBSIZE +
DEBUG DIGEST) must equal the one taken before the series, or the run aborts.
"""
from __future__ import annotations

import csv
import hashlib
import os
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Sequence

import numpy as np
import psycopg
import redis

from agrobench import redis_keys
from agrobench.queries import pg as pgq
from agrobench.queries import redis as rq

ZIPF_S = 1.1
DISTRIBUTIONS = ("uniform", "zipf")
PREP_ID_BASE = 1_000_000_000
READ_QUERIES = ("R1", "R2", "R3", "R4", "R5", "R6")
_REDIS_CHUNK = 1000


# ---------------------------------------------------------------------------------------------
# Deterministic key sequences
# ---------------------------------------------------------------------------------------------

def stable_seed(*parts: object) -> int:
    """64-bit seed from any parts, stable across processes (unlike hash())."""
    digest = hashlib.sha256("\x1f".join(str(p) for p in parts).encode()).digest()
    return int.from_bytes(digest[:8], "big")


def uniform_indices(n: int, size: int, seed: int) -> np.ndarray:
    if n <= 0:
        raise ValueError("empty keyspace")
    return np.random.default_rng(seed).integers(0, n, size=size)


def zipf_probabilities(n: int, s: float = ZIPF_S) -> np.ndarray:
    """Bounded Zipf over ranks 1..n: P(rank k) proportional to 1/k^s."""
    if n <= 0:
        raise ValueError("empty keyspace")
    weights = 1.0 / np.power(np.arange(1, n + 1, dtype=np.float64), s)
    return weights / weights.sum()


def zipf_indices(n: int, size: int, seed: int, *, s: float = ZIPF_S, perm_seed: int = 0) -> np.ndarray:
    """Zipf(s)-distributed key indices in 0..n-1: rank draws (rank 0 = hottest) mapped to key
    indices through a permutation fixed by `perm_seed`."""
    ranks = np.random.default_rng(seed).choice(n, size=size, p=zipf_probabilities(n, s))
    perm = np.random.default_rng(perm_seed).permutation(n)
    return perm[ranks]


def key_indices(n: int, distribution: str, size: int, seed: int, *, keyspace: str) -> np.ndarray:
    if distribution == "uniform":
        return uniform_indices(n, size, seed)
    if distribution == "zipf":
        return zipf_indices(n, size, seed, perm_seed=stable_seed("zipf-perm", keyspace))
    raise ValueError(f"unknown distribution {distribution!r}")


# ---------------------------------------------------------------------------------------------
# Dataset (the generated CSVs both DBMS were loaded from)
# ---------------------------------------------------------------------------------------------

def _read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


@dataclass
class Dataset:
    organizations: list[dict]
    batches: list[dict]
    batch_links: list[dict]
    lab_tests: list[dict]
    parents_of: dict[int, list[dict]] = field(default_factory=dict)
    tests_of: dict[int, list[dict]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for link in self.batch_links:
            self.parents_of.setdefault(int(link["child_id"]), []).append(link)
        for test in self.lab_tests:
            self.tests_of.setdefault(int(test["batch_id"]), []).append(test)

    # Keyspaces, each in a fixed (sorted) order so indices mean the same thing everywhere.
    def batch_ids(self) -> list[int]:
        return sorted(int(b["id"]) for b in self.batches)

    def batch_codes(self) -> list[str]:
        return [b["public_code"] for b in sorted(self.batches, key=lambda b: int(b["id"]))]

    def holder_ids(self) -> list[int]:
        return sorted({int(b["holder_org_id"]) for b in self.batches})

    def holder_status_pairs(self) -> list[tuple[int, str]]:
        return sorted({(int(b["holder_org_id"]), b["status"]) for b in self.batches})

    def max_harvested_at(self) -> datetime:
        return max(datetime.fromisoformat(b["harvested_at"]) for b in self.batches)

    def min_due_at(self) -> datetime:
        return min(datetime.fromisoformat(t["due_at"]) for t in self.lab_tests)


def load_dataset(data_dir: Path) -> Dataset:
    data_dir = Path(data_dir)
    return Dataset(
        organizations=_read_csv(data_dir / "organizations.csv"),
        batches=_read_csv(data_dir / "batches.csv"),
        batch_links=_read_csv(data_dir / "batch_links.csv"),
        lab_tests=_read_csv(data_dir / "lab_tests.csv"),
    )


def read_args(dataset: Dataset, query: str, distribution: str, size: int, phase: str) -> list[tuple]:
    """Argument tuples for read query R1..R6 — a pure function of (dataset, query, distribution,
    size, phase), shared verbatim by both DBMS."""
    if query in ("R1", "R4", "R5"):
        keys, keyspace = dataset.batch_ids(), "batches"
        wrap = lambda k: (k,)  # noqa: E731
    elif query == "R2":
        keys, keyspace = dataset.batch_codes(), "batches"
        wrap = lambda k: (k,)  # noqa: E731
    elif query == "R3":
        keys, keyspace = dataset.holder_status_pairs(), "holder_status"
        wrap = lambda k: k  # noqa: E731
    elif query == "R6":
        keys, keyspace = dataset.holder_ids(), "holders"
        wrap = lambda k: (k,)  # noqa: E731
    else:
        raise ValueError(f"not a read query: {query!r}")
    idx = key_indices(len(keys), distribution, size, stable_seed(query, distribution, phase, size),
                      keyspace=keyspace)
    return [wrap(keys[i]) for i in idx]


# ---------------------------------------------------------------------------------------------
# Prepared records for writes/deletes
# ---------------------------------------------------------------------------------------------

class Allocator:
    """Hands out ids/timestamps for prepared entities, never reusing one within a process: batch
    and test ids from PREP_ID_BASE up, harvested_at one second apart after every generated batch
    (keeps harvested_at globally unique), D2 due-date slots one hour apart before every generated
    lab test."""

    def __init__(self, dataset: Dataset) -> None:
        self.next_batch_id = PREP_ID_BASE
        self.next_test_id = PREP_ID_BASE
        self._ts_base = dataset.max_harvested_at() + timedelta(days=1)
        self._ts_offset = 0
        self._due_base = dataset.min_due_at() - timedelta(days=3650)
        self._due_slot = 0

    def batch_id(self) -> int:
        self.next_batch_id += 1
        return self.next_batch_id - 1

    def test_id(self) -> int:
        self.next_test_id += 1
        return self.next_test_id - 1

    def harvested_at(self) -> str:
        self._ts_offset += 1
        return (self._ts_base + timedelta(seconds=self._ts_offset)).isoformat()

    def due_slot(self) -> tuple[datetime, datetime]:
        """[start, end) of a fresh one-hour slot, entirely before every generated due_at."""
        start = self._due_base + timedelta(hours=self._due_slot)
        self._due_slot += 1
        end = start + timedelta(hours=1)
        return start, end


@dataclass
class Prepared:
    batches: list[dict] = field(default_factory=list)
    links: list[dict] = field(default_factory=list)
    tests: list[dict] = field(default_factory=list)
    # Ids of prepared lab tests created on the fly during a series (D2 groups) — ints only, so a
    # 1000 x 1000-test D2 series does not keep a million dicts alive just for the final cleanup.
    extra_test_ids: list[int] = field(default_factory=list)

    def test_ids(self) -> list[int]:
        return [t["id"] for t in self.tests] + self.extra_test_ids


def _source_batches(dataset: Dataset, count: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    return [rng.choice(dataset.batches) for _ in range(count)]


def prepared_batches(dataset: Dataset, alloc: Allocator, count: int, seed: int) -> list[dict]:
    """`count` new batches, each a copy of a (seeded, uniformly chosen) existing batch's attributes
    — same holder, status, product, origin, kind, mass — under a fresh id, public_code and
    harvested_at. Copying holder+status keeps the stats:org:* counters they touch pre-existing."""
    out = []
    for src in _source_batches(dataset, count, seed):
        bid = alloc.batch_id()
        out.append({
            "id": bid,
            "public_code": f"PREP-{bid}",
            "product": src["product"],
            "origin_org_id": int(src["origin_org_id"]),
            "holder_org_id": int(src["holder_org_id"]),
            "kind": src["kind"],
            "mass_kg": src["mass_kg"],
            "status": src["status"],
            "harvested_at": alloc.harvested_at(),
            "version": 1,
        })
    return out


def prepared_copies(dataset: Dataset, alloc: Allocator, count: int, seed: int) -> Prepared:
    """D1's "заранее вставленные копии" (spec §13.6): copies of existing batches *with* their
    parent edges (to the same parents) and their lab tests, so D1's cascade has the same shape of
    work to do as it would on the original."""
    prep = Prepared()
    for src in _source_batches(dataset, count, seed):
        bid = alloc.batch_id()
        prep.batches.append({
            "id": bid, "public_code": f"PREP-{bid}", "product": src["product"],
            "origin_org_id": int(src["origin_org_id"]), "holder_org_id": int(src["holder_org_id"]),
            "kind": src["kind"], "mass_kg": src["mass_kg"], "status": src["status"],
            "harvested_at": alloc.harvested_at(), "version": 1,
        })
        for link in dataset.parents_of.get(int(src["id"]), []):
            prep.links.append({
                "parent_id": int(link["parent_id"]), "child_id": bid,
                "mass_used_kg": link["mass_used_kg"], "link_type": link["link_type"],
                "created_at": link["created_at"],
            })
        for test in dataset.tests_of.get(int(src["id"]), []):
            prep.tests.append({
                "id": alloc.test_id(), "batch_id": bid, "lab_org_id": int(test["lab_org_id"]),
                "reason": test["reason"], "conclusion": test["conclusion"], "value": test["value"],
                "due_at": test["due_at"],
            })
    return prep


def prepared_due_group(dataset: Dataset, alloc: Allocator, size: int, seed: int) -> tuple[list[dict], datetime]:
    """One D2 operation's worth of lab tests: `size` new tests, all due inside a fresh slot that
    precedes every generated (and every earlier prepared) due_at, attached to existing batches.
    Returns the tests and the D2 cutoff that deletes exactly them."""
    rng = random.Random(seed)
    start, end = alloc.due_slot()
    tests = []
    for j in range(size):
        src = rng.choice(dataset.lab_tests)
        tests.append({
            "id": alloc.test_id(),
            "batch_id": int(rng.choice(dataset.batches)["id"]),
            "lab_org_id": int(src["lab_org_id"]), "reason": src["reason"],
            "conclusion": src["conclusion"], "value": src["value"],
            "due_at": (start + timedelta(seconds=j * 3600 / max(size, 1))).isoformat(),
        })
    return tests, end


def next_status(current: str, statuses: Sequence[str], rng: random.Random) -> str:
    """W3's target status: a seeded choice among the statuses other than the current one."""
    return rng.choice([s for s in statuses if s != current])


# ---------------------------------------------------------------------------------------------
# Untimed fixtures: insert prepared records, clean up, fingerprint
# ---------------------------------------------------------------------------------------------

class DatasetNotRestored(RuntimeError):
    pass


_LINK_COLS = ["parent_id", "child_id", "mass_used_kg", "link_type", "created_at"]
_TEST_COLS = ["id", "batch_id", "lab_org_id", "reason", "conclusion", "value", "due_at"]


class PgFixtures:
    """Untimed PostgreSQL helpers (own sync autocommit connection, never the measured pool)."""

    dbms = "pg"

    def __init__(self, conninfo: str = "") -> None:
        self.conn = psycopg.connect(conninfo, autocommit=True)

    def close(self) -> None:
        self.conn.close()

    def insert(self, prep: Prepared) -> None:
        if prep.batches:
            pgq.w2_insert_batches_copy(self.conn, prep.batches)
        with self.conn.cursor() as cur:
            if prep.links:
                with cur.copy(f"COPY batch_links ({', '.join(_LINK_COLS)}) FROM STDIN") as copy:
                    for link in prep.links:
                        copy.write_row([link[c] for c in _LINK_COLS])
            if prep.tests:
                with cur.copy(f"COPY lab_tests ({', '.join(_TEST_COLS)}) FROM STDIN") as copy:
                    for test in prep.tests:
                        copy.write_row([test[c] for c in _TEST_COLS])

    def cleanup(self, prep: Prepared, *, vacuum: bool = True) -> None:
        """Removes every prepared entity (ids >= PREP_ID_BASE) whatever the series did to it, then
        VACUUM ANALYZE so dead tuples/statistics don't leak into the next series."""
        with self.conn.cursor() as cur:
            cur.execute("DELETE FROM lab_tests WHERE id >= %s OR batch_id >= %s", (PREP_ID_BASE, PREP_ID_BASE))
            cur.execute("DELETE FROM batch_links WHERE parent_id >= %s OR child_id >= %s", (PREP_ID_BASE, PREP_ID_BASE))
            cur.execute("DELETE FROM batches WHERE id >= %s", (PREP_ID_BASE,))
            if vacuum:
                cur.execute("VACUUM ANALYZE lab_tests, batch_links, batches")

    def snapshot(self, prep: Prepared) -> object:
        return None

    def restore(self, snapshot: object) -> None:
        pass

    def fingerprint(self) -> dict:
        fp = {}
        orders = {
            "organizations": "id", "batches": "id", "batch_links": "parent_id, child_id",
            "lab_tests": "id",
        }
        with self.conn.cursor() as cur:
            for table, order in orders.items():
                cur.execute(
                    f"SELECT count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY {order}), '')) "
                    f"FROM {table} t"
                )
                count, digest = cur.fetchone()
                fp[table] = f"{count}:{digest}"
        return fp


class RedisFixtures:
    """Untimed Redis helpers (own sync client, never the measured pool)."""

    dbms = "redis"

    def __init__(self, url: str | None = None) -> None:
        self.r = redis.Redis.from_url(url or os.environ["REDIS_URL"], decode_responses=True)
        self._d1_sha = self.r.script_load(rq._D1_LUA)

    def close(self) -> None:
        self.r.close()

    def insert(self, prep: Prepared) -> None:
        pipe = self.r.pipeline(transaction=False)
        pending = 0

        def flush_maybe() -> None:
            nonlocal pending
            pending += 1
            if pending >= _REDIS_CHUNK:
                pipe.execute()
                pending = 0

        for batch in prep.batches:
            rq._queue_w1(pipe, batch)
            flush_maybe()
        for link in prep.links:
            pipe.hset(redis_keys.link_key(link["parent_id"], link["child_id"]), mapping={
                "mass_used_kg": link["mass_used_kg"], "link_type": link["link_type"],
                "created_at": link["created_at"],
            })
            pipe.sadd(redis_keys.batch_children_key(link["parent_id"]), link["child_id"])
            pipe.sadd(redis_keys.batch_parents_key(link["child_id"]), link["parent_id"])
            flush_maybe()
        for test in prep.tests:
            pipe.hset(redis_keys.test_key(test["id"]), mapping={
                "batch_id": test["batch_id"], "lab_org_id": test["lab_org_id"],
                "reason": test["reason"], "conclusion": test["conclusion"], "value": test["value"],
                "due_at": test["due_at"],
            })
            pipe.rpush(redis_keys.batch_tests_key(test["batch_id"]), test["id"])
            pipe.zadd(redis_keys.tests_by_due_key(), {test["id"]: redis_keys.to_score(test["due_at"])})
            flush_maybe()
        pipe.execute()

    def cleanup(self, prep: Prepared, *, vacuum: bool = True) -> None:
        """Removes every prepared entity whatever the series did to it: batches via the D1 script
        (hash, code, held zsets, stats, edges, own tests — a no-op for ones already deleted), then
        any prepared test still present (D2 groups, tests attached to existing batches)."""
        pipe = self.r.pipeline(transaction=False)
        for i, batch in enumerate(prep.batches, 1):
            pipe.evalsha(self._d1_sha, 0, batch["id"])
            if i % _REDIS_CHUNK == 0:
                pipe.execute()
        pipe.execute()
        test_ids = prep.test_ids()
        for start in range(0, len(test_ids), _REDIS_CHUNK):
            chunk = test_ids[start:start + _REDIS_CHUNK]
            pipe = self.r.pipeline(transaction=False)
            for tid in chunk:
                pipe.hget(redis_keys.test_key(tid), "batch_id")
            owners = pipe.execute()
            pipe = self.r.pipeline(transaction=False)
            for tid, owner in zip(chunk, owners):
                if owner is None:
                    continue
                pipe.delete(redis_keys.test_key(tid))
                pipe.zrem(redis_keys.tests_by_due_key(), tid)
                pipe.lrem(redis_keys.batch_tests_key(owner), 0, tid)
            pipe.execute()

    def snapshot(self, prep: Prepared) -> dict[int, dict]:
        """stats:org:{holder} of every holder the series can touch, verbatim."""
        holders = sorted({int(b["holder_org_id"]) for b in prep.batches})
        pipe = self.r.pipeline(transaction=False)
        for h in holders:
            pipe.hgetall(redis_keys.stats_org_key(h))
        return dict(zip(holders, pipe.execute()))

    def restore(self, snapshot: dict[int, dict]) -> None:
        pipe = self.r.pipeline(transaction=False)
        for holder, fields in snapshot.items():
            key = redis_keys.stats_org_key(holder)
            pipe.delete(key)
            if fields:
                pipe.hset(key, mapping=fields)
        pipe.execute()

    def fingerprint(self) -> dict:
        return {
            "dbsize": str(self.r.dbsize()),
            "digest": str(self.r.execute_command("DEBUG", "DIGEST")),
        }


class RestoreGuard:
    """Wraps one write/delete series: fingerprint + snapshot before, cleanup + restore +
    fingerprint after; raises DatasetNotRestored if the two fingerprints differ."""

    def __init__(self, fixtures, prep: Prepared) -> None:
        self.fixtures = fixtures
        self.prep = prep
        self.before: dict | None = None
        self.after: dict | None = None

    def __enter__(self) -> "RestoreGuard":
        self.before = self.fixtures.fingerprint()
        self._snapshot = self.fixtures.snapshot(self.prep)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.fixtures.cleanup(self.prep)
        self.fixtures.restore(self._snapshot)
        self.after = self.fixtures.fingerprint()
        if exc_type is None and self.after != self.before:
            raise DatasetNotRestored(
                f"{self.fixtures.dbms}: dataset fingerprint changed across the series: "
                f"before={self.before} after={self.after}"
            )
