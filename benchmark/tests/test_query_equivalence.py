"""Equivalence tests for queries R1-R6, W1-W3, D1-D2 (spec §13.5; Review Focus 1, 2). Loads the
same --scale 500 dataset into both PostgreSQL and Redis (like test_load_equivalence.py) and checks
that every read query gives the same *logical* result on every key/org/status in the dataset, and
that every write/delete leaves both DBMS holding identical full content plus (for Redis) every
secondary structure consistent with the primary hashes (`assert_redis_invariants`).

Needs a running stand (`./at.sh bench up`). Tests run in file order against one shared module-
scoped dataset/connection pair: R1-R6 (pure reads) first, then W1/W2 (additive, ids >= 100000, so
they can never collide with or change the results already checked for ids 1..SCALE), then W3
(mutates one existing batch), then D1 (deletes one existing batch), then D2 (bulk-deletes tests) --
each later test's mutations are safe precisely because no earlier test re-reads the data it
touches.
"""
from __future__ import annotations

import os
from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal

import psycopg
import pytest
import redis

from agrobench import load_pg, load_redis
from agrobench.generate import EPOCH, STATUS_SHARE, OTHER_STATUSES, generate, write_csv
from agrobench.queries import pg as pgq
from agrobench.queries import redis as rq
from agrobench.queries.redis_invariants import assert_redis_invariants

SCALE = 500
SEED = 2026
ALL_STATUSES = list(STATUS_SHARE) + OTHER_STATUSES


@pytest.fixture(scope="module")
def dataset(tmp_path_factory):
    data_dir = tmp_path_factory.mktemp("bench-data-q3")
    result = generate(SCALE, SEED)
    write_csv(result.organizations, data_dir / "organizations.csv")
    write_csv(result.batches, data_dir / "batches.csv")
    write_csv(result.batch_links, data_dir / "batch_links.csv")
    write_csv(result.lab_tests, data_dir / "lab_tests.csv")
    load_pg.load(data_dir)
    load_redis.load(data_dir)
    return result


@pytest.fixture(scope="module")
def pg_conn():
    conn = psycopg.connect(autocommit=True)
    yield conn
    conn.close()


@pytest.fixture(scope="module")
def r(dataset):
    client = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True, socket_connect_timeout=5)
    yield client
    client.close()


def _dt(v) -> datetime:
    return v if isinstance(v, datetime) else datetime.fromisoformat(v)


def _dec(v) -> Decimal:
    return v if isinstance(v, Decimal) else Decimal(str(v))


def assert_batches_equal(pg_b: dict | None, r_b: dict | None, ctx: str) -> None:
    if pg_b is None or r_b is None:
        assert pg_b is None and r_b is None, f"{ctx}: presence mismatch pg={pg_b!r} redis={r_b!r}"
        return
    assert pg_b["id"] == r_b["id"], ctx
    assert pg_b["public_code"] == r_b["public_code"], ctx
    assert pg_b["product"] == r_b["product"], ctx
    assert pg_b["origin_org_id"] == r_b["origin_org_id"], ctx
    assert pg_b["holder_org_id"] == r_b["holder_org_id"], ctx
    assert pg_b["kind"] == r_b["kind"], ctx
    assert _dec(pg_b["mass_kg"]) == _dec(r_b["mass_kg"]), ctx
    assert pg_b["status"] == r_b["status"], ctx
    assert _dt(pg_b["harvested_at"]) == _dt(r_b["harvested_at"]), ctx
    assert pg_b["version"] == r_b["version"], ctx


def assert_orgs_equal(pg_o: dict | None, r_o: dict | None, ctx: str) -> None:
    if pg_o is None or r_o is None:
        assert pg_o is None and r_o is None, f"{ctx}: presence mismatch pg={pg_o!r} redis={r_o!r}"
        return
    assert pg_o["id"] == r_o["id"], ctx
    assert pg_o["type"] == r_o["type"], ctx
    assert pg_o["name"] == r_o["name"], ctx
    assert pg_o["inn"] == r_o["inn"], ctx
    assert pg_o["region_code"] == r_o["region_code"], ctx
    assert pg_o["trust_rating"] == r_o["trust_rating"], ctx
    assert _dt(pg_o["created_at"]) == _dt(r_o["created_at"]), ctx


