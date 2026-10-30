"""The report Lane (modules/reports/render.py; paths/reports.yaml, P52): one render at a time in a child process, 4
waiting, 120 s from enqueue, 1 GiB. A full queue (1 + 4) → 503 `{reason: "report-busy"}` before any data is read
(N3); a render past its deadline → 503; a client that went away (`client_gone()`, D-I7) gives up its waiting place."""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from agrotrace.core.problem import AppProblem
from agrotrace.infra.lanes import Lane
from agrotrace.modules.reports import render, service
from agrotrace.modules.reports.render import ReportSpec, Sheet
from agrotrace.security.jwt import Principal
from tests import lane_jobs

INSPECTOR = Principal(user_id="u", org_id="o", roles=("INSPECTOR",), org_admin=False)


@pytest.fixture
def lane(monkeypatch):
    """A fresh report Lane for the test (the module's own is replaced and shut down afterwards)."""
    created: list[Lane] = []

    def make(**kw) -> Lane:
        ln = Lane("report", max_waiting=kw.get("max_waiting", render.LANE_WAITING),
                  deadline_s=kw.get("deadline_s", render.LANE_DEADLINE_S), memory_mb=render.LANE_MEMORY_MB)
        monkeypatch.setattr(render, "_lane", ln)
        created.append(ln)
        return ln

    yield make
    for ln in created:
        if ln._executor is not None:
            ln._kill(ln._executor)


def _occupy(ln: Lane, n: int, seconds: float) -> list[threading.Thread]:
    threads = [threading.Thread(target=ln.run, args=(lane_jobs.slow, seconds), kwargs={"cancelled": lambda: False},
                                daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
        time.sleep(0.05)
    deadline = time.monotonic() + 30
    while ln.size < n and time.monotonic() < deadline:
        time.sleep(0.02)
    return threads


def test_the_lane_is_one_running_four_waiting_120_s_1_gib():
    ln = render.lane()
    assert (ln.max_running, ln.max_waiting, ln.deadline_s, ln.memory_mb) == (1, 4, 120.0, 1024)


def test_a_full_queue_is_503_report_busy_before_any_data_is_read(lane, monkeypatch):
    ln = lane()
    threads = _occupy(ln, 5, 3)
    assert ln.size == 5 and render.queue_full()

    def no_snapshot(*a, **kw):
        raise AssertionError("the snapshot must not be taken when the queue is full")

    monkeypatch.setattr(service, "snapshot", no_snapshot)
    with pytest.raises(AppProblem) as e:
        service.download(INSPECTOR, "complaints", {"format": "xlsx"})
    assert (e.value.status, e.value.code, e.value.params) == (503, "BACKEND_UNAVAILABLE", {"reason": "report-busy"})
    # Parameters are still checked first: a bad request is a 400, not a 503.
    with pytest.raises(AppProblem) as e:
        service.download(INSPECTOR, "complaints", {})
    assert e.value.status == 400
    for t in threads:
        t.join(30)
    assert not render.queue_full()


def _big_spec(rows: int) -> ReportSpec:
    header = [f"Колонка {i}" for i in range(12)]
    data = [[("text", f"Строка {r} ячейка {i} с длинным текстом для переноса") for i in range(12)] for r in range(rows)]
    return ReportSpec("Тест", "Период: —", "Сформирован: —", "2026-10-26T10:00:00.000Z", (Sheet("Лист", header, data),))


def test_a_render_past_its_deadline_is_503(lane, monkeypatch):
    lane(deadline_s=1.0)
    started = time.monotonic()
    with pytest.raises(render.ReportBusy):
        render.render_in_lane(_big_spec(60_000), "pdf", cancelled=lambda: False)
    assert time.monotonic() - started < 15
    # Through the service: the same 503 problem.
    monkeypatch.setattr(service, "config", lambda: SimpleNamespace(REPORT_MAX_ROWS=50_000))
    monkeypatch.setattr(render, "render_in_lane", lambda *a, **kw: (_ for _ in ()).throw(render.ReportBusy("timeout")))
    monkeypatch.setattr(service, "snapshot", lambda fn: (service.sheets.Report("T", "f", "p", []), _now()))
    with pytest.raises(AppProblem) as e:
        service.download(INSPECTOR, "complaints", {"format": "pdf"})
    assert (e.value.status, e.value.params) == (503, {"reason": "report-busy"})


def _now():
    from datetime import UTC, datetime

    return datetime(2026, 10, 26, 10, 0, tzinfo=UTC)


def test_a_client_that_went_away_gives_up_its_waiting_place(lane):
    ln = lane()
    threads = _occupy(ln, 5, 3)
    assert render.queue_full()
    gone = threading.Event()
    result: list[BaseException] = []

    def waiter() -> None:
        try:
            render.render_in_lane(_big_spec(1), "xlsx", cancelled=gone.is_set)
        except BaseException as e:  # noqa: BLE001 - the outcome is the assertion
            result.append(e)

    # The fifth place frees once one occupier ends; until then this request is refused, so wait for room first.
    for t in threads:
        t.join(30)
    blockers = _occupy(ln, 4, 3)  # 1 running + 3 waiting
    w = threading.Thread(target=waiter, daemon=True)
    w.start()
    deadline = time.monotonic() + 10
    while ln.size < 5 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert ln.size == 5 and render.queue_full()
    gone.set()
    w.join(5)
    assert result and isinstance(result[0], render.ReportAborted)
    assert ln.size == 4 and not render.queue_full()  # its place is free while the others still wait
    for t in blockers:
        t.join(30)


def test_the_render_job_produces_both_formats():
    spec = _big_spec(3)
    assert render.render(spec, "pdf")[:5] == b"%PDF-"
    assert render.render(spec, "xlsx")[:2] == b"PK"


def _bearer(roles: tuple[str, ...]) -> dict[str, str]:
    import uuid
    from datetime import UTC, datetime

    from agrotrace.security.jwt import issue_access_token

    p = Principal(user_id=str(uuid.uuid4()), org_id=str(uuid.uuid4()), roles=roles, org_admin=False)
    return {"authorization": f"Bearer {issue_access_token(p, datetime.now(UTC))}"}


def test_over_http_a_gone_client_frees_its_place_and_a_full_queue_is_503(lane, db):
    """Through the ASGI application (D-I7: `http.disconnect` → client_gone() in the view's thread)."""
    import asyncio

    from tests.asgi_client import call

    ln = lane()
    blockers = _occupy(ln, 4, 4)  # 1 running + 3 waiting
    path = "/api/v1/reports/complaints?format=xlsx&from=2020-01-01&to=2020-01-01"
    started = time.monotonic()
    asyncio.run(call("GET", path, headers=_bearer(("INSPECTOR",)), disconnect_after=0.5))
    assert time.monotonic() - started < 3  # it left the queue at once, not after the running render
    deadline = time.monotonic() + 5
    while ln.size != 4 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert ln.size == 4  # its waiting place is free again
    more = _occupy(ln, 1, 4)  # the fifth place taken by someone else: now the queue is full
    deadline = time.monotonic() + 5
    while ln.size != 5 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert ln.size == 5
    res = asyncio.run(call("GET", path, headers=_bearer(("INSPECTOR",))))
    assert res.status == 503 and res.json()["params"] == {"reason": "report-busy"}
    assert res.headers["content-type"].startswith("application/problem+json")
    for t in blockers + more:
        t.join(30)
