"""Workload tests (Task 4): deterministic key sequences (uniform and Zipf 1.1 — identical for both
DBMS by construction), prepared-record invariants, and — against the live stand — that every
write/delete series leaves both DBMS holding exactly the dataset they held before (row/key counts
and a full-content checksum), that the restore check itself catches a leftover change, and that
the live settings capture reports what the profile says.

The integration part loads a --scale 500 dataset into both DBMS (like the other stand tests), so
it needs `./at.sh bench up` and overwrites whatever was loaded before.
"""
from __future__ import annotations

import asyncio
import os
from collections import Counter
from datetime import datetime

import numpy as np
import psycopg
import pytest
import redis

from agrobench import load_pg, load_redis, run
from agrobench.generate import generate, write_csv
from agrobench.workload import (
    PREP_ID_BASE, Allocator, DatasetNotRestored, PgFixtures, Prepared, RedisFixtures, RestoreGuard,
    load_dataset, prepared_batches, prepared_copies, prepared_due_group, read_args, stable_seed,
    uniform_indices, zipf_indices, zipf_probabilities,
)

SCALE = 500
SEED = 777


@pytest.fixture(scope="module")
def data_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("bench-data-workload")
    result = generate(SCALE, SEED)
    write_csv(result.organizations, d / "organizations.csv")
    write_csv(result.batches, d / "batches.csv")
    write_csv(result.batch_links, d / "batch_links.csv")
    write_csv(result.lab_tests, d / "lab_tests.csv")
    return d


@pytest.fixture(scope="module")
def dataset(data_dir):
    return load_dataset(data_dir)


# ---------------------------------------------------------------------------------------------
# Key sequences (pure)
# ---------------------------------------------------------------------------------------------

def test_zipf_generator_is_deterministic_for_a_seed():
    a = zipf_indices(1000, 5000, seed=11, perm_seed=3)
    b = zipf_indices(1000, 5000, seed=11, perm_seed=3)
    c = zipf_indices(1000, 5000, seed=12, perm_seed=3)
    assert np.array_equal(a, b)
    assert not np.array_equal(a, c)
    assert a.min() >= 0 and a.max() < 1000


def test_zipf_is_skewed_as_zipf_1_1():
    n, size = 1000, 200_000
    idx = zipf_indices(n, size, seed=5, perm_seed=9)
    counts = Counter(idx.tolist())
    hottest_key, hottest_count = counts.most_common(1)[0]
    p1 = zipf_probabilities(n)[0]  # P(rank 1) for s=1.1, n=1000 -> about 0.16
    assert hottest_count / size == pytest.approx(p1, rel=0.05)
    # the permutation decides *which* key is hot: rank 0 maps to perm[0]
    assert hottest_key == np.random.default_rng(9).permutation(n)[0]
    # vs uniform, where no key gets anywhere near that share
    u = Counter(uniform_indices(n, size, seed=5).tolist())
    assert u.most_common(1)[0][1] / size < 0.01


def test_uniform_generator_is_deterministic_and_in_range():
    a = uniform_indices(50, 1000, seed=1)
    assert np.array_equal(a, uniform_indices(50, 1000, seed=1))
    assert a.min() >= 0 and a.max() < 50
    assert len(set(a.tolist())) == 50  # 1000 draws over 50 keys hit all of them


def test_stable_seed_is_stable_and_distinguishes_parts():
    assert stable_seed("R1", "zipf", "measure") == stable_seed("R1", "zipf", "measure")
    assert stable_seed("R1", "zipf", "measure") != stable_seed("R1", "zipf", "warmup")
    assert stable_seed("R1", "uniform") != stable_seed("R2", "uniform")


@pytest.mark.parametrize("query", ["R1", "R2", "R3", "R4", "R5", "R6"])
@pytest.mark.parametrize("distribution", ["uniform", "zipf"])
def test_read_args_are_reproducible_and_valid(dataset, data_dir, query, distribution):
    a = read_args(dataset, query, distribution, 2000, "measure")
    # A second, independently loaded copy of the same CSVs gives the same sequence: the sequence
    # is a function of the data only — it has no DBMS input at all.
    b = read_args(load_dataset(data_dir), query, distribution, 2000, "measure")
    assert a == b and len(a) == 2000
    assert read_args(dataset, query, distribution, 2000, "warmup") != a
    ids = {int(x["id"]) for x in dataset.batches}
    codes = {x["public_code"] for x in dataset.batches}
    pairs = {(int(x["holder_org_id"]), x["status"]) for x in dataset.batches}
    for args in a[:200]:
        if query in ("R1", "R4", "R5"):
            assert args[0] in ids
        elif query == "R2":
            assert args[0] in codes
        elif query == "R3":
            assert args in pairs
        else:
            assert args[0] in {p[0] for p in pairs}


