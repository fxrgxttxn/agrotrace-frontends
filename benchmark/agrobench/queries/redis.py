"""Redis implementations of queries R1-R6, W1-W3, D1-D2 (spec §13.5, schema §13.3).

Same function names/signatures as agrobench.queries.pg — Task 4 wraps both for the measurement
harness, treating `conn` as an opaque handle (a psycopg Connection there, a `redis.Redis` client
here, built with `decode_responses=True` like every other client in this codebase — see
load_redis.py). "One call = one logical query" means one Redis round trip wherever the operation
genuinely needs only one; multi-step reads (R4) use the fewest pipelined round trips the
dependency chain allows (you need the batch's holder_org_id before you can fetch the holder), and
writes/deletes that must keep every secondary structure consistent (W1, W3, D1 — spec §13.3
"поддерживаются приложением атомарно") use MULTI/EXEC or a Lua script, never several independent
round trips that could leave the data half-updated if the process died in between.

R5 ships two variants (spec §13.5): `r5_descendants` (BFS in Python, one pipelined SMEMBERS round
trip per graph level) and `r5_descendants_lua` (the same BFS run server-side in one round trip).
Both cap traversal at `max_depth` (default 20, matching PostgreSQL's `WHERE d.depth < 20`) and
return a *set* of descendant ids — a DAG's shared descendants must appear exactly once regardless
of how many paths reach them.
"""
from __future__ import annotations

from pathlib import Path

from agrobench import redis_keys

_LUA_DIR = Path(__file__).resolve().parent / "lua"
_R5_LUA = (_LUA_DIR / "r5_descendants.lua").read_text(encoding="utf-8")
_W3_LUA = (_LUA_DIR / "w3_update_status.lua").read_text(encoding="utf-8")
_D1_LUA = (_LUA_DIR / "d1_delete_batch.lua").read_text(encoding="utf-8")

BATCH_FIELDS = [
    "public_code", "product", "origin_org_id", "holder_org_id", "kind", "mass_kg", "status",
    "harvested_at", "version",
]
_BATCH_INT_FIELDS = {"origin_org_id", "holder_org_id", "version"}

ORG_FIELDS = ["type", "name", "inn", "region_code", "created_at"]
TEST_FIELDS = ["batch_id", "lab_org_id", "reason", "conclusion", "value", "due_at"]
_TEST_INT_FIELDS = {"batch_id", "lab_org_id"}

# W2's pipeline flush size and D2's per-chunk delete size (spec §13.4/§13.5: "пачками по 1000").
CHUNK = 1000


def _batch_from_hash(batch_id, h: dict) -> dict | None:
    if not h:
        return None
    batch = {"id": int(batch_id)}
    for field in BATCH_FIELDS:
        batch[field] = int(h[field]) if field in _BATCH_INT_FIELDS else h[field]
    return batch


def _org_from_hash(org_id, h: dict) -> dict | None:
    if not h:
        return None
    org = {"id": int(org_id), **{f: h[f] for f in ORG_FIELDS}}
    org["trust_rating"] = int(h["trust_rating"]) if "trust_rating" in h else None
    return org


def _test_from_hash(test_id, h: dict) -> dict | None:
    if not h:
        return None
    test = {"id": int(test_id)}
    for field in TEST_FIELDS:
        test[field] = int(h[field]) if field in _TEST_INT_FIELDS else h[field]
    return test


def r1_batch_by_id(conn, batch_id) -> dict | None:
    return _batch_from_hash(batch_id, conn.hgetall(redis_keys.batch_key(batch_id)))


def r2_batch_by_code(conn, public_code: str) -> dict | None:
    batch_id = conn.get(redis_keys.batch_code_key(public_code))
    if batch_id is None:
        return None
    return _batch_from_hash(batch_id, conn.hgetall(redis_keys.batch_key(batch_id)))


def r3_holder_batches_by_status(conn, holder_org_id, status: str, limit: int = 50) -> list[dict]:
    ids = conn.zrevrange(redis_keys.org_held_status_key(holder_org_id, status), 0, limit - 1)
    if not ids:
        return []
    pipe = conn.pipeline(transaction=False)
    for bid in ids:
        pipe.hgetall(redis_keys.batch_key(bid))
    hashes = pipe.execute()
    result = []
    for bid, h in zip(ids, hashes):
        batch = _batch_from_hash(bid, h)
        if batch is not None:
            result.append(batch)
    return result


def r4_batch_with_holder_and_tests(conn, batch_id) -> dict | None:
    """batch + its holder + its lab tests, in the two round trips the dependency chain allows:
    batch hash and its tests-id list need only the given id (fetched together); the holder and
    the tests themselves need what the first round trip returns (spec §13.5)."""
    pipe = conn.pipeline(transaction=False)
    pipe.hgetall(redis_keys.batch_key(batch_id))
    pipe.lrange(redis_keys.batch_tests_key(batch_id), 0, -1)
    batch_hash, test_ids = pipe.execute()
    batch = _batch_from_hash(batch_id, batch_hash)
    if batch is None:
        return None

    pipe = conn.pipeline(transaction=False)
    pipe.hgetall(redis_keys.org_key(batch["holder_org_id"]))
    for tid in test_ids:
        pipe.hgetall(redis_keys.test_key(tid))
    results = pipe.execute()
    holder = _org_from_hash(batch["holder_org_id"], results[0])
    tests = []
    for tid, h in zip(test_ids, results[1:]):
        test = _test_from_hash(tid, h)
        if test is not None:
            tests.append(test)
    return {"batch": batch, "holder": holder, "tests": tests}


