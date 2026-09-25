"""Timing core of the measurement harness (spec §13.6): `time.perf_counter_ns` around each logical
call, closed-loop asyncio clients (concurrency 1 or 16), and the "fast operations are timed in
batches of 1000 and divided" rule.

Method selection is objective and recorded per series (`method` column of measurements.csv): the
warm-up of every series is timed per call, and if its p50 is below FAST_P50_NS (50 µs) the series
is measured `batched` — the clock is read once per batch of BATCH_SIZE consecutive calls of one
client and the batch time divided by the number of calls, so timer/bookkeeping overhead cannot
dominate a sub-50-µs call — otherwise `single` (one sample per call). Percentiles of a batched
series are therefore over per-batch averages (column `samples` says how many); the mean and ops/s
are exact either way.

Both DBMS go through exactly this code with the same call shape (`await op(conn, *args)`), so the
client-side overhead (Python, asyncio, driver) is the same kind for both (Global Constraints).
At concurrency 16 one series is spread over several client processes (agrobench.run.
measure_in_processes: each runs `measure` for its share, started together through a barrier)
and the parts are combined with `merge_parallel`; `client_cpu_ns` records how much CPU the client
side burnt, so a client-bound series is visible as such.
Python's cyclic GC is paused during a timed series so a collection pause lands in neither DBMS's
numbers; it is collected before and re-enabled after.
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

Op = Callable[..., Awaitable[Any]]
Check = Callable[[Any, tuple], bool]
Acquire = Callable[[], AbstractAsyncContextManager]


@dataclass
class SeriesResult:
    method: str
    batch_size: int          # 1 for single; calls per timed batch for batched
    concurrency: int
    ops: int
    elapsed_ns: int
    failures: int
    latencies_ns: list[float] = field(default_factory=list)
    weights: list[int] = field(default_factory=list)
    t_start_ns: int = 0      # absolute clock readings (CLOCK_MONOTONIC: comparable across processes)
    t_end_ns: int = 0
    client_cpu_ns: int = 0   # CPU time the client process(es) spent during the timed series
    client_procs: int = 1

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
    method: str = "single",
    batch_size: int = BATCH_SIZE,
    check: Check | None = None,
    clock: Callable[[], int] = time.perf_counter_ns,
    before_start: Callable[[], None] | None = None,
) -> SeriesResult:
    """Runs `op(conn, *args)` once for every tuple in `args_list` across `concurrency` asyncio
    clients and returns the timing samples.

    Each client first acquires its handle (`acquire()` — a pooled PostgreSQL connection held for
    the whole series, or the shared pooled Redis client), then all clients start together; the
    series wall time runs from that common start to the last client's finish. Work is handed out
    from one shared queue (closed loop: a client issues its next call as soon as its previous one
    returns). `check(result, args)` runs outside the timed region; False counts as a failure.
    `before_start()` runs once every client holds its connection, right before the start line
    (a cross-process barrier when one series is spread over several client processes).
    """
    if method not in ("single", "batched"):
        raise ValueError(f"unknown method {method!r}")
    if concurrency < 1:
        raise ValueError("concurrency must be >= 1")
    n = len(args_list)
    if n == 0:
        raise ValueError("empty workload")

    if method == "single":
        unit = 1
    else:
        unit = batch_size_for(n, concurrency, batch_size)
    units = [args_list[i:i + unit] for i in range(0, n, unit)]
    queue = iter(units)

    latencies: list[float] = []
    weights: list[int] = []
    failures = 0
    ready = 0
    all_ready = asyncio.Event()
    start = asyncio.Event()

    async def client() -> None:
        nonlocal failures, ready
        async with acquire() as conn:
            ready += 1
            if ready == concurrency:
                all_ready.set()
            await start.wait()
            for chunk in queue:
                if method == "single":
                    args = chunk[0]
                    t0 = clock()
                    result = await op(conn, *args)
                    t1 = clock()
                    latencies.append(float(t1 - t0))
                    weights.append(1)
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
                    if check is not None:
                        failures += sum(1 for r, a in zip(results, chunk) if not check(r, a))

    gc.collect()
    gc_was_enabled = gc.isenabled()
    gc.disable()
    try:
        tasks = [asyncio.create_task(client()) for _ in range(concurrency)]
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
        method=method,
        batch_size=unit,
        concurrency=concurrency,
        ops=n,
        elapsed_ns=t_end - t_start,
        failures=failures,
        latencies_ns=latencies,
        weights=weights,
        t_start_ns=t_start,
        t_end_ns=t_end,
        client_cpu_ns=cpu1 - cpu0,
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
