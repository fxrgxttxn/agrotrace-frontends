"""Tests for the deterministic data generator (spec §13.4). Pure Python, no live DBMS needed."""
from __future__ import annotations

from collections import Counter, defaultdict

import pytest

from agrobench.generate import MAX_DEPTH, generate

SCALE = 500
SEED = 42


@pytest.fixture(scope="module")
def result():
    return generate(SCALE, SEED)


def test_scale_respected(result):
    assert len(result.organizations) == SCALE
    assert len(result.batches) == SCALE
    assert len(result.lab_tests) == SCALE


def test_ids_are_dense_bigints(result):
    assert [o["id"] for o in result.organizations] == list(range(1, SCALE + 1))
    assert [b["id"] for b in result.batches] == list(range(1, SCALE + 1))
    assert [t["id"] for t in result.lab_tests] == list(range(1, SCALE + 1))


def test_deterministic_for_same_seed():
    a = generate(SCALE, SEED)
    b = generate(SCALE, SEED)
    assert a.organizations == b.organizations
    assert a.batches == b.batches
    assert a.batch_links == b.batch_links
    assert a.lab_tests == b.lab_tests


def test_different_seed_changes_output():
    a = generate(SCALE, SEED)
    b = generate(SCALE, SEED + 1)
    assert a.batches != b.batches


def test_graph_is_acyclic_and_within_max_depth(result):
    parents: dict[int, list[int]] = defaultdict(list)
    for link in result.batch_links:
        assert link["parent_id"] < link["child_id"], (
            "an edge must only go from an earlier to a later batch id -- this is what makes the "
            "graph acyclic by construction"
        )
        parents[link["child_id"]].append(link["parent_id"])

    depth: dict[int, int] = {}
    for batch in sorted(result.batches, key=lambda b: b["id"]):
        bid = batch["id"]
        if batch["kind"] == "RAW":
            assert bid not in parents, "a RAW batch must have no parents"
            depth[bid] = 0
        else:
            ps = parents[bid]
            assert 1 <= len(ps) <= 4, f"DERIVED batch {bid} must have 1-4 parents, has {len(ps)}"
            depth[bid] = max(depth[p] for p in ps) + 1

    assert max(depth.values()) <= MAX_DEPTH


def test_raw_derived_share_within_tolerance(result):
    raw = sum(1 for b in result.batches if b["kind"] == "RAW")
    assert abs(raw / SCALE - 0.6) < 0.05


def test_status_distribution_within_tolerance(result):
    counts = Counter(b["status"] for b in result.batches)
    for status, expected_share in {"Approved": 0.45, "Accepted": 0.20, "OnSale": 0.15}.items():
        assert abs(counts[status] / SCALE - expected_share) < 0.06


def test_fail_share_within_tolerance(result):
    fails = sum(1 for t in result.lab_tests if t["conclusion"] == "FAIL")
    assert abs(fails / SCALE - 0.03) < 0.025


def test_trust_rating_only_on_farms(result):
    for org in result.organizations:
        if org["type"] == "FARM":
            assert isinstance(org["trust_rating"], int)
            assert 0 <= org["trust_rating"] <= 100
        else:
            assert org["trust_rating"] == ""


@pytest.mark.parametrize("scale", [1, 5, 50])
def test_generate_does_not_crash_at_small_scale(scale):
    r = generate(scale, SEED)
    assert len(r.organizations) == scale
    assert len(r.batches) == scale
    assert len(r.lab_tests) == scale
