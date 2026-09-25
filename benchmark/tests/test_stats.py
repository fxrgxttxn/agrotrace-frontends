"""Statistics and timing-core tests (Task 4): percentiles/median on known data, the per-run
median consolidation, and that batched measurement divides each timed batch by exactly the number
of calls in it (driven by a fake clock, so the expected numbers are exact). Pure — no stand
needed."""
from __future__ import annotations

import asyncio
import contextlib

import pytest

from agrobench import measure as m
from agrobench.stats import median, median_of_runs, percentile, summarize


# ---------------------------------------------------------------------------------------------
# percentiles / median / summary
# ---------------------------------------------------------------------------------------------

def test_percentiles_on_known_data_use_linear_interpolation():
    data = list(range(1, 11))  # 1..10
    assert percentile(data, 50) == pytest.approx(5.5)
    assert percentile(data, 95) == pytest.approx(9.55)
    assert percentile(data, 99) == pytest.approx(9.91)
    assert percentile(data, 0) == 1
    assert percentile(data, 100) == 10


def test_percentile_is_order_independent_and_handles_single_value():
    assert percentile([10, 1, 7, 3], 50) == percentile([1, 3, 7, 10], 50) == pytest.approx(5.0)
    assert percentile([42], 99) == 42


def test_percentile_rejects_empty_and_out_of_range():
    with pytest.raises(ValueError):
        percentile([], 50)
    with pytest.raises(ValueError):
        percentile([1, 2], 101)


def test_median_odd_and_even():
    assert median([3, 1, 2]) == 2
    assert median([4, 1, 3, 2]) == 2.5
    with pytest.raises(ValueError):
        median([])


def test_summarize_known_series():
    s = summarize([1000, 2000, 3000, 4000], ops=4, elapsed_ns=10_000)
    assert s.p50_us == pytest.approx(2.5)
    assert s.p95_us == pytest.approx(3.85)
    assert s.p99_us == pytest.approx(3.97)
    assert s.mean_us == pytest.approx(2.5)
    assert s.ops_s == pytest.approx(400_000)
    assert (s.n, s.samples) == (4, 4)


def test_summarize_weighted_mean_is_total_time_over_total_ops():
    # Two batches: 1 call at 1000 ns, 3 calls averaging 3000 ns -> 10 000 ns over 4 calls.
    s = summarize([1000, 3000], ops=4, elapsed_ns=10_000, weights=[1, 3])
    assert s.mean_us == pytest.approx(2.5)
    assert s.p50_us == pytest.approx(2.0)  # percentiles stay over samples
    assert (s.n, s.samples) == (4, 2)


def test_median_of_runs_groups_and_takes_median_of_each_metric():
    rows = []
    for run, (p50, ops) in enumerate([(10, 100), (30, 300), (20, 200)], 1):
        rows.append({"dbms": "pg", "query": "R1", "run": run, "p50_us": p50, "p95_us": p50 * 2,
                     "p99_us": p50 * 3, "mean_us": p50, "ops_s": ops})
    rows.append({"dbms": "redis", "query": "R1", "run": 1, "p50_us": 5, "p95_us": 6, "p99_us": 7,
                 "mean_us": 5, "ops_s": 900})
    out = median_of_runs(rows, ["dbms", "query"])
    assert [(r["dbms"], r["query"]) for r in out] == [("pg", "R1"), ("redis", "R1")]
    pg = out[0]
    assert (pg["p50_us"], pg["p95_us"], pg["p99_us"], pg["ops_s"]) == (20, 40, 60, 200)
    assert (pg["runs"], pg["p50_us_min"], pg["p50_us_max"]) == (3, 10, 30)
    assert out[1]["runs"] == 1 and out[1]["ops_s"] == 900


# ---------------------------------------------------------------------------------------------
# measure(): single vs batched, division, concurrency, method choice
# ---------------------------------------------------------------------------------------------

class FakeClock:
    """Deterministic clock: time only moves when an operation 'takes' time."""

    def __init__(self) -> None:
        self.now = 0

    def __call__(self) -> int:
        return self.now


def _acquire():
    return contextlib.nullcontext("conn")


def _run(coro):
    return asyncio.run(coro)


