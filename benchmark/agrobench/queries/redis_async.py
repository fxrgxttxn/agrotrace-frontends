"""Async twins of agrobench.queries.redis (R1-R6, W1-W3, D1-D2) for the Task 4 measurement
harness (asyncio, concurrency 1 and 16 — spec §13.6) over a `redis.asyncio.Redis` client with a
connection pool. Same keys, same commands in the same round-trip structure (pipelines stay
pipelines, Lua stays Lua — the very same script texts), same result shaping (the sync module's
hash->dict helpers) — only the I/O is awaited. tests/test_async_queries.py proves every function
returns exactly what its sync twin returns on the same data.
"""
from __future__ import annotations

from agrobench import redis_keys
from agrobench.queries import redis as _r

# Per-process AsyncScript cache (EVALSHA with EVAL fallback), mirroring agrobench.queries.redis.
_scripts: dict[str, object] = {}


def _script(conn, name: str, text: str):
    script = _scripts.get(name)
    if script is None:
        script = conn.register_script(text)
        _scripts[name] = script
    return script


async def r1_batch_by_id(conn, batch_id) -> dict | None:
    return _r._batch_from_hash(batch_id, await conn.hgetall(redis_keys.batch_key(batch_id)))


async def r2_batch_by_code(conn, public_code: str) -> dict | None:
    batch_id = await conn.get(redis_keys.batch_code_key(public_code))
    if batch_id is None:
        return None
    return _r._batch_from_hash(batch_id, await conn.hgetall(redis_keys.batch_key(batch_id)))


async def r3_holder_batches_by_status(conn, holder_org_id, status: str, limit: int = 50) -> list[dict]:
    ids = await conn.zrevrange(redis_keys.org_held_status_key(holder_org_id, status), 0, limit - 1)
    if not ids:
        return []
    pipe = conn.pipeline(transaction=False)
    for bid in ids:
        pipe.hgetall(redis_keys.batch_key(bid))
    hashes = await pipe.execute()
    result = []
    for bid, h in zip(ids, hashes):
        batch = _r._batch_from_hash(bid, h)
        if batch is not None:
            result.append(batch)
    return result


async def r4_batch_with_holder_and_tests(conn, batch_id) -> dict | None:
    pipe = conn.pipeline(transaction=False)
    pipe.hgetall(redis_keys.batch_key(batch_id))
    pipe.lrange(redis_keys.batch_tests_key(batch_id), 0, -1)
    batch_hash, test_ids = await pipe.execute()
    batch = _r._batch_from_hash(batch_id, batch_hash)
    if batch is None:
        return None

    pipe = conn.pipeline(transaction=False)
    pipe.hgetall(redis_keys.org_key(batch["holder_org_id"]))
    for tid in test_ids:
        pipe.hgetall(redis_keys.test_key(tid))
    results = await pipe.execute()
    holder = _r._org_from_hash(batch["holder_org_id"], results[0])
    tests = []
    for tid, h in zip(test_ids, results[1:]):
        test = _r._test_from_hash(tid, h)
        if test is not None:
            tests.append(test)
    return {"batch": batch, "holder": holder, "tests": tests}


async def r5_descendants(conn, batch_id, max_depth: int = 20) -> set[int]:
    start = str(batch_id)
    visited: set[str] = {start}
    frontier = [start]
    depth = 0
    while frontier and depth < max_depth:
        pipe = conn.pipeline(transaction=False)
        for bid in frontier:
            pipe.smembers(redis_keys.batch_children_key(bid))
        levels = await pipe.execute()
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


async def r5_descendants_lua(conn, batch_id, max_depth: int = 20) -> set[int]:
    script = _script(conn, "r5", _r._R5_LUA)
    result = await script(args=[str(batch_id), str(max_depth)], client=conn)
    return {int(x) for x in result}


async def r6_status_counts(conn, org_id) -> dict[str, int]:
    h = await conn.hgetall(redis_keys.stats_org_key(org_id))
    return {status: int(count) for status, count in h.items() if int(count) != 0}


async def w1_insert_batch(conn, batch: dict) -> None:
    pipe = conn.pipeline(transaction=True)
    _r._queue_w1(pipe, batch)
    await pipe.execute()


async def w2_insert_batches(conn, batches: list[dict]) -> None:
    pipe = conn.pipeline(transaction=False)
    pending = 0
    for batch in batches:
        _r._queue_w1(pipe, batch)
        pending += 1
        if pending >= _r.CHUNK:
            await pipe.execute()
            pending = 0
    if pending:
        await pipe.execute()


async def w3_update_status(conn, batch_id, new_status: str, expected_version: int) -> bool:
    script = _script(conn, "w3", _r._W3_LUA)
    return bool(await script(args=[str(batch_id), new_status, str(expected_version)], client=conn))


async def d1_delete_batch(conn, batch_id) -> bool:
    script = _script(conn, "d1", _r._D1_LUA)
    return bool(await script(args=[str(batch_id)], client=conn))


async def d2_delete_tests_due_before(conn, due_before) -> int:
    score = due_before if isinstance(due_before, (int, float)) else due_before.timestamp()
    key = redis_keys.tests_by_due_key()
    total = 0
    while True:
        ids = await conn.zrangebyscore(key, "-inf", f"({score!r}", start=0, num=_r.CHUNK)
        if not ids:
            break
        pipe = conn.pipeline(transaction=False)
        for tid in ids:
            pipe.hget(redis_keys.test_key(tid), "batch_id")
        batch_ids = await pipe.execute()

        pipe = conn.pipeline(transaction=False)
        for tid, bid in zip(ids, batch_ids):
            pipe.delete(redis_keys.test_key(tid))
            pipe.zrem(key, tid)
            if bid is not None:
                pipe.lrem(redis_keys.batch_tests_key(bid), 0, tid)
        await pipe.execute()
        total += len(ids)
    return total
