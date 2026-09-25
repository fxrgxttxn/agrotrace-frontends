"""Timing core of the measurement harness (spec §13.6): `time.perf_counter_ns` around each logical
call, closed-loop asyncio clients (concurrency 1 or 16), and the "fast operations are timed in
batches of 1000 and divided" rule.

Warm-up and connection affinity (fix round 1, ruling B6): every client acquires its connection
once and runs *its own* warm-up calls on it before the series starts, then measures on that same
connection — so on PostgreSQL the measured connection is exactly the one whose backend is warm
and whose statements are already server-side prepared (psycopg prepares from the 5th execution;
MIN_WARM_PER_CLIENT = 2 x that). A series never measures on a connection the warm-up did not use.

Method selection is objective and recorded per series (`method` column of measurements.csv): the
warm-up calls are timed one by one, and if their p50 (over every client's warm-up) is below
FAST_P50_NS (50 µs) the series is measured `batched` — the clock is read once per batch of
consecutive calls of one client and the batch time divided by the number of calls, so
timer/bookkeeping overhead cannot dominate a sub-50-µs call — otherwise `single` (one sample per
call). Percentiles of a batched series are therefore over per-batch averages (column `samples`
says how many); the mean and ops/s are exact either way.

Both DBMS go through exactly this code with the same call shape (`await op(conn, *args)`), so the
client-side overhead (Python, asyncio, driver) is the same kind for both (Global Constraints). At
concurrency 16 one series is spread over several client processes (agrobench.run.
measure_in_processes): each process runs `measure` with a `claim` callback that hands out work
units from one queue shared by all processes, the method is decided from all processes' warm-ups
(`decide_method`), and all processes start together (`before_start`, a barrier); the parts are
combined with `merge_parallel`. `client_cpu_ns` records how much CPU the client side burnt, so a
client-bound series is visible as such. Python's cyclic GC is paused during a timed series so a
collection pause lands in neither DBMS's numbers; it is collected before and re-enabled after.
"""
from __future__ import annotations

import asyncio
import gc
import math
import time
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Sequence

from agrobench.stats import Summary, percentile, summarize

FAST_P50_NS = 50_000
BATCH_SIZE = 1000
# psycopg prepares a statement server-side from its 5th execution on a connection; every client
# warms its own connection at least twice that (ruling B6).
PG_PREPARE_THRESHOLD = 5
MIN_WARM_PER_CLIENT = 2 * PG_PREPARE_THRESHOLD

Op = Callable[..., Awaitable[Any]]
Check = Callable[[Any, tuple], bool]
Acquire = Callable[[], AbstractAsyncContextManager]


@dataclass
class SeriesResult:
    method: str
    batch_size: int          # 1 for single; calls per timed batch for batched
    concurrency: int
    ops: int                 # measured calls actually executed
    elapsed_ns: int
    failures: int
    latencies_ns: list[float] = field(default_factory=list)
    weights: list[int] = field(default_factory=list)
    t_start_ns: int = 0      # absolute clock readings (CLOCK_MONOTONIC: comparable across processes)
    t_end_ns: int = 0
    client_cpu_ns: int = 0   # CPU time the client process(es) spent during the timed series
    client_procs: int = 1
    warmup_latencies_ns: list[float] = field(default_factory=list)
    warmup_failures: int = 0

    @property
    def client_cpu_cores(self) -> float:
        """Client CPU time over wall time: ~1.0 per process means the Python client itself, not
        the DBMS, is what limits the series (recorded so client saturation is visible)."""
        return self.client_cpu_ns / self.elapsed_ns if self.elapsed_ns else 0.0

    def summary(self) -> Summary:
        return summarize(self.latencies_ns, ops=self.ops, elapsed_ns=self.elapsed_ns,
                         weights=self.weights)


def choose_method(warmup_latencies_ns: Sequence[float], threshold_ns: int = FAST_P50_NS) -> str:
    """'batched' if the per-call warm-up p50 is under the threshold, else 'single'."""
    return "batched" if percentile(warmup_latencies_ns, 50) < threshold_ns else "single"


