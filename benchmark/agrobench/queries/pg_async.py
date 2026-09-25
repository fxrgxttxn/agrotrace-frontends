"""Async twins of agrobench.queries.pg (R1-R6, W1-W3, D1-D2) for the Task 4 measurement harness,
which drives both DBMS through asyncio (concurrency 1 and 16 — spec §13.6) with a psycopg
AsyncConnectionPool. Same SQL text (the module constants in agrobench.queries.pg), same parameter
builders, same row shaping — only the I/O calls are awaited. tests/test_async_queries.py proves
every function returns exactly what its sync twin returns on the same data.

`conn` is a psycopg AsyncConnection in autocommit mode (the harness's pool), so every write/delete
is one committed statement — exactly what `synchronous_commit` (strict/relaxed) acts on.
"""
from __future__ import annotations

from datetime import datetime

from agrobench.queries import pg as _pg


async def r1_batch_by_id(conn, batch_id: int) -> dict | None:
    cur = await conn.execute(_pg.R1_SQL, (batch_id,))
    row = await cur.fetchone()
    return _pg._row(_pg.BATCH_COLUMNS, row) if row else None


async def r2_batch_by_code(conn, public_code: str) -> dict | None:
    cur = await conn.execute(_pg.R2_SQL, (public_code,))
    row = await cur.fetchone()
    return _pg._row(_pg.BATCH_COLUMNS, row) if row else None


async def r3_holder_batches_by_status(conn, holder_org_id: int, status: str, limit: int = 50) -> list[dict]:
    cur = await conn.execute(_pg.R3_SQL, (holder_org_id, status, limit))
    return [_pg._row(_pg.BATCH_COLUMNS, r) for r in await cur.fetchall()]


async def r4_batch_with_holder_and_tests(conn, batch_id: int) -> dict | None:
    cur = await conn.execute(_pg.R4_SQL, (batch_id,))
    return _pg.r4_from_row(await cur.fetchone())


async def r5_descendants(conn, batch_id: int, max_depth: int = 20) -> set[int]:
    cur = await conn.execute(_pg.R5_SQL, (batch_id, max_depth))
    return {row[0] for row in await cur.fetchall()}


async def r6_status_counts(conn, org_id: int) -> dict[str, int]:
    cur = await conn.execute(_pg.R6_SQL, (org_id,))
    return {status: count for status, count in await cur.fetchall()}


async def w1_insert_batch(conn, batch: dict) -> None:
    await conn.execute(_pg.W1_SQL, _pg.w1_params(batch))


async def w2_insert_batches_copy(conn, batches: list[dict]) -> None:
    if not batches:
        return
    async with conn.cursor() as cur, cur.copy(_pg.W2_COPY_SQL) as copy:
        for b in batches:
            await copy.write_row(_pg.w1_params(b))


async def w2_insert_batches_multirow(conn, batches: list[dict]) -> None:
    if not batches:
        return
    await conn.execute(_pg.W2_MULTIROW_SQL, _pg.w2_multirow_params(batches))


async def w3_update_status(conn, batch_id: int, new_status: str, expected_version: int) -> bool:
    cur = await conn.execute(_pg.W3_SQL, (new_status, batch_id, expected_version))
    return cur.rowcount == 1


async def d1_delete_batch(conn, batch_id: int) -> bool:
    cur = await conn.execute(_pg.D1_SQL, (batch_id, batch_id, batch_id, batch_id))
    return (await cur.fetchone())[0] == 1


async def d2_delete_tests_due_before(conn, due_before: datetime) -> int:
    cur = await conn.execute(_pg.D2_SQL, (due_before,))
    return cur.rowcount
