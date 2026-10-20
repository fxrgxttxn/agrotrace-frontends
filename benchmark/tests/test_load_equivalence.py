"""Loads the same small generated dataset into both PostgreSQL and Redis, then checks FULL
content equivalence: every attribute of every entity, every edge, exact sorted-set scores, and
every Redis secondary index (spec §13.4 "тесты: эквивалентность данных"; Review Focus 2:
secondary indexes stay consistent with the data). Needs a running stand (`./at.sh bench up`).

These tests deliberately compare *values*, not just key/member presence: an earlier version only
checked a handful of fields and set membership, which a mutation review proved missed a wrong
mass_kg written to Redis and a held/held:status score zeroed out at load time (both still passed
27/27). Every test below is written so those two specific mutations fail it -- see
task-1-2-report.md's "Fix round 1" section for the RED/GREEN evidence.
"""
from __future__ import annotations

import os
from collections import Counter, defaultdict
from datetime import datetime
from decimal import Decimal

import psycopg
import pytest
import redis

from agrobench import load_pg, load_redis, redis_keys
from agrobench.generate import generate, write_csv

SCALE = 300
SEED = 7
SCORE_TOLERANCE = 1e-6


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


def _dt(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def _pg_rows_by_id(cur, sql: str, id_index: int = 0) -> dict:
    cur.execute(sql)
    columns = [d.name for d in cur.description]
    return {row[id_index]: dict(zip(columns, row)) for row in cur.fetchall()}


def test_organization_full_content_matches_between_pg_and_redis(dataset):
    r = _redis_client()
    with _pg_connect() as conn, conn.cursor() as cur:
        pg_rows = _pg_rows_by_id(
            cur, "SELECT id, type, name, inn, region_code, trust_rating, created_at FROM organizations"
        )

    assert set(pg_rows) == {o["id"] for o in dataset.organizations}
    for org in dataset.organizations:
        oid = org["id"]
        expected_trust = org["trust_rating"] if org["trust_rating"] != "" else None

        pg_row = pg_rows[oid]
        assert pg_row["type"] == org["type"]
        assert pg_row["name"] == org["name"]
        assert pg_row["inn"] == org["inn"]
        assert pg_row["region_code"] == org["region_code"]
        assert pg_row["trust_rating"] == expected_trust
        assert pg_row["created_at"] == _dt(org["created_at"])

        h = r.hgetall(redis_keys.org_key(oid))
        assert h["type"] == org["type"]
        assert h["name"] == org["name"]
        assert h["inn"] == org["inn"]
        assert h["region_code"] == org["region_code"]
        assert _dt(h["created_at"]) == _dt(org["created_at"])
        if expected_trust is not None:
            assert int(h["trust_rating"]) == expected_trust
        else:
            assert "trust_rating" not in h


def test_batch_full_content_matches_between_pg_and_redis(dataset):
    r = _redis_client()
    with _pg_connect() as conn, conn.cursor() as cur:
        pg_rows = _pg_rows_by_id(
            cur,
            "SELECT id, public_code, product, origin_org_id, holder_org_id, kind, mass_kg, "
            "status, harvested_at, version FROM batches",
        )

    assert set(pg_rows) == {b["id"] for b in dataset.batches}
    for batch in dataset.batches:
        bid = batch["id"]
        expected_mass = Decimal(str(batch["mass_kg"]))

        pg_row = pg_rows[bid]
        assert pg_row["public_code"] == batch["public_code"]
        assert pg_row["product"] == batch["product"]
        assert pg_row["origin_org_id"] == batch["origin_org_id"]
        assert pg_row["holder_org_id"] == batch["holder_org_id"]
        assert pg_row["kind"] == batch["kind"]
        assert pg_row["mass_kg"] == expected_mass
        assert pg_row["status"] == batch["status"]
        assert pg_row["harvested_at"] == _dt(batch["harvested_at"])
        assert pg_row["version"] == batch["version"]

        h = r.hgetall(redis_keys.batch_key(bid))
        assert h["public_code"] == batch["public_code"]
        assert h["product"] == batch["product"]
        assert int(h["origin_org_id"]) == batch["origin_org_id"]
        assert int(h["holder_org_id"]) == batch["holder_org_id"]
        assert h["kind"] == batch["kind"]
        assert Decimal(h["mass_kg"]) == expected_mass, f"batch {bid}: Redis mass_kg does not match PostgreSQL/source"
        assert h["status"] == batch["status"]
        assert _dt(h["harvested_at"]) == _dt(batch["harvested_at"])
        assert int(h["version"]) == batch["version"]
        assert r.get(redis_keys.batch_code_key(batch["public_code"])) == str(bid)


def test_batch_link_full_content_matches_between_pg_and_redis(dataset):
    r = _redis_client()
    with _pg_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT parent_id, child_id, mass_used_kg, link_type, created_at FROM batch_links")
        columns = [d.name for d in cur.description]
        pg_rows = {(row[0], row[1]): dict(zip(columns, row)) for row in cur.fetchall()}

    gen_edges = {(link["parent_id"], link["child_id"]): link for link in dataset.batch_links}
    assert set(pg_rows) == set(gen_edges)

    for (parent_id, child_id), link in gen_edges.items():
        expected_mass = Decimal(str(link["mass_used_kg"]))

        pg_row = pg_rows[(parent_id, child_id)]
        assert pg_row["mass_used_kg"] == expected_mass
        assert pg_row["link_type"] == link["link_type"]
        assert pg_row["created_at"] == _dt(link["created_at"])

        h = r.hgetall(redis_keys.link_key(parent_id, child_id))
        assert Decimal(h["mass_used_kg"]) == expected_mass
        assert h["link_type"] == link["link_type"]
        assert _dt(h["created_at"]) == _dt(link["created_at"])

        assert r.sismember(redis_keys.batch_children_key(parent_id), str(child_id))
        assert r.sismember(redis_keys.batch_parents_key(child_id), str(parent_id))


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


def test_held_zsets_have_exact_scores(dataset):
    r = _redis_client()
    expected_held: dict[int, dict[int, float]] = defaultdict(dict)
    expected_held_status: dict[tuple[int, str], dict[int, float]] = defaultdict(dict)
    for b in dataset.batches:
        score = redis_keys.to_score(b["harvested_at"])
        expected_held[b["holder_org_id"]][b["id"]] = score
        expected_held_status[(b["holder_org_id"], b["status"])][b["id"]] = score

    for holder_id, expected in expected_held.items():
        actual = {int(m): s for m, s in r.zrange(redis_keys.org_held_key(holder_id), 0, -1, withscores=True)}
        assert actual.keys() == expected.keys(), f"org {holder_id}: held membership mismatch"
        for bid, expected_score in expected.items():
            assert actual[bid] == pytest.approx(expected_score, abs=SCORE_TOLERANCE), (
                f"org {holder_id} held score for batch {bid}: expected {expected_score}, got {actual[bid]}"
            )

    for (holder_id, status), expected in expected_held_status.items():
        key = redis_keys.org_held_status_key(holder_id, status)
        actual = {int(m): s for m, s in r.zrange(key, 0, -1, withscores=True)}
        assert actual.keys() == expected.keys(), f"org {holder_id} status {status}: membership mismatch"
        for bid, expected_score in expected.items():
            assert actual[bid] == pytest.approx(expected_score, abs=SCORE_TOLERANCE), (
                f"org {holder_id} status {status} score for batch {bid}: expected {expected_score}, got {actual[bid]}"
            )


def test_tests_by_due_zset_has_exact_scores(dataset):
    r = _redis_client()
    expected = {t["id"]: redis_keys.to_score(t["due_at"]) for t in dataset.lab_tests}
    actual = {int(m): s for m, s in r.zrange(redis_keys.tests_by_due_key(), 0, -1, withscores=True)}
    assert actual.keys() == expected.keys()
    for tid, expected_score in expected.items():
        assert actual[tid] == pytest.approx(expected_score, abs=SCORE_TOLERANCE), (
            f"tests:by_due score for test {tid}: expected {expected_score}, got {actual[tid]}"
        )


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


def test_lab_test_full_content_matches_between_pg_and_redis(dataset):
    r = _redis_client()
    with _pg_connect() as conn, conn.cursor() as cur:
        pg_rows = _pg_rows_by_id(
            cur, "SELECT id, batch_id, lab_org_id, reason, conclusion, value, due_at FROM lab_tests"
        )

    assert set(pg_rows) == {t["id"] for t in dataset.lab_tests}
    tests_by_batch: dict[int, list[str]] = defaultdict(list)
    for test in dataset.lab_tests:
        tid = test["id"]
        expected_value = Decimal(str(test["value"]))

        pg_row = pg_rows[tid]
        assert pg_row["batch_id"] == test["batch_id"]
        assert pg_row["lab_org_id"] == test["lab_org_id"]
        assert pg_row["reason"] == test["reason"]
        assert pg_row["conclusion"] == test["conclusion"]
        assert pg_row["value"] == expected_value
        assert pg_row["due_at"] == _dt(test["due_at"])

        h = r.hgetall(redis_keys.test_key(tid))
        assert int(h["batch_id"]) == test["batch_id"]
        assert int(h["lab_org_id"]) == test["lab_org_id"]
        assert h["reason"] == test["reason"]
        assert h["conclusion"] == test["conclusion"]
        assert Decimal(h["value"]) == expected_value
        assert _dt(h["due_at"]) == _dt(test["due_at"])

        tests_by_batch[test["batch_id"]].append(str(tid))

    for batch_id, ids in tests_by_batch.items():
        listed = r.lrange(redis_keys.batch_tests_key(batch_id), 0, -1)
        assert set(listed) == set(ids)