def batch_size_for(n: int, concurrency: int, batch_size: int = BATCH_SIZE) -> int:
    """Calls per timed batch: BATCH_SIZE, but never more than one client's fair share of the series
    (10 000 calls over 16 clients -> 625), so every client times at least one full batch."""
    return max(1, min(batch_size, math.ceil(n / concurrency)))


async def measure(
    op: Op,
    args_list: Sequence[tuple],
    *,
    acquire: Acquire,
    concurrency: int = 1,
    method: str | None = "single",
    batch_size: int = BATCH_SIZE,
    check: Check | None = None,
    clock: Callable[[], int] = time.perf_counter_ns,
    before_start: Callable[[], None] | None = None,
    warm_args: Sequence[tuple] = (),
    min_warm_per_client: int = 0,
    decide_method: Callable[[list[float], int], str] | None = None,
    claim: Callable[[], int | None] | None = None,
    total_concurrency: int | None = None,
) -> SeriesResult:
    """Runs `op(conn, *args)` for the tuples in `args_list` across `concurrency` asyncio clients
    and returns the timing samples.

    Each client acquires its handle once (`acquire()` — a pooled PostgreSQL connection held for
    the whole series, or the shared pooled Redis client), runs its share of `warm_args`
    (`warm_args[i::concurrency]`, timed per call, at least `min_warm_per_client` of them) on it,
    and waits. Once every client is warm the method is fixed — `method` if given, else
    `decide_method(warm samples, warm failures)` (default: choose_method on the warm samples) —
    `before_start()` runs, and all clients start together; the series wall time runs from that
    common start to the last client's finish. Work units (one call, or one batch of calls) are
    handed out by `claim()` (default: a queue local to this call; agrobench.run passes one shared
    by all client processes) — closed loop, a client takes its next unit as soon as the previous
    one returns. `total_concurrency` (default `concurrency`) sizes batches when several
    processes share the queue. `check(result, args)` runs outside the timed region; False counts
    as a failure.
    """
    if method not in ("single", "batched", None):
        raise ValueError(f"unknown method {method!r}")
    if concurrency < 1:
        raise ValueError("concurrency must be >= 1")
    n = len(args_list)
    if n == 0:
        raise ValueError("empty workload")
    if min_warm_per_client and len(warm_args) < min_warm_per_client * concurrency:
        raise ValueError(f"need >= {min_warm_per_client} warm-up calls per client: "
                         f"{len(warm_args)} for {concurrency} clients")

    state: dict[str, Any] = {"method": method, "units": None}
    next_local = 0

    def local_claim() -> int:
        nonlocal next_local
        idx = next_local
        next_local += 1
        return idx

    take = claim or local_claim

    latencies: list[float] = []
    weights: list[int] = []
    warm_lat: list[float] = []
    failures = 0
    warm_failures = 0
    ops_done = 0
    ready = 0
    all_ready = asyncio.Event()
    start = asyncio.Event()

    async def client(idx: int) -> None:
        nonlocal failures, warm_failures, ready, ops_done
        async with acquire() as conn:
            for args in warm_args[idx::concurrency]:
                t0 = clock()
                result = await op(conn, *args)
                t1 = clock()
                warm_lat.append(float(t1 - t0))
                if check is not None and not check(result, args):
                    warm_failures += 1
            ready += 1
            if ready == concurrency:
                all_ready.set()
            await start.wait()
            units = state["units"]
            single = state["method"] == "single"
            while (u := take()) is not None and u < len(units):
                chunk = units[u]
                if single:
                    args = chunk[0]
                    t0 = clock()
                    result = await op(conn, *args)
                    t1 = clock()
                    latencies.append(float(t1 - t0))
                    weights.append(1)
                    ops_done += 1
                    if check is not None and not check(result, args):
                        failures += 1
                else:
                    results = []
                    t0 = clock()
                    for args in chunk:
                        results.append(await op(conn, *args))
                    t1 = clock()
                    latencies.append((t1 - t0) / len(chunk))
                    weights.append(len(chunk))
                    ops_done += len(chunk)
                    if check is not None:
                        failures += sum(1 for r, a in zip(results, chunk) if not check(r, a))

    gc.collect()
    gc_was_enabled = gc.isenabled()
    gc.disable()
    try:
        tasks = [asyncio.create_task(client(i)) for i in range(concurrency)]
        ready_waiter = asyncio.create_task(all_ready.wait())
        await asyncio.wait({ready_waiter, *tasks}, return_when=asyncio.FIRST_COMPLETED)
        if not all_ready.is_set():  # a client failed before the start line (e.g. acquire error)
            ready_waiter.cancel()
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for t in tasks:
                if not t.cancelled() and t.exception() is not None:
                    raise t.exception()
            raise RuntimeError("measurement clients exited before starting")
        if state["method"] is None:
            if decide_method is not None:
                state["method"] = decide_method(list(warm_lat), warm_failures)
            else:
                if not warm_lat:
                    raise ValueError("method=None needs warm-up calls to decide from")
                state["method"] = choose_method(warm_lat)
        unit = 1 if state["method"] == "single" else batch_size_for(n, total_concurrency or concurrency, batch_size)
        state["units"] = [args_list[i:i + unit] for i in range(0, n, unit)]
        if before_start is not None:
            before_start()
        cpu0 = time.process_time_ns()
        t_start = clock()
        start.set()
        await asyncio.gather(*tasks)
        t_end = clock()
        cpu1 = time.process_time_ns()
    finally:
        if gc_was_enabled:
            gc.enable()

    return SeriesResult(
        method=state["method"],
        batch_size=unit,
        concurrency=concurrency,
        ops=ops_done,
        elapsed_ns=t_end - t_start,
        failures=failures,
        latencies_ns=latencies,
        weights=weights,
        t_start_ns=t_start,
        t_end_ns=t_end,
        client_cpu_ns=cpu1 - cpu0,
        warmup_latencies_ns=warm_lat,
        warmup_failures=warm_failures,
    )


