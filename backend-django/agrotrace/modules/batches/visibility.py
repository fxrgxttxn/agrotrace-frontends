"""
Batch visibility (п. 4.2, tag Batches; D14), the port of backend-express/src/modules/batches/visibility.ts. Deleted
batches are seen by nobody; several roles see the union:

- INSPECTOR and ADMIN — every batch;
- LAB — batches with a non-deleted lab test of its laboratory;
- FARMER, PROCESSOR, RETAILER — S ∪ N: S = the batches the organization originates or holds, or that are in a
  non-deleted waybill with status SENT, ACCEPTED or REJECTED it sends or receives; N = the direct parents and children
  of S in `batch_links`.

An invisible batch is indistinguishable from a missing one (404). The predicates are SQL (with `%s` parameters) so
lists filter in the database; the caller adds `deleted_at IS NULL`.
"""

from __future__ import annotations

from typing import Any

from agrotrace.security.jwt import Principal

PARTICIPANT_ROLES = ("FARMER", "PROCESSOR", "RETAILER")


def sees_all(p: Principal) -> bool:
    return "INSPECTOR" in p.roles or "ADMIN" in p.roles


def is_participant(p: Principal) -> bool:
    """FARMER, PROCESSOR or RETAILER — an organization that can originate, hold, send and receive batches."""
    return any(r in PARTICIPANT_ROLES for r in p.roles)


def participant_batch_ids_sql(org_id: str) -> tuple[str, list[Any]]:
    """`SELECT id …` of S ∪ N of the organization."""
    return (
        "WITH s AS ("
        " SELECT b.id FROM batches b"
        "  WHERE b.deleted_at IS NULL AND (b.origin_org_id = %s OR b.holder_org_id = %s)"
        " UNION"
        " SELECT wi.batch_id FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id"
        "  WHERE w.deleted_at IS NULL AND w.status IN ('SENT', 'ACCEPTED', 'REJECTED')"
        "    AND (w.sender_org_id = %s OR w.receiver_org_id = %s)"
        ") SELECT id FROM s"
        " UNION SELECT l.child_batch_id FROM batch_links l WHERE l.parent_batch_id IN (SELECT id FROM s)"
        " UNION SELECT l.parent_batch_id FROM batch_links l WHERE l.child_batch_id IN (SELECT id FROM s)",
        [org_id, org_id, org_id, org_id],
    )


def batch_visible_sql(p: Principal, column: str = "b.id", *, lab: bool = True) -> tuple[str, list[Any]]:
    """A boolean SQL predicate: the batch whose id is `column` is visible to `p` (deletion not included). `lab=False`
    leaves out the LAB rule (lab protocol files: the own laboratory is checked separately)."""
    if sees_all(p):
        return "true", []
    parts: list[str] = []
    params: list[Any] = []
    if lab and "LAB" in p.roles:
        parts.append(f"EXISTS (SELECT 1 FROM lab_tests t WHERE t.batch_id = {column} AND t.deleted_at IS NULL "
                     "AND t.lab_org_id = %s)")
        params.append(p.org_id)
    if is_participant(p):
        ids, ids_params = participant_batch_ids_sql(p.org_id)  # type: ignore[arg-type]
        parts.append(f"{column} IN ({ids})")
        params.extend(ids_params)
    if not parts:
        return "false", []
    return "(" + " OR ".join(parts) + ")", params


def visible_batch_ids_sql(p: Principal) -> tuple[str, list[Any]]:
    """`SELECT b.id …` of every non-deleted batch visible to `p` (S ∪ N for participants, D14)."""
    pred, params = batch_visible_sql(p, "b.id")
    return f"SELECT b.id FROM batches b WHERE b.deleted_at IS NULL AND {pred}", params