def test_zipf_hot_key_is_shared_by_warmup_and_measurement(dataset):
    warm = Counter(read_args(dataset, "R1", "zipf", 5000, "warmup"))
    meas = Counter(read_args(dataset, "R1", "zipf", 5000, "measure"))
    assert warm.most_common(1)[0][0] == meas.most_common(1)[0][0]


# ---------------------------------------------------------------------------------------------
# Prepared records (pure)
# ---------------------------------------------------------------------------------------------

def test_prepared_records_never_collide_with_the_main_set(dataset):
    alloc = Allocator(dataset)
    a = prepared_batches(dataset, alloc, 300, seed=1)
    b = prepared_copies(dataset, alloc, 300, seed=2)
    ids = [x["id"] for x in a + b.batches]
    assert len(set(ids)) == len(ids) and min(ids) >= PREP_ID_BASE
    max_main = dataset.max_harvested_at()
    stamps = [x["harvested_at"] for x in a + b.batches]
    assert len(set(stamps)) == len(stamps)
    assert all(datetime.fromisoformat(s) > max_main for s in stamps)
    main_codes = {x["public_code"] for x in dataset.batches}
    assert not main_codes & {x["public_code"] for x in a + b.batches}
    # D1 copies carry their source's parent edges and tests, re-pointed at the copy
    assert b.links and b.tests
    copy_ids = {x["id"] for x in b.batches}
    assert all(link["child_id"] in copy_ids for link in b.links)
    assert all(t["batch_id"] in copy_ids and t["id"] >= PREP_ID_BASE for t in b.tests)


def test_prepared_due_groups_precede_every_real_test_and_cut_exactly(dataset):
    alloc = Allocator(dataset)
    g1, cut1 = prepared_due_group(dataset, alloc, 1000, seed=1)
    g2, cut2 = prepared_due_group(dataset, alloc, 1000, seed=2)
    min_real = dataset.min_due_at()
    assert cut1 < cut2 < min_real
    assert all(datetime.fromisoformat(t["due_at"]) < cut1 for t in g1)
    assert all(cut1 <= datetime.fromisoformat(t["due_at"]) < cut2 for t in g2)


# ---------------------------------------------------------------------------------------------
# Integration: restore equality, restore check, settings capture (needs the stand)
# ---------------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def loaded(data_dir, dataset):
    load_pg.load(data_dir)
    load_redis.load(data_dir)
    return dataset


def _profiles() -> dict:
    return {
        "pg_profile": os.environ["PG_PROFILE"], "redis_profile": os.environ["REDIS_PROFILE"],
        "durability": os.environ["DURABILITY"],
    }


def _live() -> dict:
    with psycopg.connect() as conn:
        pg_live = run.capture_pg_settings(conn)
    r = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    redis_live = run.capture_redis_settings(r)
    r.close()
    return {"pg": pg_live, "redis": redis_live}


def _pg_sizes() -> dict:
    with psycopg.connect() as conn, conn.cursor() as cur:
        out = {}
        for t in ("organizations", "batches", "batch_links", "lab_tests"):
            cur.execute(f"SELECT count(*) FROM {t}")
            out[t] = cur.fetchone()[0]
        return out


def _redis_sizes() -> dict:
    r = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    try:
        return {"dbsize": r.dbsize(), "tests_by_due": r.zcard("tests:by_due")}
    finally:
        r.close()


TINY = run.Sizes(runs=1, warmup=160, reads=20, write_warmup=160, writes=40, writes_c16=200,
                 w2_warmup=2, w2_ops=2, w2_size=300, d2_warmup=2, d2_ops=5, d2_size=50)