def merge_parallel(parts: Sequence[SeriesResult]) -> SeriesResult:
    """One series measured by several client processes at once -> one result: all samples, all
    calls, wall time from the earliest start to the latest finish, client CPU summed."""
    if not parts:
        raise ValueError("nothing to merge")
    methods = {p.method for p in parts}
    if len(methods) != 1:
        raise ValueError(f"parts measured with different methods: {methods}")
    return SeriesResult(
        method=parts[0].method,
        batch_size=max(p.batch_size for p in parts),
        concurrency=sum(p.concurrency for p in parts),
        ops=sum(p.ops for p in parts),
        elapsed_ns=max(p.t_end_ns for p in parts) - min(p.t_start_ns for p in parts),
        failures=sum(p.failures for p in parts),
        latencies_ns=[x for p in parts for x in p.latencies_ns],
        weights=[w for p in parts for w in p.weights],
        t_start_ns=min(p.t_start_ns for p in parts),
        t_end_ns=max(p.t_end_ns for p in parts),
        client_cpu_ns=sum(p.client_cpu_ns for p in parts),
        client_procs=sum(p.client_procs for p in parts),
        warmup_latencies_ns=[x for p in parts for x in p.warmup_latencies_ns],
        warmup_failures=sum(p.warmup_failures for p in parts),
    )


def merge_sequential(parts: Sequence[SeriesResult]) -> SeriesResult:
    """Calls measured one after another (W2/D2: one call per measure(), untimed fixture work in
    between) -> one result whose wall time is the sum of the timed parts only."""
    if not parts:
        raise ValueError("nothing to merge")
    return SeriesResult(
        method=parts[0].method,
        batch_size=parts[0].batch_size,
        concurrency=parts[0].concurrency,
        ops=sum(p.ops for p in parts),
        elapsed_ns=sum(p.elapsed_ns for p in parts),
        failures=sum(p.failures for p in parts),
        latencies_ns=[x for p in parts for x in p.latencies_ns],
        weights=[w for p in parts for w in p.weights],
        t_start_ns=parts[0].t_start_ns,
        t_end_ns=parts[-1].t_end_ns,
        client_cpu_ns=sum(p.client_cpu_ns for p in parts),
    )
