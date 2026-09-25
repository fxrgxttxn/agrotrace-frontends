"""Smoke test for the report figures (Task 5): every figure renders from the published data into a
non-trivial PNG. Pure — no stand needed."""
from __future__ import annotations

from agrobench import plot


def test_every_figure_renders_from_the_published_data(tmp_path):
    paths = plot.plot_all(out_dir=tmp_path)
    assert [p.name for p in paths] == [
        "reads_latency.png", "optimization.png", "prepared.png", "durability.png", "durability_c16.png",
        "bulk.png", "scaling.png", "memory.png", "load.png",
    ]
    for p in paths:
        assert p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n" and p.stat().st_size > 10_000, p
