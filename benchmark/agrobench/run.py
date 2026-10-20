"""Measurement run for the live configuration (spec §13.6): `./at.sh bench run` measures
PostgreSQL, then Redis (the other DBMS idle), `--runs` times (default 3), every query at
concurrency 1 and 16, reads under uniform and Zipf(1.1) key selection; writes and deletes on
prepared records with the main dataset verified restored after every series. `./at.sh bench all`
calls this once per (profile, durability) configuration.

Per configuration it writes (all under results/, git-ignored; bench.sh `publish` copies the
consolidated files to docs/reports/data/):
  raw/measurements_<profile>_<durability>.csv   one row per (dbms, query, variant, distribution,
                                                concurrency, run)
  settings/<dbms>_<profile>_<durability>.json   live SHOW / CONFIG GET values, checked against
                                                the profile (a mismatch aborts the run)
  load/<profile>_<durability>.json              load time and size/memory right after the load
  plans/pg_<profile>_<durability>_<query>.txt   EXPLAIN (ANALYZE, BUFFERS) for R3-R6, D1, D2
  redis/redis_<profile>_<durability>_run<N>.txt SLOWLOG / LATENCY / commandstats per run
and then re-consolidates every configuration measured so far into measurements.csv,
measurements_median.csv (median of runs — what the report uses), load.csv, memory.csv,
settings.csv.

Workload sizes (spec §13.6): warm-up 1000 and 10 000 measured calls per read series; 1000
measured calls per W1/W3/D1 series at concurrency 1 and 10 000 at concurrency 16 (160 warm-up
calls on separate prepared records, >= 10 per client connection); D2 1000 measured calls (10
warm-up), each deleting a fresh prepared group of 1000 lab tests; W2 is itself a 10 000-row bulk
insert, so it is measured 20 times per run (10 warm-up) rather than 1000 — see
docs/reports and task-4-report for the reasoning. W2 and D2 run at concurrency 1 only (bulk
operations over one shared range, not independent per-client work).
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import csv
import json
import multiprocessing as mp
import os
import random
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import psycopg
import redis
import redis.asyncio as aioredis
from psycopg_pool import AsyncConnectionPool

from agrobench import config
from agrobench.generate import OTHER_STATUSES, STATUS_SHARE
from agrobench.measure import (
    MIN_WARM_PER_CLIENT, PG_PREPARE_THRESHOLD, SeriesResult, choose_method, measure, merge_parallel,
    merge_sequential,
)
from agrobench.queries import pg_async as pga
from agrobench.queries import redis_async as ra
from agrobench.stats import METRICS, median_of_runs
from agrobench.workload import (
    DISTRIBUTIONS, READ_QUERIES, Allocator, Dataset, PgFixtures, Prepared, RedisFixtures,
    RestoreGuard, load_dataset, next_status, prepared_batches, prepared_copies,
    prepared_due_group, read_args, stable_seed,
)

ALL_STATUSES = list(STATUS_SHARE) + OTHER_STATUSES
POOL_SIZE = 16
CONCURRENCY = (1, 16)
# Concurrency 16 = 8 client processes x 2 asyncio clients (each process with its own pool of 2
# connections: 16 connections in all). One Python event loop driving all 16 clients saturates a
# single core long before either DBMS does (measured: PostgreSQL R1 ~9k ops/s with one loop vs
# ~26k with 8 processes), so the series would measure the client, not the server; 16 processes
# oversubscribe the host instead. client_cpu_cores in measurements.csv records how busy the
# client side was in every series.
CLIENT_PROCS = 8

MEASUREMENT_FIELDS = [
    "dbms", "profile", "durability", "query", "variant", "distribution", "concurrency", "run",
    "method", "batch_size", "n", "samples", "p50_us", "p95_us", "p99_us", "mean_us", "ops_s",
    "failures", "restored", "client_procs", "client_cpu_cores", "effective_concurrency",
    "live_durability", "started_at",
]
# Little's law: mean latency x throughput = how many calls were actually in flight on average.
# Well below `concurrency` means the clients were not all busy for the whole series (fix round 1).
MEDIAN_METRICS = METRICS + ("effective_concurrency", "client_cpu_cores")
MEDIAN_KEY = ["dbms", "profile", "durability", "query", "variant", "distribution", "concurrency"]
MEDIAN_CARRY = ["method", "batch_size", "n", "samples", "client_procs", "live_durability"]

PG_SETTINGS = [
    "server_version", "shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem",
    "random_page_cost", "effective_io_concurrency", "max_wal_size", "synchronous_commit", "fsync",
    "full_page_writes", "wal_level", "wal_sync_method", "max_connections", "jit", "autovacuum",
    "checkpoint_timeout",
]
REDIS_SETTINGS = [
    "maxmemory", "maxmemory-policy", "hash-max-listpack-entries", "hash-max-listpack-value",
    "lazyfree-lazy-eviction", "lazyfree-lazy-expire", "lazyfree-lazy-server-del",
    "lazyfree-lazy-user-del", "lazyfree-lazy-user-flush", "io-threads", "appendonly",
    "appendfsync", "save", "latency-monitor-threshold", "slowlog-log-slower-than",
]


@dataclass
class Sizes:
    runs: int = 3
    warmup: int = 1000
    reads: int = 10_000
    # >= MIN_WARM_PER_CLIENT per client at concurrency 16 (each client warms its own connection)
    write_warmup: int = 160
    writes: int = 1000
    # concurrency 16 write/delete series: long enough (seconds, not tens of ms) that the 16
    # clients overlap for the whole series and CFS-period effects average out (fix round 1)
    writes_c16: int = 10_000
    w2_warmup: int = 10
    w2_ops: int = 20
    w2_size: int = 10_000
    d2_warmup: int = 10
    d2_ops: int = 1000
    d2_size: int = 1000


QUICK = Sizes(runs=1, warmup=160, reads=320, write_warmup=160, writes=50, writes_c16=320,
              w2_warmup=1, w2_ops=2, w2_size=500, d2_warmup=1, d2_ops=10, d2_size=100)


def _is_not_none(result, _args) -> bool:
    return result is not None


def _non_empty(result, _args) -> bool:
    return bool(result)


def _is_set(result, _args) -> bool:
    return isinstance(result, set)


def _is_true(result, _args) -> bool:
    return result is True


def _always(_result, _args) -> bool:
    return True


READ_CHECKS: dict[str, Callable] = {
    "R1": _is_not_none, "R2": _is_not_none, "R3": _non_empty, "R4": _is_not_none,
    "R5": _is_set, "R6": _non_empty,
}


# ---------------------------------------------------------------------------------------------
# Per-DBMS sides
# ---------------------------------------------------------------------------------------------

class PgSide:
    dbms = "pg"

    def __init__(self, prepare_threshold: int | None = PG_PREPARE_THRESHOLD, pool_size: int = POOL_SIZE) -> None:
        self.prepare_threshold = prepare_threshold
        self.pool_size = pool_size
        self.pool: AsyncConnectionPool | None = None

    async def open(self) -> None:
        self.pool = AsyncConnectionPool(
            conninfo="", min_size=self.pool_size, max_size=self.pool_size, open=False,
            kwargs={"autocommit": True, "prepare_threshold": self.prepare_threshold},
        )
        await self.pool.open(wait=True)

    async def close(self) -> None:
        await self.pool.close()

    def acquire(self):
        # Each measured client checks one connection out of the pool for its whole series
        # (warm-up included — see agrobench.measure).
        return self.pool.connection()

    @contextlib.asynccontextmanager
    async def pin(self):
        """One pooled connection for a whole multi-call loop (W2/D2: warm-up calls and every
        measured call run on it; ruling B6) — an `acquire` for measure() that always yields it."""
        async with self.pool.connection() as conn:
            yield lambda: contextlib.nullcontext(conn)

    def reads(self) -> list[tuple[str, str, Callable]]:
        return [
            ("R1", "base", pga.r1_batch_by_id),
            ("R2", "base", pga.r2_batch_by_code),
            ("R3", "base", pga.r3_holder_batches_by_status),
            ("R4", "base", pga.r4_batch_with_holder_and_tests),
            ("R5", "recursive_cte", pga.r5_descendants),
            ("R6", "base", pga.r6_status_counts),
        ]

    def w2_variants(self) -> list[tuple[str, Callable]]:
        return [("copy", pga.w2_insert_batches_copy), ("multirow", pga.w2_insert_batches_multirow)]

    w1 = staticmethod(pga.w1_insert_batch)
    w3 = staticmethod(pga.w3_update_status)
    d1 = staticmethod(pga.d1_delete_batch)
    d2 = staticmethod(pga.d2_delete_tests_due_before)

    @staticmethod
    def fixtures() -> PgFixtures:
        return PgFixtures()


class RedisSide:
    dbms = "redis"

    def __init__(self, pool_size: int = POOL_SIZE) -> None:
        self.pool_size = pool_size
        self.client: aioredis.Redis | None = None

    async def open(self) -> None:
        pool = aioredis.BlockingConnectionPool.from_url(
            os.environ["REDIS_URL"], max_connections=self.pool_size, decode_responses=True,
        )
        self.client = aioredis.Redis(connection_pool=pool)
        # Fill the pool up front (PostgreSQL's pool is opened full too), so no series pays for
        # connection setup.
        conns = [await pool.get_connection("PING") for _ in range(self.pool_size)]
        for c in conns:
            await pool.release(c)

    async def close(self) -> None:
        await self.client.aclose()
        await self.client.connection_pool.disconnect()  # pool was passed in: aclose() leaves it open

    def acquire(self):
        # redis-py checks a pooled connection out per command; clients share the pooled client.
        # BlockingConnectionPool is LIFO, so a lone client keeps reusing the same connection.
        return contextlib.nullcontext(self.client)

    @contextlib.asynccontextmanager
    async def pin(self):
        """Redis counterpart of PgSide.pin: a single-connection client from the same pool, so a
        W2/D2 loop also runs on one connection throughout."""
        client = self.client.client()
        try:
            yield lambda: contextlib.nullcontext(client)
        finally:
            await client.aclose()

    def reads(self) -> list[tuple[str, str, Callable]]:
        return [
            ("R1", "base", ra.r1_batch_by_id),
            ("R2", "base", ra.r2_batch_by_code),
            ("R3", "base", ra.r3_holder_batches_by_status),
            ("R4", "base", ra.r4_batch_with_holder_and_tests),
            ("R5", "bfs_pipeline", ra.r5_descendants),
            ("R5", "lua", ra.r5_descendants_lua),
            ("R6", "base", ra.r6_status_counts),
        ]

    def w2_variants(self) -> list[tuple[str, Callable]]:
        return [("pipeline", ra.w2_insert_batches)]

    w1 = staticmethod(ra.w1_insert_batch)
    w3 = staticmethod(ra.w3_update_status)
    d1 = staticmethod(ra.d1_delete_batch)
    d2 = staticmethod(ra.d2_delete_tests_due_before)

    @staticmethod
    def fixtures() -> RedisFixtures:
        return RedisFixtures()


# ---------------------------------------------------------------------------------------------
# Live settings (Review Focus 4)
# ---------------------------------------------------------------------------------------------

def capture_pg_settings(conn) -> dict[str, str]:
    out = {}
    with conn.cursor() as cur:
        for name in PG_SETTINGS:
            cur.execute(f"SHOW {name}")
            out[name] = cur.fetchone()[0]
    return out


def capture_redis_settings(client) -> dict[str, str]:
    out = {}
    for name in REDIS_SETTINGS:
        out[name] = str(client.config_get(name).get(name, ""))
    out["redis_version"] = client.info("server").get("redis_version", "")
    return out


def verify_settings(dbms: str, live: dict[str, str], profile: str, durability: str) -> dict[str, dict]:
    """Checks every profile-defined setting against its live value; returns {setting: {live,
    expected, matches}} and raises if any differs (the run must not measure a wrong config)."""
    if dbms == "pg":
        expected, equal = config.expected_pg_settings(profile, durability), config.pg_settings_equal
    else:
        expected, equal = config.expected_redis_settings(profile, durability), config.redis_settings_equal
    report = {}
    mismatches = []
    for name, value in live.items():
        entry = {"live": value, "expected": expected.get(name), "matches": None}
        if name in expected:
            entry["matches"] = bool(equal(name, value, expected[name]))
            if not entry["matches"]:
                mismatches.append(f"{name}: live={value!r} expected={expected[name]!r}")
        report[name] = entry
    missing = [n for n in expected if n not in live]
    if mismatches or missing:
        raise RuntimeError(f"{dbms} live settings do not match profile={profile} "
                           f"durability={durability}: {mismatches} missing={missing}")
    return report


def live_durability(dbms: str, live: dict[str, str]) -> str:
    if dbms == "pg":
        return f"synchronous_commit={live['synchronous_commit']};fsync={live['fsync']}"
    return f"appendonly={live['appendonly']};appendfsync={live['appendfsync']}"


# ---------------------------------------------------------------------------------------------
# Concurrency > 1: one series spread over several client processes
# ---------------------------------------------------------------------------------------------

def make_side(dbms: str, prepare_threshold: int | None, pool_size: int):
    if dbms == "pg":
        return PgSide(prepare_threshold=prepare_threshold, pool_size=pool_size)
    return RedisSide(pool_size=pool_size)


def _child_series(dbms, prepare_threshold, tasks, total_concurrency, fn, warm_args, args, check,
                  counter, pipe, barrier) -> None:
    """Client-process body: own pool of `tasks` connections; every client warms its own
    connection (its share of `warm_args`, >= MIN_WARM_PER_CLIENT calls) and measures on that same
    connection; the warm-up samples go to the parent, which picks the method from all processes'
    warm-ups together; measured calls come from the work queue shared by all processes
    (`counter`), started in lockstep via `barrier`."""
    def claim() -> int:
        with counter.get_lock():
            idx = counter.value
            counter.value = idx + 1
        return idx

    def decide(samples: list[float], failures: int) -> str:
        pipe.send(("warm", samples, failures))
        return pipe.recv()

    async def body():
        side = make_side(dbms, prepare_threshold, tasks)
        await side.open()
        try:
            res = await measure(fn, args, acquire=side.acquire, concurrency=tasks, method=None,
                                check=check, warm_args=warm_args,
                                min_warm_per_client=MIN_WARM_PER_CLIENT, decide_method=decide,
                                claim=claim, total_concurrency=total_concurrency,
                                before_start=lambda: barrier.wait(timeout=300))
            res.warmup_latencies_ns = []  # already reported; keep the pickled result small
            pipe.send(("done", res))
        finally:
            await side.close()

    try:
        asyncio.run(body())
    except BaseException:  # noqa: BLE001 — report any failure to the parent, then exit
        import traceback

        pipe.send(("error", traceback.format_exc()))
    finally:
        pipe.close()


def measure_in_processes(side, fn, args_list, warm_args, concurrency: int, check, procs: int) -> SeriesResult:
    """Runs one series at `concurrency` as `procs` client processes x concurrency/procs asyncio
    clients each (spawned fresh). Each process gets every procs-th warm-up call and warms each of
    its own connections with them; all measured calls are handed out from one queue shared by
    every process (a shared counter over the full argument list), so faster clients take more
    work and no process idles while others still have a backlog. Per-process results are merged
    (merge_parallel: all samples, wall time from the first start to the last finish)."""
    procs = min(procs, concurrency)
    if concurrency % procs:
        raise ValueError(f"concurrency {concurrency} not divisible by {procs} client processes")
    tasks = concurrency // procs
    if len(warm_args) < MIN_WARM_PER_CLIENT * concurrency:
        raise ValueError(f"need >= {MIN_WARM_PER_CLIENT * concurrency} warm-up calls for "
                         f"{concurrency} clients, got {len(warm_args)}")
    ctx = mp.get_context("spawn")
    barrier = ctx.Barrier(procs)
    counter = ctx.Value("q", 0)
    args_all = list(args_list)
    children = []
    for i in range(procs):
        parent_end, child_end = ctx.Pipe()
        p = ctx.Process(
            target=_child_series,
            args=(side.dbms, getattr(side, "prepare_threshold", None), tasks, concurrency, fn,
                  list(warm_args[i::procs]), args_all, check, counter, child_end, barrier),
            daemon=True,
        )
        p.start()
        child_end.close()
        children.append((p, parent_end))

    def recv(conn):
        msg = conn.recv()
        if msg[0] == "error":
            for p, _ in children:
                p.terminate()
            raise RuntimeError(f"client process failed:\n{msg[1]}")
        return msg

    try:
        warm_samples: list[float] = []
        for _, conn in children:
            _, samples, failures = recv(conn)
            if failures:
                raise RuntimeError(f"warm-up of {fn.__name__} failed {failures} checks")
            warm_samples += samples
        method = choose_method(warm_samples)
        for _, conn in children:
            conn.send(method)
        parts = [recv(conn)[1] for _, conn in children]
    finally:
        for p, conn in children:
            p.join(timeout=60)
            if p.is_alive():
                p.terminate()
            conn.close()
    merged = merge_parallel(parts)
    if merged.ops != len(args_all):
        raise RuntimeError(f"shared queue lost calls: {merged.ops} of {len(args_all)} executed")
    return merged




# ---------------------------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------------------------

class Runner:
    def __init__(self, dataset: Dataset, sizes: Sizes, results_dir: Path, *, profiles: dict,
                 dbms_list: list[str], log=print, client_procs: int = CLIENT_PROCS) -> None:
        self.client_procs = client_procs
        self.ds = dataset
        self.sizes = sizes
        self.results_dir = results_dir
        self.profiles = profiles
        self.dbms_list = dbms_list
        self.log = log
        self.rows: list[dict] = []
        self.live: dict[str, dict] = {}
        self.diag: RedisDiag | None = None  # set by main() while Redis is being measured

    # -- helpers -------------------------------------------------------------------------------

    def _profile(self, dbms: str) -> str:
        return self.profiles["pg_profile" if dbms == "pg" else "redis_profile"]

    def _row(self, dbms: str, query: str, variant: str, distribution: str, concurrency: int,
             run: int, res: SeriesResult, started_at: str, restored: str = "") -> dict:
        s = res.summary()
        if res.failures:
            raise RuntimeError(f"{dbms} {query}/{variant} {distribution} c={concurrency}: "
                               f"{res.failures} of {res.ops} calls failed their result check")
        row = {
            "dbms": dbms, "profile": self._profile(dbms), "durability": self.profiles["durability"],
            "query": query, "variant": variant, "distribution": distribution,
            "concurrency": concurrency, "run": run, "method": res.method,
            "batch_size": res.batch_size, "n": s.n, "samples": s.samples,
            "p50_us": round(s.p50_us, 3), "p95_us": round(s.p95_us, 3), "p99_us": round(s.p99_us, 3),
            "mean_us": round(s.mean_us, 3), "ops_s": round(s.ops_s, 2), "failures": res.failures,
            "restored": restored, "client_procs": res.client_procs,
            "client_cpu_cores": round(res.client_cpu_cores, 3),
            "effective_concurrency": round(s.mean_us * 1e-6 * s.ops_s, 3),
            "live_durability": live_durability(dbms, self.live[dbms]),
            "started_at": started_at,
        }
        self.rows.append(row)
        self.log(f"  {dbms:5} {query:3} {variant:13} {distribution:8} c={concurrency:<2} run={run} "
                 f"{res.method:7} p50={row['p50_us']:>10.1f}us p99={row['p99_us']:>10.1f}us "
                 f"ops/s={row['ops_s']:>10.1f} cpu={row['client_cpu_cores']:.2f} "
                 f"eff_c={row['effective_concurrency']:.1f}")
        return row

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    # -- reads -----------------------------------------------------------------------------------

    async def read_series(self, side, run: int, query: str, variant: str, fn: Callable,
                          distribution: str, concurrency: int) -> None:
        started = self._now()
        warm = read_args(self.ds, query, distribution, self.sizes.warmup, "warmup")
        args = read_args(self.ds, query, distribution, self.sizes.reads, "measure")
        res = await self._timed(side, fn, args, concurrency, READ_CHECKS[query], warm)
        self._row(side.dbms, query, variant, distribution, concurrency, run, res, started)

    async def _timed(self, side, fn, args_list, concurrency, check, warm_args) -> SeriesResult:
        """Warm-up and measurement on the same connection(s) (ruling B6). Concurrency 1: one
        client in this process holds one pooled connection for its warm-up and the whole series.
        Higher concurrency: spread over client processes, each client warming its own connection
        (measure_in_processes)."""
        if self.diag is not None:
            self.diag.begin()
        try:
            if concurrency > 1 and self.client_procs > 1:
                return measure_in_processes(side, fn, args_list, warm_args, concurrency, check,
                                            self.client_procs)
            res = await measure(fn, args_list, acquire=side.acquire, concurrency=concurrency,
                                method=None, check=check, warm_args=warm_args,
                                min_warm_per_client=MIN_WARM_PER_CLIENT)
            if res.warmup_failures:
                raise RuntimeError(f"warm-up of {fn.__name__} failed {res.warmup_failures} checks")
            return res
        finally:
            if self.diag is not None:
                self.diag.end(f"{side.dbms} {fn.__name__} c={concurrency}")

    # -- writes / deletes --------------------------------------------------------------------------

    def _n_writes(self, concurrency: int) -> int:
        return self.sizes.writes if concurrency == 1 else self.sizes.writes_c16

    async def w1_series(self, side, fx, alloc: Allocator, run: int, concurrency: int) -> None:
        started = self._now()
        warm = prepared_batches(self.ds, alloc, self.sizes.write_warmup, stable_seed("W1w", run, concurrency))
        meas = prepared_batches(self.ds, alloc, self._n_writes(concurrency), stable_seed("W1", run, concurrency))
        with RestoreGuard(fx, Prepared(batches=warm + meas)):
            res = await self._timed(side, side.w1, [(b,) for b in meas], concurrency, _always,
                                    [(b,) for b in warm])
        self._row(side.dbms, "W1", "base", "prepared", concurrency, run, res, started, "verified")

    async def w3_series(self, side, fx, alloc: Allocator, run: int, concurrency: int) -> None:
        started = self._now()
        warm = prepared_batches(self.ds, alloc, self.sizes.write_warmup, stable_seed("W3w", run, concurrency))
        meas = prepared_batches(self.ds, alloc, self._n_writes(concurrency), stable_seed("W3", run, concurrency))
        rng = random.Random(stable_seed("W3-status", run, concurrency))
        to_args = lambda bs: [(b["id"], next_status(b["status"], ALL_STATUSES, rng), 1) for b in bs]  # noqa: E731
        prep = Prepared(batches=warm + meas)
        with RestoreGuard(fx, prep):
            fx.insert(prep)
            res = await self._timed(side, side.w3, to_args(meas), concurrency, _is_true, to_args(warm))
        self._row(side.dbms, "W3", "base", "prepared", concurrency, run, res, started, "verified")

    async def d1_series(self, side, fx, alloc: Allocator, run: int, concurrency: int) -> None:
        started = self._now()
        warm = prepared_copies(self.ds, alloc, self.sizes.write_warmup, stable_seed("D1w", run, concurrency))
        meas = prepared_copies(self.ds, alloc, self._n_writes(concurrency), stable_seed("D1", run, concurrency))
        prep = Prepared()
        prep.batches = warm.batches + meas.batches
        prep.links = warm.links + meas.links
        prep.tests = warm.tests + meas.tests
        with RestoreGuard(fx, prep):
            fx.insert(prep)
            res = await self._timed(side, side.d1, [(b["id"],) for b in meas.batches], concurrency,
                                    _is_true, [(b["id"],) for b in warm.batches])
        self._row(side.dbms, "D1", "base", "prepared", concurrency, run, res, started, "verified")

    async def w2_series(self, side, fx, alloc: Allocator, run: int, variant: str, fn) -> None:
        """Each W2 call inserts a fresh prepared group of w2_size batches; the group is removed
        (and PostgreSQL vacuumed) untimed before the next call, so every call hits the same-sized
        table."""
        started = self._now()
        total = self.sizes.w2_warmup + self.sizes.w2_ops
        groups = [prepared_batches(self.ds, alloc, self.sizes.w2_size, stable_seed("W2", variant, run, i))
                  for i in range(total)]
        parts = []
        with RestoreGuard(fx, Prepared(batches=[b for g in groups for b in g])):
            async with side.pin() as acquire:  # one connection for warm-up and every call (B6)
                for i, group in enumerate(groups):
                    res = await self._one_call(side, fn, (group,), acquire, None)
                    fx.cleanup(Prepared(batches=group))
                    if i >= self.sizes.w2_warmup:
                        parts.append(res)
        self._row(side.dbms, "W2", variant, "prepared", 1, run, merge_sequential(parts), started, "verified")

    async def _one_call(self, side, fn, args: tuple, acquire, check) -> SeriesResult:
        """One timed call of a bulk operation (W2/D2) on the pinned connection, with Redis
        diagnostics collected around it only (not around the untimed fixture work in between)."""
        if self.diag is not None:
            self.diag.begin()
        try:
            return await measure(fn, [args], acquire=acquire, concurrency=1, method="single", check=check)
        finally:
            if self.diag is not None:
                self.diag.end(f"{side.dbms} {fn.__name__}")

    async def d2_series(self, side, fx, alloc: Allocator, run: int) -> None:
        """Each D2 call deletes exactly one freshly inserted (untimed) group of d2_size lab tests,
        all due before every generated test, so the main set is never touched."""
        started = self._now()
        size = self.sizes.d2_size
        check = lambda result, _args: result == size  # noqa: E731
        prep = Prepared()
        parts = []
        with RestoreGuard(fx, prep):
            async with side.pin() as acquire:  # one connection for warm-up and every call (B6)
                for i in range(self.sizes.d2_warmup + self.sizes.d2_ops):
                    tests, cutoff = prepared_due_group(self.ds, alloc, size, stable_seed("D2", run, i))
                    prep.extra_test_ids.extend(t["id"] for t in tests)
                    fx.insert(Prepared(tests=tests))
                    res = await self._one_call(side, side.d2, (cutoff,), acquire, check)
                    if res.failures:
                        raise RuntimeError(f"{side.dbms} D2 call {i} did not delete exactly {size} tests")
                    if i >= self.sizes.d2_warmup:
                        parts.append(res)
        self._row(side.dbms, "D2", "base", "prepared", 1, run, merge_sequential(parts), started, "verified")

    # -- orchestration ---------------------------------------------------------------------------

    async def run_dbms(self, dbms: str, run: int, only: set[str] | None) -> None:
        side = PgSide() if dbms == "pg" else RedisSide()
        fx = side.fixtures()
        alloc = Allocator(self.ds)  # fresh per (dbms, run): both DBMS get identical prepared ids
        await side.open()
        def want(q: str) -> bool:
            return only is None or q in only

        try:
            for query, variant, fn in side.reads():
                if not want(query):
                    continue
                for distribution in DISTRIBUTIONS:
                    for concurrency in CONCURRENCY:
                        await self.read_series(side, run, query, variant, fn, distribution, concurrency)
            if dbms == "pg" and (only is None or only & set(READ_QUERIES)):
                # Client-side ablation for the report (spec §13.6 lists prepared statements among
                # PostgreSQL's optimisations): the same reads with server-side prepare disabled.
                unprepared = PgSide(prepare_threshold=None)
                await unprepared.open()
                try:
                    for query, _variant, fn in unprepared.reads():
                        if want(query):
                            await self.read_series(unprepared, run, query, "unprepared", fn, "uniform", 1)
                finally:
                    await unprepared.close()
            for concurrency in CONCURRENCY:
                if want("W1"):
                    await self.w1_series(side, fx, alloc, run, concurrency)
                if want("W3"):
                    await self.w3_series(side, fx, alloc, run, concurrency)
                if want("D1"):
                    await self.d1_series(side, fx, alloc, run, concurrency)
            if want("W2"):
                for variant, fn in side.w2_variants():
                    await self.w2_series(side, fx, alloc, run, variant, fn)
            if want("D2"):
                await self.d2_series(side, fx, alloc, run)
        finally:
            await side.close()
            fx.close()


# ---------------------------------------------------------------------------------------------
# Diagnostics: EXPLAIN plans, Redis SLOWLOG/LATENCY, load/memory
# ---------------------------------------------------------------------------------------------

def descendant_counts(ds: Dataset, max_depth: int = 20) -> dict[int, int]:
    """Number of distinct descendants within max_depth levels (R5's result size) of every batch,
    by BFS over the generated edges — picks representative R5 keys for the EXPLAIN plans."""
    children: dict[int, list[int]] = {}
    for link in ds.batch_links:
        children.setdefault(int(link["parent_id"]), []).append(int(link["child_id"]))
    out = {}
    for b in ds.batch_ids():
        seen, frontier, depth = {b}, [b], 0
        while frontier and depth < max_depth:
            nxt = []
            for p in frontier:
                for c in children.get(p, ()):
                    if c not in seen:
                        seen.add(c)
                        nxt.append(c)
            frontier, depth = nxt, depth + 1
        out[b] = len(seen) - 1
    return out


def _explain_targets(ds: Dataset) -> dict[str, tuple[str, tuple, str]]:
    from agrobench.queries import pg as pgq

    by_pair: dict[tuple, int] = {}
    by_holder: dict[int, int] = {}
    for b in ds.batches:
        pair = (int(b["holder_org_id"]), b["status"])
        by_pair[pair] = by_pair.get(pair, 0) + 1
        by_holder[pair[0]] = by_holder.get(pair[0], 0) + 1
    reach = descendant_counts(ds)
    with_desc = sorted((n, b) for b, n in reach.items() if n > 0)
    r3_pair = max(sorted(by_pair), key=lambda p: by_pair[p])
    r4_batch = max(sorted(ds.tests_of), key=lambda b: len(ds.tests_of[b]))
    r5_max = with_desc[-1][1]
    r5_median = with_desc[len(with_desc) // 2][1]
    r6_holder = max(sorted(by_holder), key=lambda h: by_holder[h])
    d2_cutoff = ds.min_due_at() + timedelta(days=90)
    return {
        "R3": (pgq.R3_SQL, (r3_pair[0], r3_pair[1], 50),
               f"holder={r3_pair[0]} status={r3_pair[1]} (the pair with most batches: {by_pair[r3_pair]})"),
        "R4": (pgq.R4_SQL, (r4_batch,), f"batch={r4_batch} (most lab tests: {len(ds.tests_of[r4_batch])})"),
        "R5_max": (pgq.R5_SQL, (r5_max, 20),
                   f"batch={r5_max} (largest descendant set: {reach[r5_max]}), max_depth=20"),
        "R5_median": (pgq.R5_SQL, (r5_median, 20),
                      f"batch={r5_median} (median descendant set among batches that have any: "
                      f"{reach[r5_median]}), max_depth=20"),
        "R6": (pgq.R6_SQL, (r6_holder,), f"holder={r6_holder} (most batches: {by_holder[r6_holder]})"),
        "D1": (pgq.D1_SQL, (r4_batch,) * 4, f"batch={r4_batch} (rolled back)"),
        "D2": (pgq.D2_SQL, (d2_cutoff,), f"due_before={d2_cutoff.isoformat()} (rolled back)"),
    }


def write_explain_plans(ds: Dataset, out_dir: Path, profile: str, durability: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with psycopg.connect(autocommit=False) as conn:
        for query, (sql, params, label) in _explain_targets(ds).items():
            with conn.cursor() as cur:
                cur.execute("EXPLAIN (ANALYZE, BUFFERS) " + sql, params)
                plan = "\n".join(r[0] for r in cur.fetchall())
            conn.rollback()  # D1/D2 really execute under ANALYZE: never keep their effect
            header = (f"-- {query} EXPLAIN (ANALYZE, BUFFERS), PostgreSQL profile={profile} "
                      f"durability={durability}\n-- parameters: {label}\n")
            (out_dir / f"pg_{profile}_{durability}_{query}.txt").write_text(
                header + "\n".join(line.rstrip() for line in sql.strip().splitlines()) + "\n\n" + plan + "\n",
                encoding="utf-8")




# Harness bookkeeping, not workload: diagnostics itself, connection handshakes, and SCRIPT LOAD
# (the fixtures' script cache warm-up; the measured Lua calls show up as evalsha).
REDIS_DIAG_IGNORED = ("slowlog", "latency", "config", "info", "client", "hello", "ping", "debug", "script")


class RedisDiag:
    """Redis SLOWLOG / LATENCY / commandstats restricted to the measured calls (ruling B6): reset
    right before each measured part (warm-up + series, or one W2/D2 call), read right after it,
    and accumulated per run — so fixture traffic (prepared inserts, cleanup, the DEBUG DIGEST
    restore check) never appears. Note: a window covers the series' warm-up calls too (they run
    inside measure(), on the same connections, right before the timed calls), so commandstats
    counts include them — same workload commands, roughly +10% calls for reads. The harness's own bookkeeping commands (and connection
    handshakes) are dropped from commandstats."""

    def __init__(self, client) -> None:
        self.r = client
        self.windows = 0
        self.slow: list[tuple[str, dict]] = []
        self.latency: list[tuple[str, list]] = []
        self.cmdstats: dict[str, dict[str, int]] = {}

    def begin(self) -> None:
        self.r.slowlog_reset()
        self.r.execute_command("LATENCY", "RESET")
        self.r.config_resetstat()

    def end(self, label: str) -> None:
        self.windows += 1
        for entry in self.r.slowlog_get(128):
            self.slow.append((label, entry))
        for event in self.r.execute_command("LATENCY", "LATEST") or []:
            self.latency.append((label, list(event)))
        for name, stats in self.r.info("commandstats").items():
            cmd = name.removeprefix("cmdstat_")
            if cmd.split("|")[0] in REDIS_DIAG_IGNORED:
                continue
            acc = self.cmdstats.setdefault(cmd, {"calls": 0, "usec": 0})
            acc["calls"] += int(stats.get("calls", 0))
            acc["usec"] += int(stats.get("usec", 0))

    def write(self, path: Path, header: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        threshold = self.r.config_get("slowlog-log-slower-than")["slowlog-log-slower-than"]
        lines = [header, f"# measured windows: {self.windows} (diagnostics reset before and read after each)", ""]
        lines.append(f"# SLOWLOG entries during measured calls (slowlog-log-slower-than={threshold} us): {len(self.slow)}")
        for label, entry in sorted(self.slow, key=lambda x: -int(x[1].get("duration", 0)))[:32]:
            cmd = entry.get("command")
            if isinstance(cmd, bytes):
                cmd = cmd.decode(errors="replace")
            lines.append(f"[{label}] duration_us={entry.get('duration')} command={str(cmd)[:160]}")
        lines.append(f"# LATENCY events during measured calls (threshold 1 ms), per series and event: "
                     f"windows with the event, max_ms ({len(self.latency)} readings)")
        agg: dict[tuple[str, str], list[int]] = {}
        for label, event in self.latency:
            slot = agg.setdefault((label, str(event[0])), [0, 0])
            slot[0] += 1
            slot[1] = max(slot[1], int(event[3]))
        for (label, name), (count, max_ms) in sorted(agg.items()):
            lines.append(f"[{label}] {name}: windows={count} max_ms={max_ms}")
        lines.append("# commandstats summed over measured calls (server-side time per command)")
        for name, acc in sorted(self.cmdstats.items()):
            per = acc["usec"] / acc["calls"] if acc["calls"] else 0.0
            lines.append(f"{name}: calls={acc['calls']} usec={acc['usec']} usec_per_call={per:.2f}")
        lines.append("# INFO persistence (end of run)")
        for k, v in self.r.info("persistence").items():
            lines.append(f"{k}: {v}")
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _read_load_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def capture_load_and_memory(results_dir: Path, profiles: dict) -> dict:
    """Load time + size as the loaders recorded them (refusing a load made under another
    configuration) plus live size/memory right before measuring."""
    out: dict[str, Any] = {"profiles": profiles}
    for name in ("load_pg", "load_redis"):
        meta_path = results_dir / f"{name}.meta.json"
        if not meta_path.exists():
            raise RuntimeError(f"{meta_path} missing — run ./at.sh bench load first")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        for k in ("pg_profile", "redis_profile", "durability"):
            if meta.get(k) != profiles[k]:
                raise RuntimeError(f"{name}: data was loaded under {meta}, but the stand is {profiles} "
                                   "— run ./at.sh bench load for this configuration first")
        out[name] = {"meta": meta, "rows": _read_load_csv(results_dir / f"{name}.csv")}
    with psycopg.connect() as conn, conn.cursor() as cur:
        pg_live = {}
        for table in ("organizations", "batches", "batch_links", "lab_tests"):
            cur.execute("SELECT pg_total_relation_size(%s), pg_relation_size(%s), pg_indexes_size(%s)",
                        (table, table, table))
            total, heap, idx = cur.fetchone()
            pg_live[table] = {"total_bytes": total, "table_bytes": heap, "indexes_bytes": idx}
        cur.execute("SELECT pg_database_size(current_database())")
        pg_live["__database__"] = {"total_bytes": cur.fetchone()[0]}
    out["pg_live"] = pg_live
    r = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    info = r.info("memory")
    out["redis_live"] = {
        k: info.get(k) for k in ("used_memory", "used_memory_dataset", "used_memory_rss",
                                 "used_memory_overhead", "mem_fragmentation_ratio")
    }
    out["redis_live"]["dbsize"] = r.dbsize()
    r.close()
    return out


# ---------------------------------------------------------------------------------------------
# Consolidation
# ---------------------------------------------------------------------------------------------

def _write_csv(path: Path, fields: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def _read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def median_rows(rows: list[dict]) -> list[dict]:
    medians = median_of_runs(rows, MEDIAN_KEY, MEDIAN_METRICS)
    carry: dict[tuple, dict[str, list]] = {}
    for row in rows:
        key = tuple(row[k] for k in MEDIAN_KEY)
        slot = carry.setdefault(key, {c: [] for c in MEDIAN_CARRY})
        for c in MEDIAN_CARRY:
            if str(row[c]) not in slot[c]:
                slot[c].append(str(row[c]))
    for m in medians:
        key = tuple(m[k] for k in MEDIAN_KEY)
        for c in MEDIAN_CARRY:
            m[c] = "/".join(carry[key][c])
        for metric in MEDIAN_METRICS + ("p50_us_min", "p50_us_max"):
            m[metric] = round(float(m[metric]), 3)
    return medians


def consolidate(results_dir: Path) -> None:
    raw = sorted((results_dir / "raw").glob("measurements_*.csv"))
    rows = [r for p in raw for r in _read_csv(p)]
    _write_csv(results_dir / "measurements.csv", MEASUREMENT_FIELDS, rows)
    _write_csv(results_dir / "measurements_median.csv",
               MEDIAN_KEY + list(MEDIAN_METRICS) + ["runs", "p50_us_min", "p50_us_max"] + MEDIAN_CARRY,
               median_rows(rows))

    load_rows, memory_rows = [], []
    for p in sorted((results_dir / "load").glob("*.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        pr = d["profiles"]
        pg_base = {"dbms": "pg", "profile": pr["pg_profile"], "durability": pr["durability"]}
        rd_base = {"dbms": "redis", "profile": pr["redis_profile"], "durability": pr["durability"]}
        pg_total = 0.0
        for r in d["load_pg"]["rows"]:
            if r["table"] == "__indexes_and_analyze__":
                load_rows.append({**pg_base, "phase": "indexes_and_analyze", "seconds": r["copy_seconds"]})
            else:
                load_rows.append({**pg_base, "phase": f"copy_{r['table']}", "seconds": r["copy_seconds"]})
                memory_rows.append({**pg_base, "object": r["table"], "metric": "total_relation_size_bytes",
                                    "value": r["total_relation_size_bytes"]})
            pg_total += float(r["copy_seconds"])
        load_rows.append({**pg_base, "phase": "total", "seconds": f"{pg_total:.6f}"})
        for table, sizes in d["pg_live"].items():
            for metric, value in sizes.items():
                if table != "__database__" and metric == "total_bytes":
                    continue  # same number as total_relation_size_bytes above
                memory_rows.append({**pg_base, "object": table, "metric": metric, "value": value})
        for r in d["load_redis"]["rows"]:
            if r["key_type"] == "__load_seconds__":
                load_rows.append({**rd_base, "phase": "total", "seconds": r["count"]})
            elif r["key_type"] == "__used_memory_bytes__":
                memory_rows.append({**rd_base, "object": "__instance__", "metric": "used_memory_after_load",
                                    "value": r["count"]})
            else:
                memory_rows.append({**rd_base, "object": r["key_type"], "metric": "key_count", "value": r["count"]})
                memory_rows.append({**rd_base, "object": r["key_type"], "metric": "avg_bytes", "value": r["avg_bytes"]})
                memory_rows.append({**rd_base, "object": r["key_type"], "metric": "extrapolated_bytes",
                                    "value": r["extrapolated_bytes"]})
        for metric, value in d["redis_live"].items():
            memory_rows.append({**rd_base, "object": "__instance__", "metric": metric, "value": value})
    _write_csv(results_dir / "load.csv", ["dbms", "profile", "durability", "phase", "seconds"], load_rows)
    _write_csv(results_dir / "memory.csv", ["dbms", "profile", "durability", "object", "metric", "value"],
               memory_rows)

    settings_rows = []
    for p in sorted((results_dir / "settings").glob("*.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        for name, entry in d["settings"].items():
            settings_rows.append({
                "dbms": d["dbms"], "profile": d["profile"], "durability": d["durability"],
                "setting": name, "live": entry["live"],
                "expected": "" if entry["expected"] is None else entry["expected"],
                "matches": "" if entry["matches"] is None else str(entry["matches"]).lower(),
            })
    _write_csv(results_dir / "settings.csv",
               ["dbms", "profile", "durability", "setting", "live", "expected", "matches"], settings_rows)


# ---------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=None, help="repetitions (default 3)")
    parser.add_argument("--dbms", default="pg,redis", help="comma list: pg,redis")
    parser.add_argument("--only", default="", help="comma list of queries (R1..R6,W1,W2,W3,D1,D2)")
    parser.add_argument("--client-procs", type=int, default=CLIENT_PROCS,
                        help=f"client processes for concurrency 16 (default {CLIENT_PROCS}; 1 = one event loop)")
    parser.add_argument("--quick", action="store_true", help="tiny sizes, 1 run (smoke test only)")
    parser.add_argument("--scratch", action="store_true", help="full sizes, but record only results/scratch/ (experiments)")
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("DATA_DIR", str(config.BENCH_DIR / "data"))))
    parser.add_argument("--results-dir", type=Path, default=Path(os.environ.get("RESULTS_DIR", str(config.BENCH_DIR / "results"))))
    args = parser.parse_args(argv)

    sizes = QUICK if args.quick else Sizes()
    # Scratch runs (--quick or --scratch) record nothing but their own CSV under results/scratch/:
    # no settings/load/plans/diagnostics, never part of the consolidated result set.
    scratch = args.quick or args.scratch
    if args.runs is not None:
        sizes.runs = args.runs
    dbms_list = [d for d in args.dbms.split(",") if d]
    only = {q.strip() for q in args.only.split(",") if q.strip()} or None
    profiles = config.current_profiles()
    results_dir: Path = args.results_dir
    tag = f"{profiles['pg_profile']}_{profiles['durability']}" if profiles["pg_profile"] == profiles["redis_profile"] \
        else f"pg-{profiles['pg_profile']}_redis-{profiles['redis_profile']}_{profiles['durability']}"
    t0 = time.monotonic()

    dataset = load_dataset(args.data_dir)
    print(f"bench run: profiles={profiles} sizes={sizes} dbms={dbms_list} only={only or 'all'}", flush=True)

    # Live settings first — a wrong configuration must never be measured (Review Focus 4).
    runner = Runner(dataset, sizes, results_dir, profiles=profiles, dbms_list=dbms_list,
                    log=lambda m: print(m, flush=True), client_procs=args.client_procs)
    with psycopg.connect() as conn:
        pg_live = capture_pg_settings(conn)
    rcli = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    redis_live = capture_redis_settings(rcli)
    runner.live = {"pg": pg_live, "redis": redis_live}
    for dbms, live in runner.live.items():
        prof = profiles["pg_profile" if dbms == "pg" else "redis_profile"]
        report = verify_settings(dbms, live, prof, profiles["durability"])
        report["client.connections_at_concurrency_16"] = {"live": str(POOL_SIZE), "expected": None, "matches": None}
        report["client.processes_at_concurrency_16"] = {"live": str(args.client_procs), "expected": None, "matches": None}
        if dbms == "pg":
            report["client.prepare_threshold"] = {"live": str(PG_PREPARE_THRESHOLD), "expected": None, "matches": None}
        if not scratch:
            path = results_dir / "settings" / f"{dbms}_{prof}_{profiles['durability']}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"dbms": dbms, "profile": prof, "durability": profiles["durability"],
                                        "captured_at": Runner._now(), "settings": report},
                                       indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if not scratch:
        load_info = capture_load_and_memory(results_dir, profiles)
        (results_dir / "load").mkdir(parents=True, exist_ok=True)
        (results_dir / "load" / f"{tag}.json").write_text(json.dumps(load_info, indent=2, default=str) + "\n",
                                                          encoding="utf-8")
        if "pg" in dbms_list:
            write_explain_plans(dataset, results_dir / "plans", profiles["pg_profile"], profiles["durability"])

    for run in range(1, sizes.runs + 1):
        for dbms in dbms_list:
            print(f"== run {run}/{sizes.runs}: {dbms}", flush=True)
            runner.diag = RedisDiag(rcli) if dbms == "redis" else None
            asyncio.run(runner.run_dbms(dbms, run, only))
            if dbms == "redis" and not scratch:
                runner.diag.write(
                    results_dir / "redis" / f"redis_{profiles['redis_profile']}_{profiles['durability']}_run{run}.txt",
                    f"# Redis diagnostics after run {run}: profile={profiles['redis_profile']} "
                    f"durability={profiles['durability']} ({Runner._now()})")
    rcli.close()

    # Scratch output goes to its own directory so it can never leak into the consolidated set.
    out = results_dir / ("scratch" if scratch else "raw") / f"measurements_{tag}.csv"
    _write_csv(out, MEASUREMENT_FIELDS, runner.rows)
    if not scratch:
        consolidate(results_dir)
    print(f"bench run: {len(runner.rows)} series -> {out} in {time.monotonic() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
