"""Redis key names and the score helper for the schema in spec §13.3 — shared by the loader
(load_redis.py) and, later, the query implementations (Task 3), so every reader/writer agrees on
exactly the same key shapes.
"""
from __future__ import annotations

from datetime import datetime


def org_key(org_id) -> str:
    return f"org:{org_id}"


def batch_key(batch_id) -> str:
    return f"batch:{batch_id}"


def test_key(test_id) -> str:
    return f"test:{test_id}"


def batch_code_key(public_code: str) -> str:
    return f"batch:code:{public_code}"


def batch_children_key(batch_id) -> str:
    return f"batch:{batch_id}:children"


def batch_parents_key(batch_id) -> str:
    return f"batch:{batch_id}:parents"


def link_key(parent_id, child_id) -> str:
    return f"link:{parent_id}:{child_id}"


def org_held_key(org_id) -> str:
    return f"org:{org_id}:held"


def org_held_status_key(org_id, status: str) -> str:
    """Score is harvested_at (`to_score`). Invariant (fix round 1, Important 3): harvested_at must
    be unique per holder -- ZSET members with an equal score fall back to *lexicographic* string
    order ("10" < "9"), not numeric id order, so a tie here would make R3's "newest first" order
    diverge from PostgreSQL's `ORDER BY harvested_at DESC, id DESC` for no reason a caller could
    predict. agrobench.generate enforces this globally (see generate()); anything that inserts
    batches outside the generator (W1/W2 callers, including test fixtures) must keep it too."""
    return f"org:{org_id}:held:{status}"


def batch_tests_key(batch_id) -> str:
    return f"batch:{batch_id}:tests"


def tests_by_due_key() -> str:
    return "tests:by_due"


def stats_org_key(org_id) -> str:
    return f"stats:org:{org_id}"


def seq_key(entity: str) -> str:
    return f"seq:{entity}"


def to_score(iso_timestamp: str) -> float:
    """Sorted-set score for an ISO-8601 timestamp (spec §13.3: `org:{id}:held*` score=harvested_at,
    `tests:by_due` score=due_at)."""
    return datetime.fromisoformat(iso_timestamp).timestamp()