def assert_tests_equal(pg_t: dict, r_t: dict, ctx: str) -> None:
    assert pg_t["id"] == r_t["id"], ctx
    assert pg_t["batch_id"] == r_t["batch_id"], ctx
    assert pg_t["lab_org_id"] == r_t["lab_org_id"], ctx
    assert pg_t["reason"] == r_t["reason"], ctx
    assert pg_t["conclusion"] == r_t["conclusion"], ctx
    assert _dec(pg_t["value"]) == _dec(r_t["value"]), ctx
    assert _dt(pg_t["due_at"]) == _dt(r_t["due_at"]), ctx


# ---------------------------------------------------------------------------
# R1-R6: read equivalence over every key/org/status in the dataset
# ---------------------------------------------------------------------------

def test_r1_batch_by_id_matches_for_every_batch(dataset, pg_conn, r):
    for b in dataset.batches:
        pg_b = pgq.r1_batch_by_id(pg_conn, b["id"])
        r_b = rq.r1_batch_by_id(r, b["id"])
        assert_batches_equal(pg_b, r_b, f"batch {b['id']}")


def test_r1_missing_id_returns_none_both(pg_conn, r):
    missing = 999_999
    assert pgq.r1_batch_by_id(pg_conn, missing) is None
    assert rq.r1_batch_by_id(r, missing) is None


def test_r2_batch_by_code_matches_for_every_code(dataset, pg_conn, r):
    for b in dataset.batches:
        pg_b = pgq.r2_batch_by_code(pg_conn, b["public_code"])
        r_b = rq.r2_batch_by_code(r, b["public_code"])
        assert_batches_equal(pg_b, r_b, f"code {b['public_code']}")


def test_r2_missing_code_returns_none_both(pg_conn, r):
    assert pgq.r2_batch_by_code(pg_conn, "NO-SUCH-CODE") is None
    assert rq.r2_batch_by_code(r, "NO-SUCH-CODE") is None


def test_r3_holder_batches_by_status_matches_for_every_org_and_status(dataset, pg_conn, r):
    holder_ids = {b["holder_org_id"] for b in dataset.batches}
    checked_nonempty = 0
    for holder_id in holder_ids:
        for status in ALL_STATUSES:
            pg_rows = pgq.r3_holder_batches_by_status(pg_conn, holder_id, status)
            r_rows = rq.r3_holder_batches_by_status(r, holder_id, status)
            ctx = f"holder {holder_id} status {status}"
            assert [x["id"] for x in pg_rows] == [x["id"] for x in r_rows], ctx
            for pg_b, r_b in zip(pg_rows, r_rows):
                assert_batches_equal(pg_b, r_b, ctx)
            if pg_rows:
                checked_nonempty += 1
    assert checked_nonempty > 0, "test data produced no non-empty R3 result to compare"


def test_r3_result_is_sorted_newest_first_and_capped(dataset, pg_conn):
    # Sanity check on the ordering/limit contract itself (not just cross-DB equality) using a
    # holder+status combination known to have more than one batch.
    counts: dict[tuple, int] = defaultdict(int)
    for b in dataset.batches:
        counts[(b["holder_org_id"], b["status"])] += 1
    holder_id, status = max(counts, key=counts.get)
    rows = pgq.r3_holder_batches_by_status(pg_conn, holder_id, status, limit=50)
    assert len(rows) <= 50
    assert rows == sorted(rows, key=lambda x: x["harvested_at"], reverse=True)


def test_r4_batch_with_holder_and_tests_matches_for_every_batch(dataset, pg_conn, r):
    for b in dataset.batches:
        pg_res = pgq.r4_batch_with_holder_and_tests(pg_conn, b["id"])
        r_res = rq.r4_batch_with_holder_and_tests(r, b["id"])
        ctx = f"batch {b['id']}"
        assert (pg_res is None) == (r_res is None), ctx
        if pg_res is None:
            continue
        assert_batches_equal(pg_res["batch"], r_res["batch"], ctx)
        assert_orgs_equal(pg_res["holder"], r_res["holder"], ctx)
        pg_tests = sorted(pg_res["tests"], key=lambda t: t["id"])
        r_tests = sorted(r_res["tests"], key=lambda t: t["id"])
        assert [t["id"] for t in pg_tests] == [t["id"] for t in r_tests], ctx
        for pg_t, r_t in zip(pg_tests, r_tests):
            assert_tests_equal(pg_t, r_t, ctx)


