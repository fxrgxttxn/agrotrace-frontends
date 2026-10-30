"""
BR-09 trust rating (contracts/events/rating.recalculate.schema.json, contracts/rules/trust-rating.json), the port of
backend-express/src/modules/rating/rating.ts: a full recomputation, never a delta — so any number of deliveries, in
any order, yields the same rating (eventually consistent: `rating.recalculate`, events/handlers/rating_recalculate.py).

Under the organization's row lock (`FOR NO KEY UPDATE`; R52 `organization`), for a FARM only: the left fold of
`domain.rules.next_trust_rating` from `initial` over every event of the farm, ordered by time asc, then lab events
before recall events, then id asc (code points):
  - every non-deleted lab test with status DONE on a non-deleted batch the farm originated — LAB_PASS / LAB_FAIL at
    `completed_at`;
  - every non-deleted recall whose source batch the farm originated — RECALL_SOURCE at `opened_at`.
A changed result is stored with the audit row `system.ratingRecalculate` (actor null, entityType organization, diff
`trustRating`). Other organization types are ignored.
"""

from __future__ import annotations

from agrotrace.core import audit
from agrotrace.core.tx import Tx
from agrotrace.domain.rules import TRUST_RATING, next_trust_rating

_EVENTS = """
SELECT e.event FROM (
  SELECT t.completed_at AS at, 0 AS kind, t.id::text AS id,
         CASE t.conclusion WHEN 'PASS' THEN 'LAB_PASS' ELSE 'LAB_FAIL' END AS event
    FROM lab_tests t JOIN batches b ON b.id = t.batch_id
   WHERE t.status = 'DONE' AND t.deleted_at IS NULL AND b.deleted_at IS NULL AND b.origin_org_id = %(org)s
  UNION ALL
  SELECT r.opened_at, 1, r.id::text, 'RECALL_SOURCE'
    FROM recalls r JOIN batches b ON b.id = r.source_batch_id
   WHERE r.deleted_at IS NULL AND b.origin_org_id = %(org)s
) e
ORDER BY e.at, e.kind, e.id COLLATE "C"
"""


def fold(tx: Tx, org_id: str) -> int:
    """The fold of the farm's events (no lock, no write)."""
    rating: int = TRUST_RATING["initial"]
    for e in tx.all(_EVENTS, {"org": org_id}):
        rating = next_trust_rating(rating, e["event"])
    return rating


def recalculate(tx: Tx, org_id: str) -> tuple[int | None, int | None, bool]:
    """Recomputes and stores the rating of `org_id` inside `tx` (the caller's transaction, after its event claim):
    (before, after, changed); (None, None, False) — not a FARM, or no such organization: nothing done."""
    org = tx.one("SELECT type, trust_rating FROM organizations WHERE id = %s FOR NO KEY UPDATE", [org_id])
    if org is None or org["type"] != "FARM":
        return None, None, False
    before: int = org["trust_rating"]
    after = fold(tx, org_id)
    if after == before:
        return before, after, False
    tx.execute("UPDATE organizations SET trust_rating = %s WHERE id = %s", [after, org_id])
    audit.record(tx, action="system.ratingRecalculate", entity_type="organization", entity_id=org_id, actor=None,
                 diff={"trustRating": [before, after]})
    return before, after, True
