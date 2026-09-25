"""PostgreSQL implementations of queries R1-R6, W1-W3, D1-D2 (spec §13.5, schema §13.2).

Sync (psycopg 3); Task 4 wraps these for the async measurement harness. "One call = one logical
query" per the brief: every function issues exactly one round trip to PostgreSQL except D1, whose
three statements (lab_tests, then batch_links, then batches — the FK order; the schema has no
ON DELETE CASCADE) are wrapped in `conn.transaction()` so the cascade is atomic regardless of the
caller's connection mode (autocommit or not — psycopg's transaction block handles both, using a
savepoint if the caller already has one open).

No function here calls `conn.commit()`: whether writes become visible immediately (autocommit
connection) or only when the caller's own `with conn:` block exits is entirely the caller's
choice, matching agrobench.queries.redis's `conn` being an equally bare handle.
"""
from __future__ import annotations

from datetime import datetime

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


def _row(columns: list[str], row) -> dict:
    return dict(zip(columns, row))


def r1_batch_by_id(conn, batch_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(f"{_BATCH_SELECT} WHERE id = %s", (batch_id,))
        row = cur.fetchone()
    return _row(BATCH_COLUMNS, row) if row else None


def r2_batch_by_code(conn, public_code: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(f"{_BATCH_SELECT} WHERE public_code = %s", (public_code,))
        row = cur.fetchone()
    return _row(BATCH_COLUMNS, row) if row else None


def r3_holder_batches_by_status(conn, holder_org_id: int, status: str, limit: int = 50) -> list[dict]:
    """Uses ix_batches_holder_status_harvested (spec §13.2): filter + ORDER BY served by the index,
    newest first, `limit` rows — matches Redis's `ZREVRANGE org:{id}:held:{status} 0 limit-1`."""
    with conn.cursor() as cur:
        cur.execute(
            f"{_BATCH_SELECT} WHERE holder_org_id = %s AND status = %s "
            "ORDER BY harvested_at DESC LIMIT %s",
            (holder_org_id, status, limit),
        )
        rows = cur.fetchall()
    return [_row(BATCH_COLUMNS, r) for r in rows]


def r4_batch_with_holder_and_tests(conn, batch_id: int) -> dict | None:
    """JOIN-equivalent: batch + its holder organization + all its lab tests (spec §13.5)."""
    batch = r1_batch_by_id(conn, batch_id)
    if batch is None:
        return None
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {', '.join(ORG_COLUMNS)} FROM organizations WHERE id = %s",
            (batch["holder_org_id"],),
        )
        org_row = cur.fetchone()
        holder = _row(ORG_COLUMNS, org_row) if org_row else None

        cur.execute(
            f"SELECT {', '.join(TEST_COLUMNS)} FROM lab_tests WHERE batch_id = %s",
            (batch_id,),
        )
        tests = [_row(TEST_COLUMNS, r) for r in cur.fetchall()]
    return {"batch": batch, "holder": holder, "tests": tests}


def r5_descendants(conn, batch_id: int, max_depth: int = 20) -> set[int]:
    """Downward graph traversal, `WITH RECURSIVE`, depth <= max_depth (spec §13.5). `UNION` (not
    `UNION ALL`) dedups the working set so a DAG's shared descendants don't blow up the recursion;
    `SELECT DISTINCT` on top guarantees the final set has each descendant exactly once even though
    the same id can still legitimately appear at more than one depth in the working table."""
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH RECURSIVE descendants(id, depth) AS (
                SELECT child_id, 1 FROM batch_links WHERE parent_id = %s
                UNION
                SELECT bl.child_id, d.depth + 1
                FROM batch_links bl
                JOIN descendants d ON bl.parent_id = d.id
                WHERE d.depth < %s
            )
            SELECT DISTINCT id FROM descendants
            """,
            (batch_id, max_depth),
        )
        return {row[0] for row in cur.fetchall()}


def r6_status_counts(conn, org_id: int) -> dict[str, int]:
    """`GROUP BY` aggregate (spec §13.5) — matches Redis's `HGETALL stats:org:{id}`."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, count(*) FROM batches WHERE holder_org_id = %s GROUP BY status",
            (org_id,),
        )
        return {status: count for status, count in cur.fetchall()}


def w1_insert_batch(conn, batch: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO batches (id, public_code, product, origin_org_id, holder_org_id, kind, "
            "mass_kg, status, harvested_at, version) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                batch["id"], batch["public_code"], batch["product"], batch["origin_org_id"],
                batch["holder_org_id"], batch["kind"], batch["mass_kg"], batch["status"],
                batch["harvested_at"], batch.get("version", 1),
            ),
        )


def w2_insert_batches_copy(conn, batches: list[dict]) -> None:
    """W2 variant 1: `COPY` (spec §13.5)."""
    if not batches:
        return
    with conn.cursor() as cur, cur.copy(
        "COPY batches (id, public_code, product, origin_org_id, holder_org_id, kind, mass_kg, "
        "status, harvested_at, version) FROM STDIN"
    ) as copy:
        for b in batches:
            copy.write_row((
                b["id"], b["public_code"], b["product"], b["origin_org_id"], b["holder_org_id"],
                b["kind"], b["mass_kg"], b["status"], b["harvested_at"], b.get("version", 1),
            ))


def w2_insert_batches_multirow(conn, batches: list[dict]) -> None:
    """W2 variant 2: multi-row `INSERT` (spec §13.5)."""
    if not batches:
        return
    values_sql = ", ".join(["(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"] * len(batches))
    params: list = []
    for b in batches:
        params.extend((
            b["id"], b["public_code"], b["product"], b["origin_org_id"], b["holder_org_id"],
            b["kind"], b["mass_kg"], b["status"], b["harvested_at"], b.get("version", 1),
        ))
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO batches (id, public_code, product, origin_org_id, holder_org_id, kind, "
            f"mass_kg, status, harvested_at, version) VALUES {values_sql}",
            params,
        )


# Default W2 entry point (Task 4 measures both named variants explicitly; callers that don't care
# which one get the multi-row form).
w2_insert_batches = w2_insert_batches_multirow


def w3_update_status(conn, batch_id: int, new_status: str, expected_version: int) -> bool:
    """Optimistic-lock status change (spec §13.5): only writes if `version` still matches
    `expected_version`; a stale version leaves the row untouched and returns False."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE batches SET status = %s, version = version + 1 WHERE id = %s AND version = %s",
            (new_status, batch_id, expected_version),
        )
        return cur.rowcount == 1


def d1_delete_batch(conn, batch_id: int) -> bool:
    """Cascade delete: lab tests, then edges (either side), then the batch itself, atomically
    (spec §13.5) — the schema has no `ON DELETE CASCADE`, so order matters (children before the
    referenced batch) and the three statements must commit or roll back together."""
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM batches WHERE id = %s", (batch_id,))
            if cur.fetchone() is None:
                return False
            cur.execute("DELETE FROM lab_tests WHERE batch_id = %s", (batch_id,))
            cur.execute(
                "DELETE FROM batch_links WHERE parent_id = %s OR child_id = %s",
                (batch_id, batch_id),
            )
            cur.execute("DELETE FROM batches WHERE id = %s", (batch_id,))
        return True


def d2_delete_tests_due_before(conn, due_before: datetime) -> int:
    """Set-based delete using ix_lab_tests_due (spec §13.5): every lab test with `due_at` strictly
    before `due_before`."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM lab_tests WHERE due_at < %s", (due_before,))
        return cur.rowcount
