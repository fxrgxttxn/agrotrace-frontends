"""
Batch status transitions (contracts/rules/state-machine.json via domain.state_machine), the port of
backend-express/src/modules/batches/lifecycle.ts: every transition — automatic ones included — increments `version`
by 1 and writes a `batch_status_history` row (`reason`, the author or null for the server) at the transaction's
instant (P43). The caller holds the batch row lock (R47) and has checked the transition. `notify` writes a
`notification.dispatch` event into the outbox (contracts/rules/notifications.json; delivery is the worker's, Task 12).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from agrotrace.core.tx import Tx
from agrotrace.domain.state_machine import can_transition
from agrotrace.infra import outbox


def transition_batch(tx: Tx, b: dict[str, Any], to: str, reason: str, by_user_id: str | None,
                     extra: dict[str, Any] | None = None) -> int:
    """Moves the locked batch `b` (`id`, `status`, `version`) to `to`; returns the new version. `extra` — further
    columns of the same UPDATE (`holder_org_id`, `mass_kg`)."""
    if not can_transition(b["status"], to):
        raise AssertionError(f"batch {b['id']}: {b['status']} → {to} is not a transition")
    version = b["version"] + 1
    cols = {"status": to, "version": version, **(extra or {})}
    sets = ", ".join(f"{k} = %s" for k in cols)
    tx.execute(f"UPDATE batches SET {sets} WHERE id = %s", [*cols.values(), b["id"]])
    tx.execute(
        "INSERT INTO batch_status_history (batch_id, from_status, to_status, changed_by, reason, changed_at) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        [b["id"], b["status"], to, by_user_id, reason, tx.now],
    )
    return version


def _uniq(xs: Iterable[str] | None) -> list[str]:
    return list(dict.fromkeys(xs or ()))


def notify(tx: Tx, notification_type: str, *, user_ids: Iterable[str] | None = None,
           org_ids: Iterable[str] | None = None, org_head_ids: Iterable[str] | None = None,
           roles: Iterable[str] | None = None, payload: dict[str, Any]) -> str:
    """`notification.dispatch` into the outbox: the type's recipients as logical groups resolved to ids (each list
    without duplicates, first occurrence kept), `payload` with exactly the type's keys."""
    return outbox.enqueue(tx, "notification.dispatch", {
        "notificationType": notification_type,
        "recipients": {"userIds": _uniq(user_ids), "orgIds": _uniq(org_ids), "orgHeadIds": _uniq(org_head_ids),
                       "roles": _uniq(roles)},
        "payload": payload,
    })