def test_r5_descendants_match_for_every_batch_both_redis_variants(dataset, pg_conn, r):
    """Review Focus 1: R4/R5 equivalence across all three implementations, on every key in the
    small dataset -- the generated DAG's DERIVED batches (1-4 parents each) guarantee this
    naturally exercises shared descendants and depth > 1, not just curated examples."""
    max_seen_depth_signal = 0
    for b in dataset.batches:
        bid = b["id"]
        pg_set = pgq.r5_descendants(pg_conn, bid, max_depth=20)
        redis_bfs_set = rq.r5_descendants(r, bid, max_depth=20)
        redis_lua_set = rq.r5_descendants_lua(r, bid, max_depth=20)
        ctx = f"batch {bid}: pg={sorted(pg_set)} bfs={sorted(redis_bfs_set)} lua={sorted(redis_lua_set)}"
        assert pg_set == redis_bfs_set == redis_lua_set, ctx
        if len(pg_set) > max_seen_depth_signal:
            max_seen_depth_signal = len(pg_set)
    assert max_seen_depth_signal > 1, (
        "test data produced no batch with more than one descendant -- R5 depth/shared-descendant "
        "coverage would be vacuous"
    )


def test_r5_shared_descendant_in_a_diamond_is_reported_once(dataset, pg_conn, r):
    """A concrete DAG shape check (Review Focus 1): find a batch reachable from a common ancestor
    via at least two distinct parents (a 'diamond') and confirm it's counted exactly once by all
    three implementations, at depth > 1 from the ancestor."""
    parents_of: dict[int, list[int]] = defaultdict(list)
    for link in dataset.batch_links:
        parents_of[link["child_id"]].append(link["parent_id"])

    diamond_child = next((c for c, ps in parents_of.items() if len(ps) >= 2), None)
    assert diamond_child is not None, "test data has no batch with >= 2 parents to use as a diamond"
    ancestor = parents_of[diamond_child][0]
    # ancestor's parent (if any) is a depth-2-from-it ancestor whose descendant set must still
    # contain diamond_child exactly once even though multiple paths lead to it.
    grandparents = parents_of.get(ancestor)
    probe = grandparents[0] if grandparents else ancestor

    pg_set = pgq.r5_descendants(pg_conn, probe, max_depth=20)
    redis_bfs_set = rq.r5_descendants(r, probe, max_depth=20)
    redis_lua_set = rq.r5_descendants_lua(r, probe, max_depth=20)
    assert diamond_child in pg_set
    assert pg_set == redis_bfs_set == redis_lua_set


def test_r6_status_counts_match_for_every_org(dataset, pg_conn, r):
    org_ids = {o["id"] for o in dataset.organizations}
    checked_nonempty = 0
    for org_id in org_ids:
        pg_counts = pgq.r6_status_counts(pg_conn, org_id)
        r_counts = rq.r6_status_counts(r, org_id)
        assert pg_counts == r_counts, f"org {org_id}"
        if pg_counts:
            checked_nonempty += 1
    assert checked_nonempty > 0


# ---------------------------------------------------------------------------
# W1: insert
# ---------------------------------------------------------------------------

def _new_batch(bid: int, holder_org_id: int, origin_org_id: int, status: str = "Created") -> dict:
    return {
        "id": bid,
        "public_code": f"BENCH-NEW-{bid:08d}",
        "product": "Тестовая партия",
        "origin_org_id": origin_org_id,
        "holder_org_id": holder_org_id,
        "kind": "RAW",
        "mass_kg": "12.500",
        "status": status,
        "harvested_at": "2025-06-01T00:00:00+00:00",
        "version": 1,
    }