@pytest.mark.parametrize("dbms", ["pg", "redis"])
def test_every_write_delete_series_restores_the_dataset(loaded, tmp_path, dbms):
    fx = PgFixtures() if dbms == "pg" else RedisFixtures()
    sizes_fn = _pg_sizes if dbms == "pg" else _redis_sizes
    before_fp, before_sizes = fx.fingerprint(), sizes_fn()
    runner = run.Runner(loaded, TINY, tmp_path, profiles=_profiles(), dbms_list=[dbms], log=lambda _m: None)
    runner.live = _live()
    asyncio.run(runner.run_dbms(dbms, 1, {"W1", "W2", "W3", "D1", "D2"}))
    assert fx.fingerprint() == before_fp
    assert sizes_fn() == before_sizes
    fx.close()
    measured = {(r["query"], r["variant"], r["concurrency"]) for r in runner.rows}
    w2 = {"pg": {("W2", "copy", 1), ("W2", "multirow", 1)}, "redis": {("W2", "pipeline", 1)}}[dbms]
    assert measured == {("W1", "base", 1), ("W1", "base", 16), ("W3", "base", 1), ("W3", "base", 16),
                        ("D1", "base", 1), ("D1", "base", 16), ("D2", "base", 1)} | w2
    for r in runner.rows:
        assert r["restored"] == "verified" and r["failures"] == 0
        assert r["n"] == {"W2": 2, "D2": 5}.get(r["query"], 40 if r["concurrency"] == 1 else 200)
        assert r["effective_concurrency"] == pytest.approx(r["mean_us"] * 1e-6 * r["ops_s"], rel=1e-2, abs=1e-2)


@pytest.mark.parametrize("dbms", ["pg", "redis"])
def test_restore_guard_catches_a_change_to_the_main_set(loaded, dbms):
    fx = PgFixtures() if dbms == "pg" else RedisFixtures()
    alloc = Allocator(loaded)
    prep = Prepared(batches=prepared_batches(loaded, alloc, 3, seed=1))
    target = loaded.batches[0]
    with pytest.raises(DatasetNotRestored):
        with RestoreGuard(fx, prep):
            fx.insert(prep)
            _bump_version(dbms, int(target["id"]), +1)  # a change cleanup knows nothing about
    _bump_version(dbms, int(target["id"]), -1)  # undo, and the dataset is whole again
    with RestoreGuard(fx, prep):
        fx.insert(prep)
    fx.close()


def _bump_version(dbms: str, batch_id: int, delta: int) -> None:
    if dbms == "pg":
        with psycopg.connect(autocommit=True) as conn:
            conn.execute("UPDATE batches SET version = version + %s WHERE id = %s", (delta, batch_id))
    else:
        r = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
        r.hincrby(f"batch:{batch_id}", "version", delta)
        r.close()


def test_settings_capture_matches_the_live_profile_and_rejects_a_mismatch():
    p = _profiles()
    live = _live()
    pg_report = run.verify_settings("pg", live["pg"], p["pg_profile"], p["durability"])
    redis_report = run.verify_settings("redis", live["redis"], p["redis_profile"], p["durability"])
    assert pg_report["synchronous_commit"]["matches"] is True
    assert redis_report["appendfsync"]["matches"] is True
    assert run.live_durability("pg", live["pg"]).startswith(f"synchronous_commit={live['pg']['synchronous_commit']}")
    assert f"appendfsync={live['redis']['appendfsync']}" in run.live_durability("redis", live["redis"])
    tampered = dict(live["pg"], synchronous_commit="local")
    with pytest.raises(RuntimeError, match="synchronous_commit"):
        run.verify_settings("pg", tampered, p["pg_profile"], p["durability"])
    tampered = dict(live["redis"], appendfsync="no")
    with pytest.raises(RuntimeError, match="appendfsync"):
        run.verify_settings("redis", tampered, p["redis_profile"], p["durability"])


async def _backend_pid(conn):
    cur = await conn.execute("SELECT pg_backend_pid()")
    return (await cur.fetchone())[0]


def test_pg_concurrency_1_warm_up_and_series_share_one_backend(loaded):
    """Ruling B6 against the real FIFO pool of 16: warm-up and every measured call (and every call
    of a pinned W2/D2-style loop) run on one and the same PostgreSQL backend."""
    from agrobench.measure import measure

    async def body():
        side = run.PgSide()
        await side.open()
        try:
            res_pids = []
            res = await measure(_backend_pid, [()] * 200, acquire=side.acquire, method=None,
                                warm_args=[()] * 20, min_warm_per_client=10,
                                check=lambda pid, _a: res_pids.append(pid) or True)
            pinned = []
            async with side.pin() as acquire:
                for _ in range(20):
                    r = await measure(_backend_pid, [()], acquire=acquire,
                                      check=lambda pid, _a: pinned.append(pid) or True)
                    assert r.ops == 1
            return res, res_pids, pinned
        finally:
            await side.close()

    res, pids, pinned = asyncio.run(body())
    assert len(set(pids)) == 1 and len(pids) == 220  # 20 warm-up + 200 measured, one backend
    assert len(set(pinned)) == 1
    assert res.ops == 200
