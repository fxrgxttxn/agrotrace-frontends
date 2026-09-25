"""Tests for `assert_redis_invariants` (Review Focus 2): after every Redis write/delete operation
(W1, W2, W3 success and stale-version, D1, D2), every secondary structure it touches (code, held,
held:status, stats, children/parents, tests list, tests:by_due) must still agree with what the
primary hashes (batch:*, test:*) and edge hashes (link:*:*) imply. Also proves the checker itself
is not a rubber stamp: a planted inconsistency in any one of those structures must make it fail
(RED), and undoing the plant must make it pass again (GREEN).

Needs a running stand (`./at.sh bench up`). Redis-only (no PostgreSQL): this file is about the
invariant checker, not cross-DBMS equivalence (that's test_query_equivalence.py, which also calls
assert_redis_invariants after each of its own writes/deletes).
"""
from __future__ import annotations

import os

import pytest
import redis

from agrobench import load_redis, redis_keys
from agrobench.generate import EPOCH, generate, write_csv
from agrobench.queries import redis as rq
from agrobench.queries.redis_invariants import assert_redis_invariants

SCALE = 500
SEED = 4104


@pytest.fixture(scope="module")
def dataset(tmp_path_factory):
    data_dir = tmp_path_factory.mktemp("bench-data-invariants")
    result = generate(SCALE, SEED)
    write_csv(result.organizations, data_dir / "organizations.csv")
    write_csv(result.batches, data_dir / "batches.csv")
    write_csv(result.batch_links, data_dir / "batch_links.csv")
    write_csv(result.lab_tests, data_dir / "lab_tests.csv")
    load_redis.load(data_dir)
    return result


@pytest.fixture(scope="module")
def r(dataset):
    client = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True, socket_connect_timeout=5)
    yield client
    client.close()


def _new_batch(bid: int, holder_org_id: int, origin_org_id: int, status: str = "Created") -> dict:
    return {
        "id": bid,
        "public_code": f"BENCH-INV-{bid:08d}",
        "product": "Тестовая партия",
        "origin_org_id": origin_org_id,
        "holder_org_id": holder_org_id,
        "kind": "RAW",
        "mass_kg": "3.250",
        "status": status,
        "harvested_at": "2025-07-01T00:00:00+00:00",
        "version": 1,
    }


# ---------------------------------------------------------------------------
# GREEN: invariants hold after a freshly loaded dataset and after every write/delete kind
# ---------------------------------------------------------------------------

def test_invariants_hold_after_fresh_load(dataset, r):
    assert_redis_invariants(r)


def test_invariants_hold_after_w1(dataset, r):
    holder_id = dataset.batches[0]["holder_org_id"]
    origin_id = dataset.organizations[0]["id"]
    rq.w1_insert_batch(r, _new_batch(200_001, holder_id, origin_id))
    assert_redis_invariants(r)


def test_invariants_hold_after_w2_pipeline(dataset, r):
    holder_id = dataset.batches[1]["holder_org_id"]
    origin_id = dataset.organizations[0]["id"]
    batches = [_new_batch(200_100 + i, holder_id, origin_id) for i in range(30)]
    rq.w2_insert_batches(r, batches)
    assert_redis_invariants(r)


def test_invariants_hold_after_w3_success_and_stale(dataset, r):
    batch_id = dataset.batches[20]["id"]
    original_status = dataset.batches[20]["status"]
    new_status = "Blocked" if original_status != "Blocked" else "Recalled"

    assert rq.w3_update_status(r, batch_id, new_status, 1) is True
    assert_redis_invariants(r)

    # Stale version must be rejected without disturbing anything.
    assert rq.w3_update_status(r, batch_id, "Sold", 1) is False
    assert_redis_invariants(r)


def test_invariants_hold_after_d1(dataset, r):
    holder_id = dataset.batches[0]["holder_org_id"]
    origin_id = dataset.organizations[0]["id"]
    parent = _new_batch(200_300, holder_id, origin_id)
    child = _new_batch(200_301, holder_id, origin_id)
    rq.w1_insert_batch(r, parent)
    rq.w1_insert_batch(r, child)
    # Wire up a link and a lab test directly (spec §13.5 defines no insert-link/insert-test query
    # -- these are pure test fixtures for exercising D1's cascade, not benchmarked operations).
    r.sadd("batch:200300:children", "200301")
    r.sadd("batch:200301:parents", "200300")
    r.hset("link:200300:200301", mapping={"mass_used_kg": "1.000", "link_type": "PROCESSING",
                                           "created_at": "2025-07-01T00:00:00+00:00"})
    r.hset("test:200900", mapping={"batch_id": "200301", "lab_org_id": str(origin_id),
                                    "reason": "PLANNED", "conclusion": "PASS", "value": "1.0000",
                                    "due_at": "2025-08-01T00:00:00+00:00"})
    r.rpush("batch:200301:tests", "200900")
    r.zadd("tests:by_due", {"200900": redis_keys.to_score("2025-08-01T00:00:00+00:00")})
    assert_redis_invariants(r)

    assert rq.d1_delete_batch(r, 200_301) is True
    assert_redis_invariants(r)
    assert not r.sismember("batch:200300:children", "200301")
    assert r.hgetall("test:200900") == {}


def test_invariants_hold_after_d2(dataset, r):
    cutoff = EPOCH.replace(year=EPOCH.year + 1)
    rq.d2_delete_tests_due_before(r, cutoff)
    assert_redis_invariants(r)


# ---------------------------------------------------------------------------
# RED then GREEN: the checker must catch a planted inconsistency, and stop complaining once it's
# undone. One mutation per secondary structure kind the checker covers.
# ---------------------------------------------------------------------------

def test_planted_stats_mutation_is_caught_then_clears(dataset, r):
    b = dataset.batches[5]
    key = f"stats:org:{b['holder_org_id']}"
    original = r.hget(key, b["status"])

    r.hset(key, b["status"], "999999")
    with pytest.raises(AssertionError, match="stats:org"):
        assert_redis_invariants(r)

    r.hset(key, b["status"], original)
    assert_redis_invariants(r)


def test_planted_held_status_removal_is_caught_then_clears(dataset, r):
    b = dataset.batches[6]
    key = f"org:{b['holder_org_id']}:held:{b['status']}"
    score = r.zscore(key, str(b["id"]))
    assert score is not None, "fixture assumption: this batch must be in its held:status zset"

    r.zrem(key, str(b["id"]))
    with pytest.raises(AssertionError, match="held:"):
        assert_redis_invariants(r)

    r.zadd(key, {str(b["id"]): score})
    assert_redis_invariants(r)


def test_planted_stray_child_edge_is_caught_then_clears(dataset, r):
    # A child reference with no matching link:*:* hash and no reciprocal parents-set entry -- the
    # kind of drift a half-applied write could leave behind.
    a, b = dataset.batches[0]["id"], dataset.batches[1]["id"]
    key = f"batch:{a}:children"

    r.sadd(key, str(b))
    with pytest.raises(AssertionError, match="children"):
        assert_redis_invariants(r)

    r.srem(key, str(b))
    assert_redis_invariants(r)


def test_planted_code_index_drift_is_caught_then_clears(dataset, r):
    b = dataset.batches[7]
    code_key = f"batch:code:{b['public_code']}"
    original = r.get(code_key)

    r.set(code_key, "999999999")
    with pytest.raises(AssertionError, match="batch:code"):
        assert_redis_invariants(r)

    r.set(code_key, original)
    assert_redis_invariants(r)
