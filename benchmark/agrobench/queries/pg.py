"""PostgreSQL implementations of queries R1-R6, W1-W3, D1-D2 (spec §13.5, schema §13.2).

Sync (psycopg 3); agrobench.queries.pg_async runs the same SQL constants through the async API
for the Task 4 measurement harness. "One call = one logical
query" per the brief: every function, including R4 and D1 (fix round 1, Important 4 and 5), issues
exactly one round trip to PostgreSQL -- R4 via a correlated `json_agg` subselect instead of two
extra queries, D1 via three data-modifying CTEs in one statement instead of a pre-check SELECT
plus three separate DELETEs. PostgreSQL defers foreign-key constraint-trigger checks to the end of
the statement, so D1's CTEs may delete `batches` while sibling CTEs remove the `lab_tests`/
`batch_links` rows that reference it, even though the schema has no `ON DELETE CASCADE`.

No function here calls `conn.commit()`: whether writes become visible immediately (autocommit
connection) or only when the caller's own `with conn:` block exits is entirely the caller's
choice, matching agrobench.queries.redis's `conn` being an equally bare handle. None of these
functions needs an explicit `conn.transaction()` either (a single SQL statement, even one with
multiple CTEs, is always one atomic unit in PostgreSQL regardless of connection mode).
"""
from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal

BATCH_COLUMNS = [
    "id", "public_code", "product", "origin_org_id", "holder_org_id", "kind",
    "mass_kg", "status", "harvested_at", "version",
]
_BATCH_SELECT = (
    "SELECT id, public_code, product, origin_org_id, holder_org_id, kind, mass_kg, status, "
    "harvested_at, version FROM batches"
)

ORG_COLUMNS = ["id", "type", "name", "inn", "region_code", "trust_rating", "created_at"]
TEST_COLUMNS = ["id", "batch_id", "lab_org_id", "reason", "conclusion", "value", "due_at"]


# SQL text and parameter builders as module constants (Task 4): agrobench.queries.pg_async runs the
# exact same statements through psycopg's async API, so the two can never drift apart.
R1_SQL = f"{_BATCH_SELECT} WHERE id = %s"
R2_SQL = f"{_BATCH_SELECT} WHERE public_code = %s"
R3_SQL = (
    f"{_BATCH_SELECT} WHERE holder_org_id = %s AND status = %s "
    "ORDER BY harvested_at DESC, id DESC LIMIT %s"
)
R5_SQL = """
    WITH RECURSIVE descendants(id, depth) AS (
        SELECT child_id, 1 FROM batch_links WHERE parent_id = %s
        UNION
        SELECT bl.child_id, d.depth + 1
        FROM batch_links bl
        JOIN descendants d ON bl.parent_id = d.id
        WHERE d.depth < %s
    )
    SELECT DISTINCT id FROM descendants
    """
R6_SQL = "SELECT status, count(*) FROM batches WHERE holder_org_id = %s GROUP BY status"
W1_SQL = (
    "INSERT INTO batches (id, public_code, product, origin_org_id, holder_org_id, kind, "
    "mass_kg, status, harvested_at, version) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
)
W2_COPY_SQL = (
    "COPY batches (id, public_code, product, origin_org_id, holder_org_id, kind, mass_kg, "
    "status, harvested_at, version) FROM STDIN"
)
W2_MULTIROW_SQL = (
    "INSERT INTO batches (id, public_code, product, origin_org_id, holder_org_id, kind, "
    "mass_kg, status, harvested_at, version) "
    "SELECT * FROM unnest(%s::bigint[], %s::varchar[], %s::varchar[], %s::bigint[], "
    "%s::bigint[], %s::varchar[], %s::numeric[], %s::varchar[], %s::timestamptz[], "
    "%s::integer[])"
)
W3_SQL = "UPDATE batches SET status = %s, version = version + 1 WHERE id = %s AND version = %s"
D1_SQL = """
    WITH deleted_tests AS (
        DELETE FROM lab_tests WHERE batch_id = %s
    ),
    deleted_links AS (
        DELETE FROM batch_links WHERE parent_id = %s OR child_id = %s
    ),
    deleted_batch AS (
        DELETE FROM batches WHERE id = %s RETURNING id
    )
    SELECT count(*) FROM deleted_batch
    """
D2_SQL = "DELETE FROM lab_tests WHERE due_at < %s"


