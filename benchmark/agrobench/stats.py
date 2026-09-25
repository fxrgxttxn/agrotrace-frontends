"""Latency statistics for the measurement harness (spec §13.6: p50, p95, p99, mean, ops/s; 3 runs
-> median of runs). Pure functions over plain numbers — covered by tests/test_stats.py.

Percentiles use linear interpolation between closest ranks (numpy's default `linear` method, the
same definition as PostgreSQL's `percentile_cont`), so p50 of an even-sized sample is the mean of
the two middle values.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

NS_PER_US = 1_000
NS_PER_S = 1_000_000_000

METRICS = ("p50_us", "p95_us", "p99_us", "mean_us", "ops_s")


@dataclass(frozen=True)
class Summary:
    p50_us: float
    p95_us: float
    p99_us: float
    mean_us: float
    ops_s: float
    n: int          # logical operations measured
    samples: int    # latency samples the percentiles are computed over (= n for single, n/batch for batched)

    def as_dict(self) -> dict:
        return {
            "p50_us": self.p50_us, "p95_us": self.p95_us, "p99_us": self.p99_us,
            "mean_us": self.mean_us, "ops_s": self.ops_s, "n": self.n, "samples": self.samples,
        }


def percentile(values: Sequence[float], q: float) -> float:
    """q-th percentile (0..100) with linear interpolation; raises on an empty sample."""
    if len(values) == 0:
        raise ValueError("percentile of an empty sample")
    if not 0 <= q <= 100:
        raise ValueError(f"percentile q must be within 0..100, got {q}")
    return float(np.percentile(np.asarray(values, dtype=np.float64), q, method="linear"))


def summarize(latencies_ns: Sequence[float], *, ops: int, elapsed_ns: int,
              weights: Sequence[int] | None = None) -> Summary:
    """Summarises one measured series.

    `latencies_ns`: one sample per timed unit — a single operation (method=single) or the
    per-operation average of one timed batch (method=batched, batch total / batch size).
    `weights`: operations behind each sample (batch sizes); the mean is weighted by them, so it is
    always total time / total operations whichever method was used. Percentiles are over samples.
    `ops`/`elapsed_ns`: operations completed and wall-clock time of the whole series (all
    concurrent clients together) -> throughput.
    """
    if len(latencies_ns) == 0:
        raise ValueError("cannot summarise an empty series")
    if ops <= 0 or elapsed_ns <= 0:
        raise ValueError("ops and elapsed_ns must be positive")
    arr = np.asarray(latencies_ns, dtype=np.float64)
    if weights is None:
        mean_ns = float(arr.mean())
    else:
        if len(weights) != len(latencies_ns):
            raise ValueError("weights must match latencies_ns in length")
        w = np.asarray(weights, dtype=np.float64)
        mean_ns = float((arr * w).sum() / w.sum())
    p50, p95, p99 = (float(x) for x in np.percentile(arr, [50, 95, 99], method="linear"))
    return Summary(
        p50_us=p50 / NS_PER_US,
        p95_us=p95 / NS_PER_US,
        p99_us=p99 / NS_PER_US,
        mean_us=mean_ns / NS_PER_US,
        ops_s=ops / (elapsed_ns / NS_PER_S),
        n=ops,
        samples=len(latencies_ns),
    )


def median(values: Iterable[float]) -> float:
    vals = list(values)
    if not vals:
        raise ValueError("median of an empty sample")
    return float(statistics.median(vals))


def median_of_runs(rows: list[dict], key_fields: Sequence[str],
                   metrics: Sequence[str] = METRICS) -> list[dict]:
    """Groups per-run rows by `key_fields` and returns one row per group holding the median of
    each metric across runs (spec §13.6 "в отчёт идёт медиана прогонов"), plus `runs` and the
    min/max of p50 across runs so run-to-run spread stays visible. Group order = first appearance.
    """
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        groups.setdefault(tuple(row[k] for k in key_fields), []).append(row)
    out = []
    for key, members in groups.items():
        result = dict(zip(key_fields, key))
        for m in metrics:
            result[m] = median(float(r[m]) for r in members)
        p50s = [float(r["p50_us"]) for r in members] if "p50_us" in metrics else []
        result["runs"] = len(members)
        if p50s:
            result["p50_us_min"] = min(p50s)
            result["p50_us_max"] = max(p50s)
        out.append(result)
    return out
