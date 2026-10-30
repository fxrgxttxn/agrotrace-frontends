"""
Report rendering off the request threads (P52), the port of backend-express/src/modules/reports/render.ts +
infra/report-render.ts: `render(spec, fmt)` runs in the report Lane — a child process (openpyxl-free XLSX and the PDF
writer are pure Python and hold the GIL, so a thread would stall the api), one render at a time, at most 4 more
waiting, 120 s from enqueue (waiting included), RLIMIT_AS 1 GiB. A full queue, a missed deadline or a crashed or
evicted child → 503 BACKEND_UNAVAILABLE `{reason: "report-busy"}`; a client that went away gives up its place
(`client_gone()`, D-I7: a waiting job never runs; a running render finishes and its file is dropped).

`queue_full()` is the admission check made before the snapshot (N3): refused requests cost no database work. A burst
can still pass it together; the Lane itself stays the hard bound.

This module is what the Lane's child imports: standard library and the infra writers only (no Django).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

LANE_WAITING = 4
LANE_DEADLINE_S = 120.0
LANE_MEMORY_MB = 1024


@dataclass
class Sheet:
    """One sheet: name, column headers, rows of `(type, value)` cells (modules/reports/sheets.py)."""

    name: str
    header: list[str]
    rows: list[list[tuple[str, Any]]] = field(default_factory=list)


@dataclass(frozen=True)
class ReportSpec:
    """Plain data (pickled to the child): the PDF title, the period and generation lines, the snapshot instant (ISO)
    and the sheets."""

    title: str
    period_line: str
    generated_line: str
    generated_at: str
    sheets: tuple[Sheet, ...]


def _cell_text(c: tuple[str, Any]) -> str:
    """The PDF text of a cell: `String(v)` — counts as integers, masses and decimals as their strings."""
    return "" if c[1] is None else str(c[1])


def render(spec: ReportSpec, fmt: Literal["xlsx", "pdf"]) -> bytes:
    """The file bytes (the Lane job)."""
    if fmt == "xlsx":
        from agrotrace.infra.xlsx_write import write_xlsx

        return write_xlsx(spec.sheets, spec.generated_at)
    from agrotrace.infra.pdf import report_pdf

    return report_pdf(title=spec.title, period_line=spec.period_line, generated_line=spec.generated_line,
                      generated_at_iso=spec.generated_at,
                      sheets=[(s.name, list(s.header), [[_cell_text(c) for c in row] for row in s.rows])
                              for s in spec.sheets])


class ReportBusy(Exception):
    """Refused, timed out, crashed or evicted: 503 report-busy."""


class ReportAborted(Exception):
    """The client went away: nobody gets an answer."""


_lane = None


def lane():
    global _lane
    if _lane is None:
        from agrotrace.infra.lanes import Lane

        _lane = Lane("report", max_waiting=LANE_WAITING, deadline_s=LANE_DEADLINE_S, memory_mb=LANE_MEMORY_MB)
    return _lane


def queue_full() -> bool:
    """True while the Lane holds a running job and LANE_WAITING waiting ones."""
    return _lane is not None and _lane.size >= 1 + LANE_WAITING


def render_in_lane(spec: ReportSpec, fmt: Literal["xlsx", "pdf"],
                   cancelled: Callable[[], bool] | None = None) -> bytes:
    from agrotrace.core.context import client_gone

    out = lane().run(render, spec, fmt, cancelled=cancelled or client_gone)
    if out.ok:
        return out.value
    if out.reason == "aborted":
        raise ReportAborted
    raise ReportBusy(out.cause)