def w1_params(batch: dict) -> tuple:
    return (
        batch["id"], batch["public_code"], batch["product"], batch["origin_org_id"],
        batch["holder_org_id"], batch["kind"], batch["mass_kg"], batch["status"],
        batch["harvested_at"], batch.get("version", 1),
    )


def w2_multirow_params(batches: list[dict]) -> tuple:
    return (
        [b["id"] for b in batches],
        [b["public_code"] for b in batches],
        [b["product"] for b in batches],
        [b["origin_org_id"] for b in batches],
        [b["holder_org_id"] for b in batches],
        [b["kind"] for b in batches],
        [b["mass_kg"] for b in batches],
        [b["status"] for b in batches],
        [b["harvested_at"] for b in batches],
        [b.get("version", 1) for b in batches],
    )


def _row(columns: list[str], row) -> dict:
    return dict(zip(columns, row))


def r1_batch_by_id(conn, batch_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(R1_SQL, (batch_id,))
        row = cur.fetchone()
    return _row(BATCH_COLUMNS, row) if row else None


def r2_batch_by_code(conn, public_code: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(R2_SQL, (public_code,))
        row = cur.fetchone()
    return _row(BATCH_COLUMNS, row) if row else None


def r3_holder_batches_by_status(conn, holder_org_id: int, status: str, limit: int = 50) -> list[dict]:
    """Uses ix_batches_holder_status_harvested (spec §13.2): filter + ORDER BY served by the index,
    newest first, `limit` rows — matches Redis's `ZREVRANGE org:{id}:held:{status} 0 limit-1`.

    `, id DESC` is a defensive tie-break (fix round 1, Important 3): harvested_at is guaranteed
    unique per holder (agrobench.generate asserts it globally; redis_keys.org_held_status_key
    documents why), so this should never actually decide anything on generated data -- but without
    it, `ORDER BY harvested_at DESC` alone has no defined order for equal timestamps, whereas
    Redis's ZSET always has *some* deterministic (if unrelated) tie-break of its own. Making
    PostgreSQL's order total too means a future caller that violates the uniqueness invariant gets
    a silently-different-but-still-total order instead of a flaky one.
    """
    with conn.cursor() as cur:
        cur.execute(R3_SQL, (holder_org_id, status, limit))
        rows = cur.fetchall()
    return [_row(BATCH_COLUMNS, r) for r in rows]


R4_SQL = """
    SELECT
      b.id, b.public_code, b.product, b.origin_org_id, b.holder_org_id, b.kind, b.mass_kg,
      b.status, b.harvested_at, b.version,
      o.id, o.type, o.name, o.inn, o.region_code, o.trust_rating, o.created_at,
      COALESCE(
        (SELECT json_agg(json_build_object(
            'id', t.id, 'batch_id', t.batch_id, 'lab_org_id', t.lab_org_id, 'reason', t.reason,
            'conclusion', t.conclusion, 'value', t.value::text, 'due_at', t.due_at
          ) ORDER BY t.id)
         FROM lab_tests t WHERE t.batch_id = b.id),
        '[]'::json
      )
    FROM batches b
    JOIN organizations o ON o.id = b.holder_org_id
    WHERE b.id = %s
    """


def r4_batch_with_holder_and_tests(conn, batch_id: int) -> dict | None:
    """One statement: batch JOIN its holder organization (holder_org_id is NOT NULL + FK, so an
    INNER JOIN is always safe) plus a correlated `json_agg` subselect for its lab tests (spec
    §13.5's "JOIN") — fix round 1, Important 4: this used to be three round trips (r1_batch_by_id,
    a SELECT on organizations, a SELECT on lab_tests), not a single query as the brief requires.

    `value::text` avoids `json_build_object` round-tripping the numeric column through JSON's
    binary-float number type, which would lose exact decimal digits (e.g. "12.500" -> 12.5)."""
    with conn.cursor() as cur:
        cur.execute(R4_SQL, (batch_id,))
        row = cur.fetchone()
    return r4_from_row(row)


def r4_from_row(row) -> dict | None:
    """Shapes R4's single result row (shared with agrobench.queries.pg_async)."""
    if row is None:
        return None
    batch = _row(BATCH_COLUMNS, row[0:10])
    holder = _row(ORG_COLUMNS, row[10:17])
    tests_raw = row[17]
    if isinstance(tests_raw, str):
        tests_raw = json.loads(tests_raw)
    tests = [
        {
            "id": t["id"], "batch_id": t["batch_id"], "lab_org_id": t["lab_org_id"],
            "reason": t["reason"], "conclusion": t["conclusion"], "value": Decimal(t["value"]),
            "due_at": t["due_at"],
        }
        for t in tests_raw
    ]
    return {"batch": batch, "holder": holder, "tests": tests}


def r5_descendants(conn, batch_id: int, max_depth: int = 20) -> set[int]:
    """Downward graph traversal, `WITH RECURSIVE`, depth <= max_depth (spec §13.5). `UNION` (not
    `UNION ALL`) dedups the working set so a DAG's shared descendants don't blow up the recursion;
    `SELECT DISTINCT` on top guarantees the final set has each descendant exactly once even though
    the same id can still legitimately appear at more than one depth in the working table."""
    with conn.cursor() as cur:
        cur.execute(R5_SQL, (batch_id, max_depth))
        return {row[0] for row in cur.fetchall()}


def r6_status_counts(conn, org_id: int) -> dict[str, int]:
    """`GROUP BY` aggregate (spec §13.5) — matches Redis's `HGETALL stats:org:{id}`."""
    with conn.cursor() as cur:
        cur.execute(R6_SQL, (org_id,))
        return {status: count for status, count in cur.fetchall()}


def w1_insert_batch(conn, batch: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(W1_SQL, w1_params(batch))


def w2_insert_batches_copy(conn, batches: list[dict]) -> None:
    """W2 variant 1: `COPY` (spec §13.5)."""
    if not batches:
        return
    with conn.cursor() as cur, cur.copy(W2_COPY_SQL) as copy:
        for b in batches:
            copy.write_row(w1_params(b))


def w2_insert_batches_multirow(conn, batches: list[dict]) -> None:
    """W2 variant 2: multi-row `INSERT` (spec §13.5), via `INSERT ... SELECT FROM unnest(...)`.

    Fix round 1, Critical 1: a literal `VALUES (...), (...), ...` list binds len(batches)*10
    parameters -- past ~6553 rows that exceeds PostgreSQL's 65535-parameter-per-statement limit
    and the insert fails outright at spec scale (10 000 rows = 100 000 params). `unnest` takes
    exactly 10 array parameters no matter how many rows are in the batch, so this variant is still
    genuinely a single statement/round trip at any scale."""
    if not batches:
        return
    with conn.cursor() as cur:
        cur.execute(W2_MULTIROW_SQL, w2_multirow_params(batches))


# Default W2 entry point (Task 4 measures both named variants explicitly; callers that don't care
# which one get the multi-row form).
w2_insert_batches = w2_insert_batches_multirow


def w3_update_status(conn, batch_id: int, new_status: str, expected_version: int) -> bool:
    """Optimistic-lock status change (spec §13.5): only writes if `version` still matches
    `expected_version`; a stale version leaves the row untouched and returns False."""
    with conn.cursor() as cur:
        cur.execute(W3_SQL, (new_status, batch_id, expected_version))
        return cur.rowcount == 1


def d1_delete_batch(conn, batch_id: int) -> bool:
    """Cascade delete in one statement (spec §13.5; fix round 1, Critical 5): three data-modifying
    CTEs -- lab tests, edges on either side, and the batch itself -- run as a single round trip,
    atomic as any one PostgreSQL statement is, with no `conn.transaction()` needed. The schema has
    no `ON DELETE CASCADE`; this works anyway because PostgreSQL's foreign-key constraint-trigger
    checks fire at end-of-statement, by which point all three CTEs (which all read the *pre*
    statement snapshot, per PostgreSQL's documented WITH semantics) have applied, so no row is
    ever left referencing a batch that no longer exists.

    Concurrency-correct: the return value is exactly `deleted_batch`'s own row count, nothing else
    (the old version pre-checked existence with a separate SELECT, then unconditionally returned
    True -- so two concurrent callers deleting the same batch both got True even though only one
    of them actually removed the row). Two concurrent `DELETE FROM batches WHERE id = %s`
    statements for the same id can't both match: PostgreSQL row-locks the target row, the second
    deleter blocks until the first commits, then re-evaluates its WHERE clause under READ
    COMMITTED and finds nothing left to delete."""
    with conn.cursor() as cur:
        cur.execute(D1_SQL, (batch_id, batch_id, batch_id, batch_id))
        return cur.fetchone()[0] == 1


def d2_delete_tests_due_before(conn, due_before: datetime) -> int:
    """Set-based delete using ix_lab_tests_due (spec §13.5): every lab test with `due_at` strictly
    before `due_before`."""
    with conn.cursor() as cur:
        cur.execute(D2_SQL, (due_before,))
        return cur.rowcount