def r5_descendants(conn, batch_id, max_depth: int = 20) -> set[int]:
    """Variant 1 (spec §13.5): BFS by levels in Python, one pipelined `SMEMBERS` round trip per
    level — at most `max_depth` round trips total, regardless of how wide the graph is."""
    start = str(batch_id)
    visited: set[str] = {start}
    frontier = [start]
    depth = 0
    while frontier and depth < max_depth:
        pipe = conn.pipeline(transaction=False)
        for bid in frontier:
            pipe.smembers(redis_keys.batch_children_key(bid))
        levels = pipe.execute()
        next_frontier: list[str] = []
        for children in levels:
            for child in children:
                if child not in visited:
                    visited.add(child)
                    next_frontier.append(child)
        frontier = next_frontier
        depth += 1
    visited.discard(start)
    return {int(x) for x in visited}


def r5_descendants_lua(conn, batch_id, max_depth: int = 20) -> set[int]:
    """Variant 2 (spec §13.5): the same BFS run server-side in one round trip."""
    result = conn.eval(_R5_LUA, 0, str(batch_id), str(max_depth))
    return {int(x) for x in result}


def r6_status_counts(conn, org_id) -> dict[str, int]:
    h = conn.hgetall(redis_keys.stats_org_key(org_id))
    return {status: int(count) for status, count in h.items() if int(count) != 0}


def _batch_hset_fields(batch: dict) -> dict:
    return {
        "public_code": batch["public_code"],
        "product": batch["product"],
        "origin_org_id": batch["origin_org_id"],
        "holder_org_id": batch["holder_org_id"],
        "kind": batch["kind"],
        "mass_kg": str(batch["mass_kg"]),
        "status": batch["status"],
        "harvested_at": batch["harvested_at"],
        "version": batch.get("version", 1),
    }


def _queue_w1(pipe, batch: dict) -> None:
    bid = batch["id"]
    score = redis_keys.to_score(batch["harvested_at"])
    pipe.hset(redis_keys.batch_key(bid), mapping=_batch_hset_fields(batch))
    pipe.set(redis_keys.batch_code_key(batch["public_code"]), bid)
    pipe.zadd(redis_keys.org_held_key(batch["holder_org_id"]), {bid: score})
    pipe.zadd(redis_keys.org_held_status_key(batch["holder_org_id"], batch["status"]), {bid: score})
    pipe.hincrby(redis_keys.stats_org_key(batch["holder_org_id"]), batch["status"], 1)


def w1_insert_batch(conn, batch: dict) -> None:
    """`MULTI`: hash + code index + both zsets + stats counter, atomically (spec §13.5)."""
    pipe = conn.pipeline(transaction=True)
    _queue_w1(pipe, batch)
    pipe.execute()


def w2_insert_batches(conn, batches: list[dict]) -> None:
    """Pipeline of W1s (spec §13.5). Not one MULTI over the whole batch: that would serialize
    thousands of writes behind a single transaction for no correctness benefit here (every batch
    gets a fresh id nothing else touches concurrently) and is not what "pipeline of W1s" asks for;
    flushed every CHUNK commands like load_redis.py's bulk loader."""
    pipe = conn.pipeline(transaction=False)
    pending = 0
    for batch in batches:
        _queue_w1(pipe, batch)
        pending += 1
        if pending >= CHUNK:
            pipe.execute()
            pending = 0
    if pending:
        pipe.execute()


def w3_update_status(conn, batch_id, new_status: str, expected_version: int) -> bool:
    """Lua: version check, `HSET`, move between held:status zsets, `HINCRBY` stats (spec §13.5)."""
    return bool(conn.eval(_W3_LUA, 0, str(batch_id), new_status, str(expected_version)))


def d1_delete_batch(conn, batch_id) -> bool:
    """Lua: delete the hash, every index, every neighbour's edge back, and every lab test on this
    batch (spec §13.5)."""
    return bool(conn.eval(_D1_LUA, 0, str(batch_id)))


def d2_delete_tests_due_before(conn, due_before) -> int:
    """`ZRANGEBYSCORE tests:by_due` -> pipelined deletes in chunks of CHUNK (spec §13.5), each
    chunk removing the test hash, its tests:by_due entry, and its reference in the owning batch's
    `batch:{id}:tests` list."""
    score = due_before if isinstance(due_before, (int, float)) else due_before.timestamp()
    key = redis_keys.tests_by_due_key()
    total = 0
    while True:
        ids = conn.zrangebyscore(key, "-inf", f"({score!r}", start=0, num=CHUNK)
        if not ids:
            break
        pipe = conn.pipeline(transaction=False)
        for tid in ids:
            pipe.hget(redis_keys.test_key(tid), "batch_id")
        batch_ids = pipe.execute()

        pipe = conn.pipeline(transaction=False)
        for tid, bid in zip(ids, batch_ids):
            pipe.delete(redis_keys.test_key(tid))
            pipe.zrem(key, tid)
            if bid is not None:
                pipe.lrem(redis_keys.batch_tests_key(bid), 0, tid)
        pipe.execute()
        total += len(ids)
    return total
