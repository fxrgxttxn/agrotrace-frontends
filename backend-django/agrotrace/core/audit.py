"""
Audit log writer (contract `AuditEntry`, spec 8.8), the port of backend-express/src/modules/audit/service.ts `record`
— shared infrastructure from Task 1 (Express added it as a Task 4 retrofit). One row per changed entity row, in the
SAME transaction as the change: `action` = operationId (or `system.<job>`), `diff` = {apiField: [before, after]} over
the changed fields only, in API formats, secrets as "***" on both sides; a creation has before = null for every filled
field. `ip` and `request_id` come from the request context, `backend = 'django'`, `created_at` = the transaction's
now() (P43). The reading side (listAuditLog) is Task 4.
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import context
from agrotrace.core.render import json_dumps
from agrotrace.core.tx import Tx
from agrotrace.security.jwt import Principal

SECRET = "***"

ENTITY_TYPES = ("organization", "user", "field", "treatment", "batch", "waybill", "labTest", "recall", "recallTask",
                "complaint", "product", "substance", "indicator", "norm", "region", "file", "batchDocument")

AuditDiff = dict[str, list[Any]]


def _same(a: Any, b: Any) -> bool:
    return json_dumps(a) == json_dumps(b)


def audit_diff(before: dict[str, Any] | None, after: dict[str, Any]) -> AuditDiff:
    """`{field: [before, after]}` over the fields whose values differ (JSON equality); before None → a creation:
    every non-null field of `after` with null before. Values must already be in API format."""
    out: AuditDiff = {}
    for k, v in after.items():
        b = before.get(k) if before is not None else None
        if before is None and v is None:
            continue
        if not _same(b, v):
            out[k] = [b, v]
    return out


def audit_removal(before: dict[str, Any]) -> AuditDiff:
    """A hard delete: every non-null field of the removed row → [before, null]."""
    return {k: [v, None] for k, v in before.items() if v is not None}


def record(
    tx: Tx,
    *,
    action: str,
    entity_type: str,
    entity_id: str | None,
    diff: AuditDiff,
    actor: Principal | None,
    request=None,
    actor_id: str | None = None,
) -> None:
    """`actor_id` names the actor when there is no Principal (registration, acceptInvite, resetPassword)."""
    if entity_type not in ENTITY_TYPES:
        raise ValueError(f"unknown audit entity type {entity_type}")
    ip = context.client_ip()
    if ip is None and request is not None:
        from agrotrace.core.middleware import client_ip

        ip = client_ip(request)
    tx.execute(
        "INSERT INTO audit_log (actor_id, action, entity_type, entity_id, diff, ip, backend, request_id) "
        "VALUES (%s, %s, %s, %s, %s::jsonb, %s::inet, 'django', %s)",
        [actor.user_id if actor else actor_id, action, entity_type, entity_id, json_dumps(diff), ip,
         context.request_id()],
    )
