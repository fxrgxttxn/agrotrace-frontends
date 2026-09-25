"""Loads the same small generated dataset into both PostgreSQL and Redis, then checks that every
entity, edge and Redis secondary index is consistent with the data (spec §13.4 "тесты:
эквивалентность данных" and Review Focus 2: secondary indexes stay consistent with the data).
Needs a running stand (`./at.sh bench up`).
"""
from __future__ import annotations

import os
from collections import Counter, defaultdict

import psycopg
import pytest
import redis

from agrobench import load_pg, load_redis, redis_keys
from agrobench.generate import generate, write_csv

SCALE = 300
SEED = 7


@pytest.fixture(scope="module")
def dataset(tmp_path_factory):
    data_dir = tmp_path_factory.mktemp("bench-data")
    result = generate(SCALE, SEED)
    write_csv(result.organizations, data_dir / "organizations.csv")
    write_csv(result.batches, data_dir / "batches.csv")
    write_csv(result.batch_links, data_dir / "batch_links.csv")
    write_csv(result.lab_tests, data_dir / "lab_tests.csv")
    load_pg.load(data_dir)
    load_redis.load(data_dir)
    return result


def _pg_connect():
    return psycopg.connect(connect_timeout=5)


def _redis_client():
    return redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True, socket_connect_timeout=5)


def test_organization_count_and_fields_match(dataset):
    r = _redis_client()
    with _pg_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM organizations")
        assert cur.fetchone()[0] == len(dataset.organizations)

    for org in dataset.organizations:
        h = r.hgetall(redis_keys.org_key(org["id"]))
        assert h["type"] == org["type"]
        assert h["name"] == org["name"]
        assert h["inn"] == org["inn"]
        assert h["region_code"] == org["region_code"]
        if org["trust_rating"] != "":
            assert h["trust_rating"] == str(org["trust_rating"])
        else:
            assert "trust_rating" not in h


def test_batch_set_matches_between_pg_and_redis(dataset):
    r = _redis_client()
    with _pg_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, public_code, status, holder_org_id FROM batches")
        pg_rows = {row[0]: row for row in cur.fetchall()}

    assert set(pg_rows) == {b["id"] for b in dataset.batches}
    for batch in dataset.batches:
        bid = batch["id"]
        pg_row = pg_rows[bid]
        assert pg_row[1] == batch["public_code"]
        assert pg_row[2] == batch["status"]
        assert pg_row[3] == batch["holder_org_id"]

        h = r.hgetall(redis_keys.batch_key(bid))
        assert h["public_code"] == batch["public_code"]
        assert h["status"] == batch["status"]
        assert int(h["holder_org_id"]) == batch["holder_org_id"]
        assert r.get(redis_keys.batch_code_key(batch["public_code"])) == str(bid)


def test_batch_link_edges_match_between_pg_and_redis(dataset):
    r = _redis_client()
    with _pg_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT parent_id, child_id FROM batch_links")
        pg_edges = set(cur.fetchall())

    gen_edges = {(link["parent_id"], link["child_id"]) for link in dataset.batch_links}
    assert pg_edges == gen_edges

    for link in dataset.batch_links:
        parent_id, child_id = link["parent_id"], link["child_id"]
        assert r.sismember(redis_keys.batch_children_key(parent_id), str(child_id))
        assert r.sismember(redis_keys.batch_parents_key(child_id), str(parent_id))
        h = r.hgetall(redis_keys.link_key(parent_id, child_id))
        assert h["link_type"] == link["link_type"]


def test_children_and_parents_sets_have_no_extra_members(dataset):
    r = _redis_client()
    children: dict[int, set[str]] = defaultdict(set)
    parents: dict[int, set[str]] = defaultdict(set)
    for link in dataset.batch_links:
        children[link["parent_id"]].add(str(link["child_id"]))
        parents[link["child_id"]].add(str(link["parent_id"]))

    for batch in dataset.batches:
        bid = batch["id"]
        assert r.smembers(redis_keys.batch_children_key(bid)) == children.get(bid, set())
        assert r.smembers(redis_keys.batch_parents_key(bid)) == parents.get(bid, set())


def test_held_zsets_match_holder_batches(dataset):
    r = _redis_client()
    by_holder: dict[int, set[int]] = defaultdict(set)
    by_holder_status: dict[tuple[int, str], set[int]] = defaultdict(set)
    for b in dataset.batches:
        by_holder[b["holder_org_id"]].add(b["id"])
        by_holder_status[(b["holder_org_id"], b["status"])].add(b["id"])

    for holder_id, ids in by_holder.items():
        members = {int(m) for m in r.zrange(redis_keys.org_held_key(holder_id), 0, -1)}
        assert members == ids
    for (holder_id, status), ids in by_holder_status.items():
        members = {int(m) for m in r.zrange(redis_keys.org_held_status_key(holder_id, status), 0, -1)}
        assert members == ids


def test_stats_hash_matches_status_counts(dataset):
    r = _redis_client()
    counts: dict[int, Counter] = defaultdict(Counter)
    for b in dataset.batches:
        counts[b["holder_org_id"]][b["status"]] += 1

    with _pg_connect() as conn, conn.cursor() as cur:
        for holder_id, status_counts in counts.items():
            stats = r.hgetall(redis_keys.stats_org_key(holder_id))
            for status, n in status_counts.items():
                assert int(stats.get(status, 0)) == n, f"org {holder_id} status {status}"

            cur.execute(
                "SELECT status, count(*) FROM batches WHERE holder_org_id = %s GROUP BY status",
                (holder_id,),
            )
            pg_counts = dict(cur.fetchall())
            assert pg_counts == dict(status_counts)


def test_lab_tests_equivalent(dataset):
    r = _redis_client()
    with _pg_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, batch_id, conclusion FROM lab_tests")
        pg_rows = {row[0]: row for row in cur.fetchall()}

    assert set(pg_rows) == {t["id"] for t in dataset.lab_tests}
    tests_by_batch: dict[int, list[str]] = defaultdict(list)
    for test in dataset.lab_tests:
        tid = test["id"]
        pg_row = pg_rows[tid]
        assert pg_row[1] == test["batch_id"]
        assert pg_row[2] == test["conclusion"]

        h = r.hgetall(redis_keys.test_key(tid))
        assert h["conclusion"] == test["conclusion"]
        assert int(h["batch_id"]) == test["batch_id"]
        assert r.zscore(redis_keys.tests_by_due_key(), str(tid)) is not None
        tests_by_batch[test["batch_id"]].append(str(tid))

    for batch_id, ids in tests_by_batch.items():
        listed = r.lrange(redis_keys.batch_tests_key(batch_id), 0, -1)
        assert set(listed) == set(ids)