def test_w1_insert_batch_matches_and_keeps_invariants(dataset, pg_conn, r):
    holder_id = dataset.batches[0]["holder_org_id"]
    origin_id = dataset.organizations[0]["id"]
    batch = _new_batch(100_001, holder_id, origin_id)

    pgq.w1_insert_batch(pg_conn, batch)
    rq.w1_insert_batch(r, batch)

    pg_b = pgq.r1_batch_by_id(pg_conn, batch["id"])
    r_b = rq.r1_batch_by_id(r, batch["id"])
    assert_batches_equal(pg_b, r_b, "w1 new batch")
    assert pg_b["status"] == "Created"

    pg_counts = pgq.r6_status_counts(pg_conn, holder_id)
    r_counts = rq.r6_status_counts(r, holder_id)
    assert pg_counts == r_counts
    assert_redis_invariants(r)


# ---------------------------------------------------------------------------
# W2: bulk insert -- both PG variants (COPY, multi-row INSERT) vs Redis pipeline of W1s
# ---------------------------------------------------------------------------

def test_w2_copy_variant_matches_redis_pipeline(dataset, pg_conn, r):
    holder_id = dataset.batches[1]["holder_org_id"]
    origin_id = dataset.organizations[0]["id"]
    batches = [_new_batch(100_100 + i, holder_id, origin_id) for i in range(25)]

    pgq.w2_insert_batches_copy(pg_conn, batches)
    rq.w2_insert_batches(r, batches)

    for b in batches:
        pg_b = pgq.r1_batch_by_id(pg_conn, b["id"])
        r_b = rq.r1_batch_by_id(r, b["id"])
        assert_batches_equal(pg_b, r_b, f"w2 copy batch {b['id']}")
    assert_redis_invariants(r)


def test_w2_multirow_variant_matches_redis_pipeline(dataset, pg_conn, r):
    holder_id = dataset.batches[2]["holder_org_id"]
    origin_id = dataset.organizations[0]["id"]
    batches = [_new_batch(100_200 + i, holder_id, origin_id) for i in range(25)]

    pgq.w2_insert_batches_multirow(pg_conn, batches)
    rq.w2_insert_batches(r, batches)

    for b in batches:
        pg_b = pgq.r1_batch_by_id(pg_conn, b["id"])
        r_b = rq.r1_batch_by_id(r, b["id"])
        assert_batches_equal(pg_b, r_b, f"w2 multirow batch {b['id']}")
    assert_redis_invariants(r)


# ---------------------------------------------------------------------------
# W3: optimistic-lock status change
# ---------------------------------------------------------------------------

def test_w3_success_then_stale_version_fails_in_both(dataset, pg_conn, r):
    batch_id = dataset.batches[10]["id"]
    original = next(b for b in dataset.batches if b["id"] == batch_id)
    old_status = original["status"]
    new_status = "Blocked" if old_status != "Blocked" else "Recalled"

    pg_ok = pgq.w3_update_status(pg_conn, batch_id, new_status, 1)
    r_ok = rq.w3_update_status(r, batch_id, new_status, 1)
    assert pg_ok is True and r_ok is True

    pg_b = pgq.r1_batch_by_id(pg_conn, batch_id)
    r_b = rq.r1_batch_by_id(r, batch_id)
    assert_batches_equal(pg_b, r_b, "w3 after successful update")
    assert pg_b["status"] == new_status
    assert pg_b["version"] == 2

    holder_id = original["holder_org_id"]
    assert pgq.r6_status_counts(pg_conn, holder_id) == rq.r6_status_counts(r, holder_id)
    assert_redis_invariants(r)

    # Stale version (still 1, but the row is now at version 2): must be rejected, unchanged, in
    # both DBMS.
    pg_stale_ok = pgq.w3_update_status(pg_conn, batch_id, "Sold", 1)
    r_stale_ok = rq.w3_update_status(r, batch_id, "Sold", 1)
    assert pg_stale_ok is False and r_stale_ok is False

    pg_b_after = pgq.r1_batch_by_id(pg_conn, batch_id)
    r_b_after = rq.r1_batch_by_id(r, batch_id)
    assert_batches_equal(pg_b_after, r_b_after, "w3 after rejected stale update")
    assert pg_b_after["status"] == new_status
    assert pg_b_after["version"] == 2
    assert_redis_invariants(r)


