"""
Lab tests (contracts/openapi/paths/lab.yaml; БП-2, FR-QA-02…05, BR-02, R47, R57), the port of
backend-express/src/modules/lab/service.ts: the queue, the inspector's unplanned test, sample registration, results
(BR-02 conclusion; PASS → Approved, FAIL → Blocked and the recall engine, modules/recalls/engine.py), the PDF
protocol. Views and visibility — mappers.py.

Locks (R47/R52, P57): a mutation locks its test first (`labTest`, FOR NO KEY UPDATE), then — submitLabResults only —
the batches in ONE statement `ORDER BY id` (core.locks.lock_batches): PASS the test's batch, FAIL the test's batch and
every batch of the recall scope. Every check from 404 on runs over the locked test; `If-Match` is compared with its
version. A LAB mutation sees only the tests of the user's own laboratory (anything else is 404). Nothing locks a recall
row: reusing an OPEN recall writes only `lab_tests.recall_id`, whose FK check takes KEY SHARE on the recall — which
confirmRecallTask's FOR NO KEY UPDATE (recall → batch → task) does not conflict with, so the two never wait on each
other in a cycle (P57, the Express final-review deadlock).

submitLabResults runs at REPEATABLE READ like the recall engine (п. 8.2.3, RECALL_TX): a parallel FAIL on another test
of the same batch, a send, an accept or a processing that committed after this snapshot makes the batch lock fail with
40001 and the whole transaction runs once more — the repeat sees the other's result (the OPEN recall it created, the
batch InTransit with its receiver, the new link). Norm rows are read, not locked (decision 7 of Express Tasks 8–9).
Every instant written is the transaction's `now()` (P43). The public pages are dropped after the commit, once the
connection is back in the pool (P61); the protocol's bytes go to MinIO with no connection held.
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import audit, sql
from agrotrace.core.if_match import check_version
from agrotrace.core.multipart import Upload
from agrotrace.core.params import QueryReader, utc_day_bounds
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso, iso_or_null
from agrotrace.core.tx import RECALL_TX, Tx, with_tx
from agrotrace.core.validation import parse_request_body
from agrotrace.domain.decimal import compare_decimal_strings
from agrotrace.domain.rules import conclude_lab_test
from agrotrace.infra import outbox
from agrotrace.modules.batches.lifecycle import notify, transition_batch
from agrotrace.modules.batches.services import invalid_transition
from agrotrace.modules.batches.visibility import sees_all
from agrotrace.modules.files import services as files
from agrotrace.modules.lab import mappers
from agrotrace.modules.lab.assign import insert_unplanned
from agrotrace.modules.lab.serializers import LabResultsInput, LabSampleRequest, LabTestCreate
from agrotrace.modules.public import cache
from agrotrace.modules.recalls import engine
from agrotrace.security.jwt import Principal

#: uploadLabProtocol: a PDF ≤ 10 MiB inclusive (FR-QA-04, spec 8.6).
PROTOCOL_MAX_BYTES = 10 * 1024 * 1024
#: submitLabResults FAIL: `recalls.reason` (contract submitLabResults).
LAB_RECALL_REASON = "Превышение нормативов по результатам лабораторного анализа"

LIST_SORT_FIELDS = ("dueAt", "createdAt", "completedAt")
LIST_SORT_DEFAULT = "dueAt,asc"
_ORDER = {"dueAt": "t.due_at", "createdAt": "t.created_at", "completedAt": "t.completed_at"}
STATUSES = ("QUEUED", "SAMPLED", "DONE", "ESCALATED", "CANCELLED")
REASONS = ("PLANNED", "RISK", "COMPLAINT", "INSPECTOR")

_TEST_COLUMNS = ("id::text AS id, batch_id::text AS batch_id, lab_org_id::text AS lab_org_id, reason, status, "
                 "conclusion, sampled_at, completed_at, recall_id::text AS recall_id, version, "
                 "protocol_file_id::text AS protocol_file_id, deleted_at")
_RETURNING = _TEST_COLUMNS


def not_found() -> AppProblem:
    return AppProblem(404, "NOT_FOUND")


def lab_test_audit(t: dict[str, Any]) -> dict[str, Any]:
    return {"status": t["status"], "conclusion": t["conclusion"], "sampledAt": iso_or_null(t["sampled_at"]),
            "completedAt": iso_or_null(t["completed_at"]), "recallId": t["recall_id"], "version": t["version"]}


def current_version(test_id: str) -> dict[str, Any] | None:
    v = sql.scalar("SELECT version FROM lab_tests WHERE id = %s", [test_id])
    return {"currentVersion": v} if v is not None else None


def lock_own_test(tx: Tx, p: Principal, test_id: str) -> dict[str, Any]:
    """The non-deleted test of the user's own laboratory, locked FOR NO KEY UPDATE (R52 `labTest`); else 404 (also
    for a test of a deleted batch)."""
    t = tx.one(f"SELECT {_TEST_COLUMNS} FROM lab_tests WHERE id = %s FOR NO KEY UPDATE", [test_id])
    if t is None or t["deleted_at"] is not None or "LAB" not in p.roles or t["lab_org_id"] != p.org_id:
        raise not_found()
    if tx.scalar("SELECT deleted_at IS NULL FROM batches WHERE id = %s", [t["batch_id"]]) is not True:
        raise not_found()
    return t


def visible_test(p: Principal, test_id: str) -> None:
    """404 unless `p` sees the test (tag Lab)."""
    pred, params = mappers.visible_sql(p)
    ok = sql.scalar(
        "SELECT EXISTS (SELECT 1 FROM lab_tests t JOIN batches b ON b.id = t.batch_id WHERE t.id = %s "
        f"AND t.deleted_at IS NULL AND b.deleted_at IS NULL AND {pred})", [test_id, *params])
    if not ok:
        raise not_found()


# ── listLabTests / getLabTest ─────────────────────────────────────────────────────────────────────────────────────

def list_tests(p: Principal, request) -> dict[str, Any]:
    """Visible tests, filters joined by AND (R51 for labOrgId), `x-sort` (nulls last, then the id as C text)."""
    q = QueryReader(request)
    page, size, sort = q.page(LIST_SORT_FIELDS, LIST_SORT_DEFAULT)
    text = q.q()
    statuses = q.enum_list("status", STATUSES)
    reasons = q.enum_list("reason", REASONS)
    conclusion = q.enum_of("conclusion", ("PASS", "FAIL"))
    overdue = q.bool("overdue")
    batch_id = q.uuid("batchId")
    lab_org_id = None
    if sees_all(p):
        lab_org_id = q.uuid("labOrgId")
    else:
        q.not_allowed("labOrgId")
    frm, to = q.date_range()
    q.done()

    pred, params = mappers.visible_sql(p)
    conds = ["t.deleted_at IS NULL", "b.deleted_at IS NULL", pred]
    if statuses:
        conds.append("t.status = ANY(%s)")
        params.append(statuses)
    if reasons:
        conds.append("t.reason = ANY(%s)")
        params.append(reasons)
    if conclusion:
        conds.append("t.conclusion = %s")
        params.append(conclusion)
    if overdue is not None:
        conds.append(mappers.OVERDUE_SQL if overdue else f"NOT {mappers.OVERDUE_SQL}")
    if batch_id:
        conds.append("t.batch_id = %s")
        params.append(batch_id.lower())
    if lab_org_id:
        conds.append("t.lab_org_id = %s")
        params.append(lab_org_id.lower())
    day_conds, day_params = utc_day_bounds("t.created_at", frm, to)
    conds.extend(day_conds)
    params.extend(day_params)
    if text is not None:
        conds.append("position(lower(%s) in lower(b.public_code)) > 0")
        params.append(text)
    where = " AND ".join(conds)
    base = f"FROM lab_tests t JOIN batches b ON b.id = t.batch_id WHERE {where}"
    total = sql.scalar(f"SELECT count(*) {base}", params)
    direction = "ASC" if sort.dir == "asc" else "DESC"
    ids = [r["id"] for r in sql.all(
        f'SELECT t.id::text AS id {base} ORDER BY {_ORDER[sort.field]} {direction} NULLS LAST, t.id::text COLLATE "C" '
        "LIMIT %s OFFSET %s", [*params, size, (page - 1) * size])]
    return {"items": mappers.load_items(ids), "page": page, "size": size, "total": int(total)}


def get_test(p: Principal, test_id: str) -> dict[str, Any]:
    visible_test(p, test_id)
    return mappers.load_card(p, test_id)


# ── createLabTest ─────────────────────────────────────────────────────────────────────────────────────────────────

def create_test(p: Principal, body: Any) -> dict[str, Any]:
    """body → references in one 400 (batch non-deleted; organization non-deleted and ACTIVE, else notFound; not a
    LAB → validation.labOrg.type) → a QUEUED INSPECTOR test due in 5 working days, LAB_ASSIGNED (the laboratory and the
    batch origin). No locks: no existing row changes."""
    data = LabTestCreate.parse_body(body)
    batch_id = data["batchId"].lower()
    lab_org_id = data["labOrgId"].lower()

    def run(tx: Tx) -> str:
        errors: dict[str, list[str]] = {}
        b = tx.one("SELECT b.id::text AS id, b.public_code, b.origin_org_id::text AS origin_org_id, "
                   "pr.name AS product_name FROM batches b JOIN products pr ON pr.id = b.product_id "
                   "WHERE b.id = %s AND b.deleted_at IS NULL", [batch_id])
        if b is None:
            errors["batchId"] = ["validation.notFound"]
        lab = tx.one("SELECT id::text AS id, name, type, status FROM organizations WHERE id = %s "
                     "AND deleted_at IS NULL", [lab_org_id])
        if lab is None or lab["status"] != "ACTIVE":
            errors["labOrgId"] = ["validation.notFound"]
        elif lab["type"] != "LAB":
            errors["labOrgId"] = ["validation.labOrg.type"]
        if errors:
            raise validation_problem(errors)
        assert b is not None and lab is not None
        return insert_unplanned(tx, batch=b, lab=lab, reason="INSPECTOR", actor=p, action="createLabTest")

    test_id = with_tx(run)
    return mappers.load_card(p, test_id)


# ── registerLabSample ─────────────────────────────────────────────────────────────────────────────────────────────

def register_sample(p: Principal, test_id: str, version: int | None, if_match_errors: dict[str, list[str]],
                    body: Any) -> dict[str, Any]:
    """body/If-Match (one 400) → lock → 404 → If-Match → QUEUED → SAMPLED, sampledAt, version + 1."""
    LabSampleRequest.parse_body({} if body is None else body, extra_errors=if_match_errors)
    assert version is not None

    def run(tx: Tx) -> None:
        t = lock_own_test(tx, p, test_id)
        check_version(version, t["version"])
        if t["status"] != "QUEUED":
            raise invalid_transition(t["status"], "SAMPLED")
        after = tx.one(f"UPDATE lab_tests SET status = 'SAMPLED', sampled_at = %s, version = %s WHERE id = %s "
                       f"RETURNING {_RETURNING}", [tx.now, t["version"] + 1, test_id])
        assert after is not None
        audit.record(tx, action="registerLabSample", entity_type="labTest", entity_id=test_id, actor=p,
                     diff=audit.audit_diff(lab_test_audit(t), lab_test_audit(after)))

    with_tx(run, conflict_params=lambda: current_version(test_id))
    return mappers.load_card(p, test_id)


# ── submitLabResults ──────────────────────────────────────────────────────────────────────────────────────────────

def submit_results(p: Principal, test_id: str, version: int | None, if_match_errors: dict[str, list[str]],
                   body: Any) -> dict[str, Any]:
    """body/If-Match (one 400; a repeated indicator is step 5, P36) → lock the test → 404 → If-Match → status →
    the indicator set (one 400) → lock the batch (PASS) or the batch and the recall scope (FAIL) → results, DONE, the
    batch transition (only from OnTest), FAIL: the recall engine (new, or the OPEN one — R57) → LAB_RESULT,
    rating.recalculate (FARM origin)."""
    data = parse_request_body(LabResultsInput, body, defer_duplicates=["results"], extra_errors=if_match_errors)
    assert version is not None
    given = data["results"]

    def run(tx: Tx) -> list[str]:
        t = lock_own_test(tx, p, test_id)
        check_version(version, t["version"])
        if t["status"] not in mappers.LAB_OPEN:
            raise invalid_transition(t["status"], "DONE")

        # 5. The exact indicator set of the test's norms (D4) — duplicates and the mismatch in one 400.
        batch0 = tx.one("SELECT b.product_id::text AS product_id, pr.name AS product_name, o.type AS origin_type "
                        "FROM batches b JOIN products pr ON pr.id = b.product_id "
                        "JOIN organizations o ON o.id = b.origin_org_id WHERE b.id = %s", [t["batch_id"]])
        assert batch0 is not None
        norms = {n["indicatorId"]: n for n in mappers.current_norms(batch0["product_id"], tx)}
        ids = [r["indicatorId"].lower() for r in given]
        errors: dict[str, list[str]] = {}
        seen: set[str] = set()
        for i, x in enumerate(ids):
            if x in seen:
                errors[f"results[{i}].indicatorId"] = ["validation.duplicate"]
            seen.add(x)
        if len(seen) != len(norms) or any(x not in norms for x in seen):
            errors["results"] = ["validation.results.mismatch"]
        if errors:
            raise validation_problem(errors)

        rows = [{"indicatorId": x, "value": r["value"], "maxValue": norms[x]["maxValue"]}
                for x, r in zip(ids, given, strict=True)]
        concluded = conclude_lab_test(rows)
        if "error" in concluded:  # unreachable: minItems 1
            raise RuntimeError("conclude_lab_test: no results")
        conclusion = concluded["conclusion"]

        # The batch locks (R52): the test's batch, plus — FAIL without an OPEN recall — the recall scope, ONE statement.
        open_id = engine.find_open_recall(tx, t["batch_id"]) if conclusion == "FAIL" else None
        scope = engine.recall_scope(tx, t["batch_id"], False) if conclusion == "FAIL" and open_id is None else []
        locked = engine.lock_members(tx, [t["batch_id"], *(m.batch_id for m in scope)])
        b = locked[t["batch_id"]]

        exceeded = [compare_decimal_strings(r["value"], r["maxValue"]) > 0 for r in rows]
        tx.execute(
            "INSERT INTO lab_results (lab_test_id, indicator_id, value, norm_value_snapshot, is_exceeded) "
            "SELECT %s, x.i, x.v, x.n, x.e FROM unnest(%s::uuid[], %s::numeric[], %s::numeric[], %s::boolean[]) "
            "WITH ORDINALITY AS x(i, v, n, e, k) ORDER BY x.k",
            [test_id, [r["indicatorId"] for r in rows], [r["value"] for r in rows], [r["maxValue"] for r in rows],
             exceeded])
        # The batch page shows labSummary (R82): dropped after every result, whatever the batch status.
        changed = [b["public_code"]]
        if b["status"] == "OnTest":
            to = "Approved" if conclusion == "PASS" else "Blocked"
            v = transition_batch(tx, b, to, "LAB_PASS" if conclusion == "PASS" else "LAB_FAIL", p.user_id)
            audit.record(tx, action="submitLabResults", entity_type="batch", entity_id=b["id"], actor=p,
                         diff={"status": [b["status"], to], "version": [b["version"], v]})
            locked[b["id"]] = {**b, "status": to, "version": v}

        recall_id: str | None = None
        if conclusion == "FAIL":
            if open_id is not None:
                recall_id = open_id
            else:
                outcome = engine.apply_recall(tx, engine.RecallRequest(
                    source_batch_id=t["batch_id"], trigger="LAB", reason=LAB_RECALL_REASON, block_upstream=False,
                    opened_by=p.user_id, action="submitLabResults", lab_test_id=test_id), scope, locked)
                recall_id = outcome.recall_id
                changed.extend(outcome.changed_codes)

        now = tx.now
        after = tx.one(
            "UPDATE lab_tests SET status = 'DONE', conclusion = %s, completed_at = %s, "
            "sampled_at = coalesce(sampled_at, %s), recall_id = %s, version = %s WHERE id = %s "
            f"RETURNING {_RETURNING}", [conclusion, now, now, recall_id, t["version"] + 1, test_id])
        assert after is not None
        audit.record(tx, action="submitLabResults", entity_type="labTest", entity_id=test_id, actor=p, diff={
            **audit.audit_diff(lab_test_audit(t), lab_test_audit(after)),
            "results": [None, [{"indicatorId": r["indicatorId"], "value": r["value"], "normValue": r["maxValue"],
                                "isExceeded": e} for r, e in zip(rows, exceeded, strict=True)]],
        })
        holder = b["holder_org_id"]
        notify(tx, "LAB_RESULT",
               org_ids=[b["origin_org_id"], holder] if holder and holder != b["origin_org_id"] else [b["origin_org_id"]],
               roles=["INSPECTOR"] if t["reason"] in ("INSPECTOR", "COMPLAINT") else [],
               payload={"labTestId": test_id, "batchId": b["id"], "publicCode": b["public_code"],
                        "productName": batch0["product_name"], "conclusion": conclusion, "recallId": recall_id})
        if batch0["origin_type"] == "FARM":
            outbox.enqueue(tx, "rating.recalculate", {
                "organizationId": b["origin_org_id"], "cause": "LAB_PASS" if conclusion == "PASS" else "LAB_FAIL",
                "sourceId": test_id})
        cache.schedule_drop(tx, changed)
        return changed

    with_tx(run, **RECALL_TX, conflict_params=lambda: current_version(test_id))
    return mappers.load_card(p, test_id)


# ── uploadLabProtocol / downloadLabProtocol ───────────────────────────────────────────────────────────────────────

def upload_protocol(p: Principal, test_id: str, upload: Upload) -> dict[str, Any]:
    """(400/413 by the reader) → 404 (own laboratory) → 415 (a PDF by signature) → MinIO → the file row and the test's
    protocol replaced under the test's lock (the old file soft-deleted, its URLs answer 404; version unchanged). No
    pool connection is held while the bytes go to MinIO (P61): the first check and the final write are separate
    transactions, and the final one re-checks over the locked test."""
    with_tx(lambda tx: lock_own_test(tx, p, test_id))
    f = files.prepare(upload, kind="LAB_PROTOCOL", owner_id=p.user_id, allowed=["application/pdf"])
    files.store_objects(f)

    def run(tx: Tx) -> None:
        t = lock_own_test(tx, p, test_id)
        now = tx.now
        files.insert(tx, f)
        tx.execute("UPDATE lab_tests SET protocol_file_id = %s WHERE id = %s", [f.id, test_id])
        audit.record(tx, action="uploadLabProtocol", entity_type="file", entity_id=f.id, actor=p,
                     diff=audit.audit_diff(None, files.audit_view(f)))
        audit.record(tx, action="uploadLabProtocol", entity_type="labTest", entity_id=test_id, actor=p,
                     diff={"protocolFileId": [t["protocol_file_id"], f.id]})
        if files.soft_delete(tx, t["protocol_file_id"], now):
            audit.record(tx, action="uploadLabProtocol", entity_type="file", entity_id=t["protocol_file_id"],
                         actor=p, diff={"deletedAt": [None, iso(now)]})

    with_tx(run)
    return files.file_ref(f)


def protocol_file(p: Principal, test_id: str) -> dict[str, Any]:
    """The visible test's current protocol (404: invisible, none)."""
    visible_test(p, test_id)
    f = sql.one(f"SELECT {files.columns('f')} FROM lab_tests t JOIN files f ON f.id = t.protocol_file_id "
                "WHERE t.id = %s AND f.deleted_at IS NULL", [test_id])
    if f is None:
        raise not_found()
    return f