def test_batched_measurement_divides_each_batch_by_its_call_count():
    clock = FakeClock()

    async def op(_conn, cost):
        clock.now += cost

    # 2500 calls -> batches of 1000, 1000, 500. Batch 1 costs 1000 ns/call, batch 2 3000 ns/call,
    # batch 3 5000 ns/call: each sample must be exactly that per-call figure.
    args = [(1000,)] * 1000 + [(3000,)] * 1000 + [(5000,)] * 500
    res = _run(m.measure(op, args, acquire=_acquire, method="batched", clock=clock))
    assert res.method == "batched" and res.batch_size == 1000
    assert res.latencies_ns == [1000.0, 3000.0, 5000.0]
    assert res.weights == [1000, 1000, 500]
    assert res.ops == 2500
    assert res.elapsed_ns == 1000 * 1000 + 3000 * 1000 + 5000 * 500
    s = res.summary()
    assert s.mean_us == pytest.approx((1000 * 1000 + 3000 * 1000 + 5000 * 500) / 2500 / 1000)
    assert s.ops_s == pytest.approx(2500 / (res.elapsed_ns / 1e9))
    assert s.samples == 3


def test_single_measurement_records_one_sample_per_call():
    clock = FakeClock()

    async def op(_conn, cost):
        clock.now += cost

    res = _run(m.measure(op, [(10,), (20,), (30,)], acquire=_acquire, method="single", clock=clock))
    assert res.latencies_ns == [10.0, 20.0, 30.0]
    assert res.weights == [1, 1, 1]
    assert res.elapsed_ns == 60


def test_batched_at_concurrency_uses_fair_share_batches_and_counts_every_call():
    assert m.batch_size_for(10_000, 16) == 625
    assert m.batch_size_for(10_000, 1) == 1000
    assert m.batch_size_for(5, 16) == 1
    calls = []

    async def op(conn, i):
        calls.append(i)
        await asyncio.sleep(0)

    res = _run(m.measure(op, [(i,) for i in range(10_000)], acquire=_acquire, concurrency=16,
                         method="batched"))
    assert sorted(calls) == list(range(10_000))  # every call exactly once
    assert res.batch_size == 625 and len(res.latencies_ns) == 16 and sum(res.weights) == 10_000


def test_check_failures_are_counted_outside_the_timed_region():
    async def op(_conn, x):
        return x

    res = _run(m.measure(op, [(1,), (0,), (1,), (0,)], acquire=_acquire, method="batched",
                         check=lambda r, _a: r == 1))
    assert res.failures == 2
    res = _run(m.measure(op, [(1,), (0,)], acquire=_acquire, method="single",
                         check=lambda r, _a: r == 1))
    assert res.failures == 1


def test_choose_method_threshold_is_p50_below_50_microseconds():
    assert m.choose_method([49_000] * 10) == "batched"
    assert m.choose_method([51_000] * 10) == "single"
    # p50, not mean: a few slow outliers don't flip a fast operation to single.
    assert m.choose_method([10_000] * 9 + [10_000_000] * 2) == "batched"


def test_client_failure_before_start_is_raised_not_hung():
    class Boom(Exception):
        pass

    @contextlib.asynccontextmanager
    async def bad_acquire():
        raise Boom()
        yield  # pragma: no cover

    async def op(_conn):
        return None

    with pytest.raises(Boom):
        _run(m.measure(op, [()] * 4, acquire=bad_acquire, concurrency=4))


def test_merge_parallel_spans_earliest_start_to_latest_finish():
    a = m.SeriesResult("single", 1, 2, ops=3, elapsed_ns=300, failures=0, latencies_ns=[1, 2, 3],
                       weights=[1, 1, 1], t_start_ns=1000, t_end_ns=1300, client_cpu_ns=100)
    b = m.SeriesResult("single", 1, 2, ops=2, elapsed_ns=250, failures=1, latencies_ns=[4, 5],
                       weights=[1, 1], t_start_ns=1100, t_end_ns=1350, client_cpu_ns=50)
    merged = m.merge_parallel([a, b])
    assert (merged.ops, merged.concurrency, merged.failures, merged.client_procs) == (5, 4, 1, 2)
    assert merged.elapsed_ns == 350  # 1000 -> 1350, not 300 + 250
    assert merged.latencies_ns == [1, 2, 3, 4, 5]
    assert merged.client_cpu_ns == 150
    assert merged.summary().ops_s == pytest.approx(5 / 350e-9)
    with pytest.raises(ValueError):
        m.merge_parallel([a, m.SeriesResult("batched", 10, 1, 10, 10, 0, [1], [10])])


def test_merge_sequential_sums_only_the_timed_parts():
    parts = [m.SeriesResult("single", 1, 1, ops=1, elapsed_ns=e, failures=0, latencies_ns=[e],
                            weights=[1], t_start_ns=s, t_end_ns=s + e)
             for s, e in [(0, 100), (10_000, 300)]]  # untimed fixture work in between
    merged = m.merge_sequential(parts)
    assert merged.elapsed_ns == 400 and merged.ops == 2
    assert merged.summary().mean_us == pytest.approx(0.2)
