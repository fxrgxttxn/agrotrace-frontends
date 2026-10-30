"""
Processing (contracts/openapi/paths/processing.yaml; FR-PROD-06, БП-4, BR-04/05/06, D19, D20), the port of
backend-express/src/modules/processing/service.ts: the inputs of the processor's organization become Processed, each
output a new DERIVED batch (Approved, version 2), every (input, output) pair a `batch_links` edge with the input's
whole `massUsedKg`.

One READ COMMITTED transaction (R47, P57): the existing inputs are locked FOR NO KEY UPDATE in ONE statement
`ORDER BY id` right after the body check (the same statement and order as the waybill operations, so a parallel
sendWaybill or processing over the same batches waits and then sees the other's result — InTransit/Processed → BR-05,
or its own 409); the output products are taken FOR SHARE (as createBatch takes its product). References, the
per-input rules and the balance run over the locked rows. Every instant the operation writes is the transaction's
`now()` (P43): the outputs' producedAt/createdAt, the history rows, the links. The mass balance is computed in integer
grams (domain.rules.check_mass_balance), never with a float. No outbox event (Express emits none); the public pages of
the inputs are dropped after the commit, once the connection is back in the pool (P61). A second deadlock → 409
VERSION_CONFLICT without params (P55, with_tx).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import audit, locks
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.tx import Tx, with_tx
from agrotrace.core.validation import parse_request_body
from agrotrace.domain.decimal import compare_decimal_strings
from agrotrace.domain.rules import can_use_as_input, check_mass_balance
from agrotrace.modules.batches import mappers
from agrotrace.modules.batches.lifecycle import transition_batch
from agrotrace.modules.batches.services import BATCH_COLUMNS, batch_audit, not_holder
from agrotrace.modules.batches.visibility import batch_visible_sql
from agrotrace.modules.processing.serializers import ProcessingRequest
from agrotrace.modules.public import cache
from agrotrace.security.jwt import Principal

_RETURNING = BATCH_COLUMNS.replace("b.", "")


def business_rule(rule: str, params: dict[str, Any]) -> AppProblem:
    return AppProblem(422, "BUSINESS_RULE", rule=rule, params=params)


def lock_inputs(tx: Tx, ids: list[str]) -> list[dict[str, Any]]:
    """The input batches FOR NO KEY UPDATE in ONE statement `ORDER BY id` (deleted ones included — visibility is the
    caller's check; core.locks.lock_batches, the same statement as the waybill operations); missing ids are absent."""
    return locks.lock_batches(tx, ids, BATCH_COLUMNS)


def _ancestors(tx: Tx, batch_id: str) -> set[str]:
    """Ancestors of `batch_id` at all depths (UNION terminates on the acyclic graph and on a corrupt cyclic one)."""
    rows = tx.all(
        "WITH RECURSIVE up(id) AS ("
        " SELECT parent_batch_id FROM batch_links WHERE child_batch_id = %s"
        " UNION"
        " SELECT l.parent_batch_id FROM batch_links l JOIN up ON l.child_batch_id = up.id"
        ") SELECT id::text AS id FROM up", [batch_id])
    return {r["id"] for r in rows}


def process(p: Principal, body: Any) -> dict[str, Any]:
    """processBatches: body (400, a repeated input is step 1) → lock the inputs → references in one 400 → per input in
    request order NOT_HOLDER / BR-06 / BR-05 → BR-04 → inputs Processed, outputs created, linked and Approved →
    GRAPH_CYCLE (defensive) → 201 `{outputs, balance}`."""
    data = parse_request_body(ProcessingRequest, body, masses=[("inputs", "massUsedKg"), ("outputs", "massKg")])
    inputs_in = data["inputs"]
    outputs_in = data["outputs"]
    ids = [it["batchId"].lower() for it in inputs_in]
    product_ids = [o["productId"].lower() for o in outputs_in]

    def run(tx: Tx) -> tuple[list[str], dict[str, str]]:
        locked = lock_inputs(tx, ids)
        by_id = {b["id"]: b for b in locked}

        # 2. References — every error of the step in one 400.
        visible: set[str] = set()
        if locked:
            pred, params = batch_visible_sql(p, "b.id")
            visible = {r["id"] for r in tx.all(
                f"SELECT b.id::text AS id FROM batches b WHERE b.id = ANY(%s::uuid[]) AND b.deleted_at IS NULL "
                f"AND {pred}", [[b["id"] for b in locked], *params])}
        products = {r["id"] for r in tx.all(
            "SELECT id::text AS id FROM products WHERE id = ANY(%s::uuid[]) AND deleted_at IS NULL ORDER BY id "
            "FOR SHARE", [sorted(set(product_ids))])}
        errors: dict[str, list[str]] = {}
        for i, (it, bid) in enumerate(zip(inputs_in, ids, strict=True)):
            b = by_id.get(bid)
            if b is None or bid not in visible:
                errors[f"inputs[{i}].batchId"] = ["validation.notFound"]
            elif compare_decimal_strings(it["massUsedKg"], b["mass_kg"]) > 0:
                errors[f"inputs[{i}].massUsedKg"] = ["validation.mass.exceedsBatch"]
        for i, pid in enumerate(product_ids):
            if pid not in products:
                errors[f"outputs[{i}].productId"] = ["validation.notFound"]
        if errors:
            raise validation_problem(errors)

        # 3. Per input in request order: side, BR-06, BR-05.
        inputs = [by_id[bid] for bid in ids]
        for b in inputs:
            if b["holder_org_id"] != p.org_id:
                raise not_holder(b["public_code"])
            if b["status"] in ("Blocked", "Recalled"):
                raise business_rule("BR-06", {"publicCode": b["public_code"], "status": b["status"]})
            if not can_use_as_input(b["status"])["allowed"]:
                raise business_rule("BR-05", {"publicCode": b["public_code"], "status": b["status"]})

        # 4. BR-04 with the loss norm of each input's product (the numeric(5,2) text, never a float).
        losses = {r["id"]: format(r["loss_norm_percent"], "f") for r in tx.all(
            "SELECT id::text AS id, loss_norm_percent FROM products WHERE id = ANY(%s::uuid[])",
            [sorted({b["product_id"] for b in inputs})])}
        mb = check_mass_balance(
            [{"massUsedKg": it["massUsedKg"], "lossNormPercent": losses[b["product_id"]]}
             for it, b in zip(inputs_in, inputs, strict=True)],
            [{"massKg": o["massKg"]} for o in outputs_in])
        if "error" in mb:  # unreachable: minItems 1
            raise RuntimeError(f"check_mass_balance: {mb['error']}")
        totals = {"inputKg": mb["inputKg"], "allowedKg": mb["allowedKg"], "outputKg": mb["outputKg"]}
        if not mb["ok"]:
            raise business_rule("BR-04", totals)

        # Result.
        now = tx.now
        for b in sorted(inputs, key=lambda x: x["id"]):  # the batch writes in id order (code points)
            v = transition_batch(tx, b, "Processed", "PROCESSED", p.user_id)
            audit.record(tx, action="processBatches", entity_type="batch", entity_id=b["id"], actor=p,
                         diff={"status": [b["status"], "Processed"], "version": [b["version"], v]})
        parents = [{"batchId": b["id"], "massUsedKg": it["massUsedKg"]}
                   for it, b in zip(inputs_in, inputs, strict=True)]
        output_ids: list[str] = []
        for o, pid in zip(outputs_in, product_ids, strict=True):
            out = tx.one(
                "INSERT INTO batches (public_code, product_id, origin_org_id, holder_org_id, field_id, kind, mass_kg, "
                "harvested_at, produced_at, status, test_required, test_reason, version, created_by, created_at, "
                "updated_at) VALUES (next_batch_code(), %s, %s, %s, NULL, 'DERIVED', %s, NULL, %s, 'Created', false, "
                f"'NONE', 1, %s, %s, %s) RETURNING {_RETURNING}",
                [pid, p.org_id, p.org_id, o["massKg"], now, p.user_id, now, now])
            assert out is not None
            tx.execute("INSERT INTO batch_status_history (batch_id, from_status, to_status, changed_by, reason, "
                       "changed_at) VALUES (%s, NULL, 'Created', %s, 'CREATED', %s)", [out["id"], p.user_id, now])
            version = transition_batch(tx, out, "Approved", "TEST_NOT_REQUIRED", None)
            # 5. Defensive acyclicity (§7.5): walking up from each parent must never meet the new child.
            for parent in inputs:
                if parent["id"] == out["id"] or out["id"] in _ancestors(tx, parent["id"]):
                    raise AppProblem(409, "GRAPH_CYCLE", params={"parentCode": parent["public_code"],
                                                                  "childCode": out["public_code"]})
            tx.execute(
                "INSERT INTO batch_links (parent_batch_id, child_batch_id, mass_used_kg, created_at) "
                "SELECT x.parent, %s, x.mass, %s FROM unnest(%s::uuid[], %s::numeric[]) "
                "WITH ORDINALITY AS x(parent, mass, n) ORDER BY x.n",
                [out["id"], now, [x["batchId"] for x in parents], [x["massUsedKg"] for x in parents]])
            audit.record(tx, action="processBatches", entity_type="batch", entity_id=out["id"], actor=p,
                         diff=audit.audit_diff(None, {**batch_audit({**out, "status": "Approved", "version": version}),
                                                      "parents": parents}))
            output_ids.append(out["id"])
        cache.schedule_drop(tx, [b["public_code"] for b in inputs])
        return output_ids, totals

    output_ids, balance = with_tx(run)
    return {"outputs": [mappers.load_card(p, oid) for oid in output_ids], "balance": balance}
