"""
The public batch page cache (R82, contract info.description "Shared Redis keys"), the port of backend-express/src/
modules/public/cache.ts: `pub:batch:{publicCode}` holds the exact PublicBatch JSON; every operation that changes what
a page shows deletes the keys of the affected batches AFTER its commit. The codes are collected inside the transaction
(a DB read), the DEL runs after it (`schedule_drop` → `Tx.after_release`; P8: a retried attempt drops nothing).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from agrotrace.core.tx import Tx

CHUNK = 500


def codes_of_org(tx: Tx, org_id: str) -> list[str]:
    """Batches whose page shows the organization: it originates them, or it is a stage of their `path` (the receiver
    of an ACCEPTED waybill with the batch) — updateAdminOrganization (name, region), uploadOrganizationLogo."""
    rows = tx.all(
        "SELECT b.public_code FROM batches b WHERE b.origin_org_id = %s "
        "UNION "
        "SELECT b.public_code FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id "
        "JOIN batches b ON b.id = wi.batch_id WHERE w.receiver_org_id = %s AND w.status = 'ACCEPTED'",
        [org_id, org_id],
    )
    return [r["public_code"] for r in rows]


def codes_of_products(tx: Tx, product_ids: Sequence[str]) -> list[str]:
    """Batches of the products (name or photo shown on the page)."""
    if not product_ids:
        return []
    rows = tx.all("SELECT public_code FROM batches WHERE product_id = ANY(%s::uuid[])", [list(product_ids)])
    return [r["public_code"] for r in rows]


def drop(codes: Iterable[str]) -> None:
    """Deletes the cached pages (exact keys, in chunks of 500)."""
    from agrotrace.infra import redis

    keys = [f"pub:batch:{c}" for c in codes]
    for i in range(0, len(keys), CHUNK):
        redis.client().delete(*keys[i: i + CHUNK])


def schedule_drop(tx: Tx, codes: Sequence[str]) -> None:
    """`drop(codes)` after this transaction commits and its connection is back in the pool (P61: no connection is
    held across the Redis call); nothing when it rolls back."""
    if codes:
        frozen = list(codes)
        tx.after_release(lambda: drop(frozen))