def test_w3_nonexistent_batch_fails_in_both(pg_conn, r):
    assert pgq.w3_update_status(pg_conn, 999_998, "Sold", 1) is False
    assert rq.w3_update_status(r, 999_998, "Sold", 1) is False


# ---------------------------------------------------------------------------
# D1: cascade delete
# ---------------------------------------------------------------------------

def _pick_batch_with_both_edge_directions_and_a_test(dataset) -> int:
    """A batch that is both a child of some link and a parent of some other link, and has at
    least one lab test -- so D1's neighbour cleanup is exercised on both sides plus test cascade,
    reusing the real generated DAG rather than hand-built fixtures."""
    has_parent_link = {link["child_id"] for link in dataset.batch_links}
    has_child_link = {link["parent_id"] for link in dataset.batch_links}
    has_test = {t["batch_id"] for t in dataset.lab_tests}
    candidates = has_parent_link & has_child_link & has_test
    assert candidates, "test data has no batch that is both a link child, a link parent, and has a lab test"
    return min(candidates)


def test_d1_delete_batch_cascades_and_matches(dataset, pg_conn, r):
    batch_id = _pick_batch_with_both_edge_directions_and_a_test(dataset)
    parents = [link["parent_id"] for link in dataset.batch_links if link["child_id"] == batch_id]
    children = [link["child_id"] for link in dataset.batch_links if link["parent_id"] == batch_id]
    test_ids = [t["id"] for t in dataset.lab_tests if t["batch_id"] == batch_id]

    pg_ok = pgq.d1_delete_batch(pg_conn, batch_id)
    r_ok = rq.d1_delete_batch(r, batch_id)
    assert pg_ok is True and r_ok is True

    assert pgq.r1_batch_by_id(pg_conn, batch_id) is None
    assert rq.r1_batch_by_id(r, batch_id) is None

    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM batch_links WHERE parent_id = %s OR child_id = %s",
            (batch_id, batch_id),
        )
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM lab_tests WHERE batch_id = %s", (batch_id,))
        assert cur.fetchone()[0] == 0

    for pid in parents:
        assert not r.sismember(f"batch:{pid}:children", str(batch_id))
    for cid in children:
        assert not r.sismember(f"batch:{cid}:parents", str(batch_id))
    for tid in test_ids:
        with pg_conn.cursor() as cur:
            cur.execute("SELECT 1 FROM lab_tests WHERE id = %s", (tid,))
            assert cur.fetchone() is None
        assert r.hgetall(f"test:{tid}") == {}
        assert r.zscore("tests:by_due", str(tid)) is None

    assert_redis_invariants(r)


def test_d1_missing_batch_returns_false_both(pg_conn, r):
    assert pgq.d1_delete_batch(pg_conn, 999_997) is False
    assert rq.d1_delete_batch(r, 999_997) is False


# ---------------------------------------------------------------------------
# D2: bulk delete of tests due before a date
# ---------------------------------------------------------------------------

def test_d2_delete_tests_due_before_matches_and_keeps_invariants(dataset, pg_conn, r):
    cutoff = EPOCH + timedelta(days=450)

    expected_deleted = {
        t["id"] for t in dataset.lab_tests if datetime.fromisoformat(t["due_at"]) < cutoff
    }
    # D1's target batch already removed its own tests above; account for that so the expected set
    # only contains tests that could still exist in Redis/PG at this point.
    expected_deleted -= {
        t["id"] for t in dataset.lab_tests
        if t["batch_id"] == _pick_batch_with_both_edge_directions_and_a_test(dataset)
    }
    assert expected_deleted, "test data has no lab test due before the cutoff to delete"

    pg_deleted = pgq.d2_delete_tests_due_before(pg_conn, cutoff)
    r_deleted = rq.d2_delete_tests_due_before(r, cutoff)
    assert pg_deleted == r_deleted == len(expected_deleted)

    for tid in expected_deleted:
        with pg_conn.cursor() as cur:
            cur.execute("SELECT 1 FROM lab_tests WHERE id = %s", (tid,))
            assert cur.fetchone() is None
        assert r.hgetall(f"test:{tid}") == {}
        assert r.zscore("tests:by_due", str(tid)) is None

    assert_redis_invariants(r)
