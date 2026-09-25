"""The measured code path is the async one (agrobench.queries.pg_async / redis_async, driven by
the asyncio harness); Task 3's cross-DBMS equivalence tests cover the sync implementations. This
file closes the gap: on a --scale 500 dataset every async read returns exactly what its sync twin
returns for every key, and every async write/delete leaves the DBMS in the state the sync readers
expect (plus, for Redis, every secondary structure consistent). Needs `./at.sh bench up`.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
import redis
import redis.asyncio as aioredis

from agrobench import load_pg, load_redis
from agrobench.generate import STATUS_SHARE, OTHER_STATUSES, generate, write_csv
from agrobench.queries import pg as pgq
from agrobench.queries import pg_async as pga
from agrobench.queries import redis as rq
from agrobench.queries import redis_async as ra
from agrobench.queries.redis_invariants import assert_redis_invariants

SCALE = 500
SEED = 9090
ALL_STATUSES = list(STATUS_SHARE) + OTHER_STATUSES


@pytest.fixture(scope="module")
def dataset(tmp_path_factory):
    d = tmp_path_factory.mktemp("bench-data-async")
    result = generate(SCALE, SEED)
    write_csv(result.organizations, d / "organizations.csv")
    write_csv(result.batches, d / "batches.csv")
    write_csv(result.batch_links, d / "batch_links.csv")
    write_csv(result.lab_tests, d / "lab_tests.csv")
    load_pg.load(d)
    load_redis.load(d)
    return result


@pytest.fixture(scope="module")
def pg_conn(dataset):
    conn = psycopg.connect(autocommit=True)
    yield conn
    conn.close()


@pytest.fixture(scope="module")
def r(dataset):
    client = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    yield client
    client.close()


def _pairs(dataset):
    return sorted({(b["holder_org_id"], b["status"]) for b in dataset.batches})


async def _pg_reads(dataset) -> dict:
    out = {}
    async with await psycopg.AsyncConnection.connect(autocommit=True) as conn:
        for b in dataset.batches:
            bid = b["id"]
            out[("R1", bid)] = await pga.r1_batch_by_id(conn, bid)
            out[("R2", bid)] = await pga.r2_batch_by_code(conn, b["public_code"])
            out[("R4", bid)] = await pga.r4_batch_with_holder_and_tests(conn, bid)
            out[("R5", bid)] = await pga.r5_descendants(conn, bid)
        for holder, status in _pairs(dataset):
            out[("R3", holder, status)] = await pga.r3_holder_batches_by_status(conn, holder, status)
            out[("R6", holder)] = await pga.r6_status_counts(conn, holder)
    return out


async def _redis_reads(dataset) -> dict:
    out = {}
    client = aioredis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    try:
        for b in dataset.batches:
            bid = b["id"]
            out[("R1", bid)] = await ra.r1_batch_by_id(client, bid)
            out[("R2", bid)] = await ra.r2_batch_by_code(client, b["public_code"])
            out[("R4", bid)] = await ra.r4_batch_with_holder_and_tests(client, bid)
            out[("R5", bid)] = await ra.r5_descendants(client, bid)
            out[("R5lua", bid)] = await ra.r5_descendants_lua(client, bid)
        for holder, status in _pairs(dataset):
            out[("R3", holder, status)] = await ra.r3_holder_batches_by_status(client, holder, status)
            out[("R6", holder)] = await ra.r6_status_counts(client, holder)
    finally:
        await client.aclose()
    return out


def test_async_pg_reads_equal_sync_for_every_key(dataset, pg_conn):
    got = asyncio.run(_pg_reads(dataset))
    for b in dataset.batches:
        bid = b["id"]
        assert got[("R1", bid)] == pgq.r1_batch_by_id(pg_conn, bid)
        assert got[("R2", bid)] == pgq.r2_batch_by_code(pg_conn, b["public_code"])
        assert got[("R4", bid)] == pgq.r4_batch_with_holder_and_tests(pg_conn, bid)
        assert got[("R5", bid)] == pgq.r5_descendants(pg_conn, bid)
    for holder, status in _pairs(dataset):
        assert got[("R3", holder, status)] == pgq.r3_holder_batches_by_status(pg_conn, holder, status)
        assert got[("R6", holder)] == pgq.r6_status_counts(pg_conn, holder)
    assert any(got[("R5", b["id"])] for b in dataset.batches)  # non-trivial traversals compared


def test_async_redis_reads_equal_sync_for_every_key(dataset, r):
    got = asyncio.run(_redis_reads(dataset))
    for b in dataset.batches:
        bid = b["id"]
        assert got[("R1", bid)] == rq.r1_batch_by_id(r, bid)
        assert got[("R2", bid)] == rq.r2_batch_by_code(r, b["public_code"])
        assert got[("R4", bid)] == rq.r4_batch_with_holder_and_tests(r, bid)
        assert got[("R5", bid)] == rq.r5_descendants(r, bid)
        assert got[("R5lua", bid)] == rq.r5_descendants_lua(r, bid)
    for holder, status in _pairs(dataset):
        assert got[("R3", holder, status)] == rq.r3_holder_batches_by_status(r, holder, status)
        assert got[("R6", holder)] == rq.r6_status_counts(r, holder)


def _new_batches(dataset, first_id: int, n: int) -> list[dict]:
    base = datetime(2031, 1, 1, tzinfo=timezone.utc)
    src = dataset.batches[7]
    return [{
        "id": first_id + i, "public_code": f"ASYNC-{first_id + i}", "product": src["product"],
        "origin_org_id": src["origin_org_id"], "holder_org_id": src["holder_org_id"],
        "kind": "RAW", "mass_kg": "12.500", "status": src["status"],
        "harvested_at": (base + timedelta(seconds=first_id + i)).isoformat(), "version": 1,
    } for i in range(n)]


def test_async_writes_and_deletes_match_sync_readers(dataset, pg_conn, r):
    w1 = _new_batches(dataset, 700_000, 1)[0]
    w2_copy = _new_batches(dataset, 710_000, 30)
    w2_multi = _new_batches(dataset, 720_000, 30)
    target = dataset.batches[20]
    new_status = next(s for s in ALL_STATUSES if s != target["status"])
    victim = next(b["id"] for b in reversed(dataset.batches) if b["kind"] == "DERIVED")
    cutoff = datetime(2023, 6, 1, tzinfo=timezone.utc)

    async def pg_side():
        async with await psycopg.AsyncConnection.connect(autocommit=True) as conn:
            await pga.w1_insert_batch(conn, w1)
            await pga.w2_insert_batches_copy(conn, w2_copy)
            await pga.w2_insert_batches_multirow(conn, w2_multi)
            ok = await pga.w3_update_status(conn, target["id"], new_status, 1)
            stale = await pga.w3_update_status(conn, target["id"], new_status, 1)
            deleted = await pga.d1_delete_batch(conn, victim)
            again = await pga.d1_delete_batch(conn, victim)
            removed = await pga.d2_delete_tests_due_before(conn, cutoff)
            return ok, stale, deleted, again, removed

    async def redis_side():
        client = aioredis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
        try:
            await ra.w1_insert_batch(client, w1)
            await ra.w2_insert_batches(client, w2_copy + w2_multi)
            ok = await ra.w3_update_status(client, target["id"], new_status, 1)
            stale = await ra.w3_update_status(client, target["id"], new_status, 1)
            deleted = await ra.d1_delete_batch(client, victim)
            again = await ra.d1_delete_batch(client, victim)
            removed = await ra.d2_delete_tests_due_before(client, cutoff)
            return ok, stale, deleted, again, removed
        finally:
            await client.aclose()

    pg_res = asyncio.run(pg_side())
    redis_res = asyncio.run(redis_side())
    assert pg_res[:4] == redis_res[:4] == (True, False, True, False)
    assert pg_res[4] == redis_res[4] > 0

    for b in [w1] + w2_copy + w2_multi:
        pg_b, r_b = pgq.r1_batch_by_id(pg_conn, b["id"]), rq.r1_batch_by_id(r, b["id"])
        assert pg_b is not None and r_b is not None
        assert (pg_b["public_code"], pg_b["status"]) == (r_b["public_code"], r_b["status"]) == (b["public_code"], b["status"])
    for fn in (pgq.r1_batch_by_id,):
        assert fn(pg_conn, target["id"])["version"] == 2
    assert rq.r1_batch_by_id(r, target["id"])["version"] == 2
    assert pgq.r1_batch_by_id(pg_conn, victim) is None and rq.r1_batch_by_id(r, victim) is None
    assert pgq.r6_status_counts(pg_conn, target["holder_org_id"]) == rq.r6_status_counts(r, target["holder_org_id"])
    assert_redis_invariants(r)
