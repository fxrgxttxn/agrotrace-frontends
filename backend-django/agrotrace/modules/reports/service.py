"""
downloadReport (contracts/openapi/paths/reports.yaml; FR-ANL-04, FR-ANL-05), the port of
backend-express/src/modules/reports/service.ts. Order: authentication and x-roles (ContractView) → `type` (path enum,
400) → access by `x-report-access` (read from the contract): `roles` — the whole system; `headRoles` — an organization
head (`is_org_admin`) of such a role, own organization only; neither — 403 FORBIDDEN without params → parameters in
one 400 (format required; window as the dashboard's; `recall`: from/to notAllowed, id required; `org`: id required
for full access, a head may omit it or pass its own; other types: id notAllowed) → admission (a full render queue →
503 report-busy, before any data is read) → in one READ ONLY REPEATABLE READ snapshot: 404 (recall or organization
missing/deleted), the contents → more than REPORT_MAX_ROWS data rows in a sheet → 400
`errors.type: [validation.report.tooManyRows]` → the file (not stored), rendered in the report Lane after the
snapshot's connection went back to the pool (P61).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agrotrace.core import contract
from agrotrace.core.config import get as config
from agrotrace.core.params import QueryReader
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.tx import Tx
from agrotrace.modules.analytics.dashboard import window_params
from agrotrace.modules.analytics.window import Window, resolve, snapshot
from agrotrace.modules.reports import render, sheets
from agrotrace.modules.reports.render import ReportSpec
from agrotrace.security.jwt import Principal

TYPES = ("batches", "recalls", "recall", "lab-tests", "complaints", "org")
FORMATS = ("xlsx", "pdf")
MIME = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pdf": "application/pdf",
}


@dataclass(frozen=True)
class ReportFile:
    body: bytes
    content_type: str
    file_name: str


def report_busy() -> AppProblem:
    return AppProblem(503, "BACKEND_UNAVAILABLE", params={"reason": "report-busy"})


def _access() -> dict[str, dict[str, list[str]]]:
    return contract.operation("downloadReport")["x-report-access"]


def download(p: Principal, report_type: str, request) -> ReportFile:
    max_rows = config().REPORT_MAX_ROWS
    if report_type not in TYPES:
        raise validation_problem({"type": ["validation.enum"]})
    a = _access()[report_type]
    full = any(r in a["roles"] for r in p.roles)
    head = not full and p.org_admin and any(r in a["headRoles"] for r in p.roles)
    if not full and not head:
        raise AppProblem(403, "FORBIDDEN")

    q = QueryReader(request)
    fmt = q.enum_of("format", FORMATS)
    if not q.has("format"):
        q.errors["format"] = ["validation.required"]
    report_id = q.uuid("id")
    window: tuple[str | None, str | None] = (None, None)
    if report_type == "recall":
        q.not_allowed("from")
        q.not_allowed("to")
        if not q.has("id"):
            q.errors["id"] = ["validation.required"]
    else:
        window = window_params(q)
        if report_type == "org":
            if full and not q.has("id"):
                q.errors["id"] = ["validation.required"]
            if head and report_id is not None and report_id != p.org_id:
                q.errors["id"] = ["validation.id.notAllowed"]
            if head:
                report_id = p.org_id
        else:
            q.not_allowed("id")
    q.done()
    if render.queue_full():
        raise report_busy()

    head_org = p.org_id if head else None

    def build(tx: Tx, now) -> tuple[sheets.Report | None, Any]:
        w = Window(*resolve(window, now))
        if report_type == "batches":
            return sheets.batches_report(tx, w, head_org, max_rows), now
        if report_type == "recalls":
            return sheets.recalls_report(tx, w, max_rows), now
        if report_type == "recall":
            return sheets.recall_report(tx, report_id), now  # type: ignore[arg-type]
        if report_type == "lab-tests":
            return sheets.lab_tests_report(tx, w, head_org, max_rows), now
        if report_type == "complaints":
            return sheets.complaints_report(tx, w, max_rows), now
        return sheets.org_report(tx, w, report_id, max_rows), now  # type: ignore[arg-type]

    report, at = snapshot(build)
    if report is None:
        raise AppProblem(404, "NOT_FOUND")
    if any(len(s.rows) > max_rows for s in report.sheets):
        raise validation_problem({"type": ["validation.report.tooManyRows"]})

    from agrotrace.core.render import iso

    spec = ReportSpec(title=report.title, period_line=report.period_line,
                      generated_line=f"Сформирован: {sheets.minute(at)} UTC", generated_at=iso(at),
                      sheets=tuple(report.sheets))
    try:
        body = render.render_in_lane(spec, fmt)  # type: ignore[arg-type]
    except render.ReportBusy:
        raise report_busy() from None
    return ReportFile(body, MIME[fmt], f"{report.file_base}.{fmt}")  # type: ignore[index]
