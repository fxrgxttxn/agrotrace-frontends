"""
The public part (contracts/openapi/paths/public.yaml; FR-PUB-01…03, R30, R82, P9, P10), no authentication — the port
of backend-express/src/modules/public/service.ts:

- getPublicBatch — the PublicBatch of a non-deleted batch, cached in the shared Redis as `pub:batch:{publicCode}` (the
  exact JSON, EX 300): a hit is sent byte for byte, never parsed or re-serialized; the keys are deleted after the
  commit by every operation that changes the page (cache.py); after its SET the builder re-reads the batch's version
  and deletes the key if it changed meanwhile (no stale safety status after a parallel recall or block). No personal
  data: organization names, region, dates, the lab summary and the status only. Product photos and logos are the
  seeded `files` rows as they are (public URLs, P32).
- getCaptchaChallenge — an ALTCHA challenge (infra.altcha), `Cache-Control: no-store` (the view).
- createPublicComplaint — order: the `complaint-ip` limit (ContractView.initial: every request counts,
  RATE_LIMIT_OVERRIDES honoured) → the publicCode pattern and the body in one 400 → the ALTCHA solution (invalid,
  expired or already used → 400 CAPTCHA_FAILED) → the batch (404; a solution is not used up by a 404) → the solution
  marked used (`altcha-used:{signature}` SET NX EX 600; a parallel replay loses here) → the complaint NEW, its audit
  row (no actor), COMPLAINT to the inspectors in the outbox.

P61: every SQL statement outside the transaction is its own (no pool connection is held across a Redis call or the
proof-of-work check).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import audit, sql
from agrotrace.core.patterns import ecma
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso, iso_or_null, json_bytes
from agrotrace.core.tx import Tx, with_tx
from agrotrace.core.validation import parse_request_body
from agrotrace.infra import altcha, file_urls
from agrotrace.modules.batches.lifecycle import notify
from agrotrace.modules.batches.services import path_stages
from agrotrace.modules.complaints.serializers import PublicComplaintRequest

#: Contract `PublicCode` parameter.
PUBLIC_CODE = ecma(r"^AT-\d{4}-\d{6,}$")
PAGE_TTL_SEC = 300

#: SafetyStatus by the batch status (schema SafetyStatus); every other status is SAFE.
SAFETY = {"Recalled": "RECALLED", "WrittenOff": "RECALLED", "Blocked": "BLOCKED", "Created": "UNKNOWN",
          "OnTest": "UNKNOWN"}


def _code_ok(code: str) -> bool:
    return PUBLIC_CODE.search(code) is not None


def not_found() -> AppProblem:
    return AppProblem(404, "NOT_FOUND")


def captcha_failed() -> AppProblem:
    return AppProblem(400, "CAPTCHA_FAILED")


def _redis():
    from agrotrace.infra import redis

    return redis.client()


# ── getPublicBatch ────────────────────────────────────────────────────────────────────────────────────────────────

def build_page(code: str) -> tuple[dict[str, Any], str, int] | None:
    """(PublicBatch, batch id, version) of the non-deleted batch with `code`, or None."""
    b = sql.one(
        "SELECT b.id::text AS id, b.public_code, b.kind, b.status, b.version, b.origin_org_id::text AS origin_org_id, "
        "b.harvested_at, b.produced_at, b.created_at, p.name AS product_name, p.category AS product_category, "
        "p.image_file_id::text AS product_image, o.name AS origin_name, o.logo_file_id::text AS origin_logo, "
        "r.code AS region_code, r.name AS region_name "
        "FROM batches b JOIN products p ON p.id = b.product_id JOIN organizations o ON o.id = b.origin_org_id "
        "JOIN regions r ON r.id = o.region_id WHERE b.public_code = %s AND b.deleted_at IS NULL", [code])
    if b is None:
        return None
    done = sql.all(
        "SELECT conclusion, completed_at FROM lab_tests WHERE batch_id = %s AND status = 'DONE' "
        'AND deleted_at IS NULL AND completed_at IS NOT NULL ORDER BY completed_at, id::text COLLATE "C"', [b["id"]])
    last = done[-1] if done else None
    path = path_stages(b)
    page = {
        "publicCode": b["public_code"],
        "product": {
            "name": b["product_name"],
            "category": b["product_category"],
            "imageUrl": file_urls.public_url(b["product_image"]) if b["product_image"] else None,
        },
        "origin": {
            "farmName": b["origin_name"],
            "logoUrl": file_urls.public_url(b["origin_logo"]) if b["origin_logo"] else None,
            "region": {"code": b["region_code"], "name": b["region_name"]},
        },
        "harvestedAt": iso_or_null(b["harvested_at"]),
        "producedAt": iso_or_null(b["produced_at"]),
        "status": b["status"],
        "safety": SAFETY.get(b["status"], "SAFE"),
        "path": [{"orgName": s["org"]["name"], "orgType": s["org"]["type"], "logoUrl": s["org"]["logoUrl"],
                  "from": s["from"], "to": s["to"]} for s in path],
        "labSummary": {
            "total": len(done),
            "passed": sum(1 for t in done if t["conclusion"] == "PASS"),
            "lastConclusion": last["conclusion"] if last else None,
            "lastDate": iso_or_null(last["completed_at"]) if last else None,
        },
    }
    return page, b["id"], b["version"]


def page_bytes(code: str) -> bytes:
    """getPublicBatch — the page bytes (from the cache, or freshly built and stored)."""
    if not _code_ok(code):
        raise validation_problem({"publicCode": ["validation.pattern"]})
    key = f"pub:batch:{code}"
    r = _redis()
    hit = r.get(key)
    if hit is not None:
        return hit
    built = build_page(code)
    if built is None:
        raise not_found()
    page, batch_id, version = built
    body = json_bytes(page)
    r.set(key, body, ex=PAGE_TTL_SEC)
    # R82 re-check: a change that committed (and deleted the key) while the page was being built would otherwise leave
    # a stale page — e.g. SAFE for a batch just recalled — for 5 minutes. Every status change bumps the version.
    if sql.scalar("SELECT version FROM batches WHERE id = %s", [batch_id]) != version:
        r.delete(key)
    return body


# ── getCaptchaChallenge ───────────────────────────────────────────────────────────────────────────────────────────

def captcha() -> dict[str, Any]:
    return altcha.challenge(altcha.now_ms())


# ── createPublicComplaint ─────────────────────────────────────────────────────────────────────────────────────────

def complain(ip: str | None, code: str, body: Any) -> dict[str, Any]:
    """createPublicComplaint after the `complaint-ip` limit (see the module docstring for the order)."""
    code_errors = {} if _code_ok(code) else {"publicCode": ["validation.pattern"]}
    data = parse_request_body(PublicComplaintRequest, body, extra_errors=code_errors)
    signature = altcha.verify(data["altcha"], altcha.now_ms())
    r = _redis()
    used = f"altcha-used:{signature}"
    if signature is None or r.exists(used) == 1:
        raise captcha_failed()
    b = sql.one("SELECT b.id::text AS id, b.public_code, p.name AS product_name FROM batches b "
                "JOIN products p ON p.id = b.product_id WHERE b.public_code = %s AND b.deleted_at IS NULL", [code])
    if b is None:
        raise not_found()
    if not r.set(used, "1", ex=altcha.ALTCHA_TTL_SEC, nx=True):
        raise captcha_failed()
    contact = data.get("contact")

    def run(tx: Tx) -> dict[str, Any]:
        row = tx.one("INSERT INTO complaints (batch_id, text, contact, status, ip) VALUES (%s, %s, %s, 'NEW', %s::inet) "
                     "RETURNING id::text AS id, created_at", [b["id"], data["text"], contact, ip])
        assert row is not None
        audit.record(tx, action="createPublicComplaint", entity_type="complaint", entity_id=row["id"], actor=None,
                     diff=audit.audit_diff(None, {"batchId": b["id"], "text": data["text"], "contact": contact,
                                                  "status": "NEW"}))
        notify(tx, "COMPLAINT", roles=["INSPECTOR"], payload={
            "complaintId": row["id"], "batchId": b["id"], "publicCode": b["public_code"],
            "productName": b["product_name"]})
        return {"id": row["id"], "createdAt": iso(row["created_at"])}

    return with_tx(run)
