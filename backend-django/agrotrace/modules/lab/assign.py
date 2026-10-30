"""
Laboratory assignment of a new batch (D18, createBatch step 4), the port of the `chooseLab` part of
backend-express/src/modules/batches/service.ts: the ACTIVE, non-deleted organization of type LAB with the fewest
non-deleted lab tests in QUEUED, SAMPLED or ESCALATED — among the laboratories of the field's region first, among all
when the region has none; ties by the smallest id as text (code points). The lab test (`reason` PLANNED for a SAMPLED
batch, else RISK; QUEUED; due in 5 working days) is written with its audit row and LAB_ASSIGNED for the laboratory and
the origin farm. No ACTIVE laboratory at all → 409 NO_LAB_AVAILABLE: the caller's transaction rolls back (R42).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import audit
from agrotrace.core.problem import AppProblem
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx
from agrotrace.domain.dates import add_working_days
from agrotrace.security.jwt import Principal

#: Lab tests that count as a laboratory's load (D18).
LOAD_STATUSES = ("QUEUED", "SAMPLED", "ESCALATED")
DUE_WORKING_DAYS = 5


def choose_lab(tx: Tx, region_id: str) -> dict[str, Any] | None:
    labs = tx.all(
        "SELECT o.id::text AS id, o.name, o.region_id::text AS region_id, "
        "(SELECT count(*) FROM lab_tests t WHERE t.lab_org_id = o.id AND t.deleted_at IS NULL "
        "AND t.status = ANY(%s)) AS load "
        "FROM organizations o WHERE o.type = 'LAB' AND o.status = 'ACTIVE' AND o.deleted_at IS NULL",
        [list(LOAD_STATUSES)],
    )
    if not labs:
        return None
    local = [lab for lab in labs if lab["region_id"] == region_id]
    pool = local or labs
    # Python compares str by code point (domain.strings): the smallest load, then the smallest id as text.
    return min(pool, key=lambda lab: (int(lab["load"]), lab["id"]))


def assign_lab(tx: Tx, batch: dict[str, Any], *, actor: Principal) -> str | None:
    """For a batch the risk model sent to a laboratory (`batch['test_required']`): the lab test, its audit row and
    LAB_ASSIGNED; returns the lab test id (None — no test required). `batch`: id, public_code, origin_org_id,
    region_id (the field's), product_name, test_reason. 409 NO_LAB_AVAILABLE when no laboratory is ACTIVE."""
    if not batch["test_required"]:
        return None
    lab = choose_lab(tx, batch["region_id"])
    if lab is None:
        raise AppProblem(409, "NO_LAB_AVAILABLE")
    reason = "PLANNED" if batch["test_reason"] == "SAMPLED" else "RISK"
    now = tx.now
    # addWorkingDays works on the millisecond instant (Date): the due date is stored at that precision.
    due_at = add_working_days(now.replace(microsecond=now.microsecond // 1000 * 1000), DUE_WORKING_DAYS)
    test_id = tx.scalar(
        "INSERT INTO lab_tests (batch_id, lab_org_id, reason, status, due_at, created_at, created_by) "
        "VALUES (%s, %s, %s, 'QUEUED', %s, %s, NULL) RETURNING id::text",
        [batch["id"], lab["id"], reason, due_at, now],
    )
    audit.record(tx, action="createBatch", entity_type="labTest", entity_id=test_id, actor=actor,
                 diff=audit.audit_diff(None, {"batchId": batch["id"], "labOrgId": lab["id"], "reason": reason,
                                              "status": "QUEUED", "dueAt": iso(due_at), "version": 1}))
    from agrotrace.modules.batches.lifecycle import notify

    notify(tx, "LAB_ASSIGNED", org_ids=[lab["id"], batch["origin_org_id"]], payload={
        "labTestId": test_id, "batchId": batch["id"], "publicCode": batch["public_code"],
        "productName": batch["product_name"], "labOrgId": lab["id"], "labName": lab["name"], "reason": reason,
        "dueAt": iso(due_at)})
    return test_id


def insert_unplanned(tx: Tx, *, batch: dict[str, Any], lab: dict[str, Any], reason: str, actor: Principal,
                     action: str) -> str:
    """An unplanned lab test, the port of backend-express/src/modules/lab/assign.ts `insertUnplannedLabTest`: QUEUED,
    `reason` INSPECTOR (createLabTest) or COMPLAINT (decideComplaint, Task 11), due in 5 working days, `created_by` =
    the user, version 1; the audit row (`action`) and LAB_ASSIGNED to the laboratory and the batch origin. `batch`:
    id, public_code, origin_org_id, product_name; `lab`: id, name. The caller checked both. Returns the test id."""
    now = tx.now
    due_at = add_working_days(now.replace(microsecond=now.microsecond // 1000 * 1000), DUE_WORKING_DAYS)
    test_id = tx.scalar(
        "INSERT INTO lab_tests (batch_id, lab_org_id, reason, status, due_at, created_at, updated_at, created_by, "
        "version) VALUES (%s, %s, %s, 'QUEUED', %s, %s, %s, %s, 1) RETURNING id::text",
        [batch["id"], lab["id"], reason, due_at, now, now, actor.user_id],
    )
    audit.record(tx, action=action, entity_type="labTest", entity_id=test_id, actor=actor,
                 diff=audit.audit_diff(None, {"batchId": batch["id"], "labOrgId": lab["id"], "reason": reason,
                                              "status": "QUEUED", "dueAt": iso(due_at), "version": 1}))
    from agrotrace.modules.batches.lifecycle import notify

    notify(tx, "LAB_ASSIGNED", org_ids=[lab["id"], batch["origin_org_id"]], payload={
        "labTestId": test_id, "batchId": batch["id"], "publicCode": batch["public_code"],
        "productName": batch["product_name"], "labOrgId": lab["id"], "labName": lab["name"], "reason": reason,
        "dueAt": iso(due_at)})
    return test_id
