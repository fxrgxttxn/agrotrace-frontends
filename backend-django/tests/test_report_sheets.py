"""Report sheets on agrotrace_test_django (modules/reports/sheets.py; paths/reports.yaml `Файл` and the report list):
sheet names, columns, row order and cell types of each of the six reports; the XLSX as a reader sees it (string
cells, numbers with formats `0` / `0.000` / `0.00`, the bold header, moments `YYYY-MM-DD HH:MM` UTC truncated); no
buyer contact in the complaints report; REPORT_MAX_ROWS = 13: 13 rows → a file, 14 → `validation.report.tooManyRows`."""

from __future__ import annotations

import io
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from openpyxl import load_workbook

from agrotrace.core import sql
from agrotrace.core.problem import AppProblem
from agrotrace.core.tx import RECALL_TX, with_tx
from agrotrace.modules.analytics.window import Window, snapshot, today_of
from agrotrace.modules.recalls import engine
from agrotrace.modules.reports import render, service, sheets
from agrotrace.modules.reports.render import ReportSpec
from agrotrace.security.jwt import Principal
from tests.world import World

DAY = "2026-09-01"  # World batches are harvested then
CONTACT = "buyer-contact@example.test"


@pytest.fixture
def world(db):
    w = World()
    w.complaints: list[str] = []  # type: ignore[misc]
    w.indicators: list[str] = []  # type: ignore[misc]
    yield w
    sql.execute("DELETE FROM complaints WHERE id = ANY(%s::uuid[])", [w.complaints])
    sql.execute("DELETE FROM lab_results WHERE indicator_id = ANY(%s::uuid[])", [w.indicators])
    w.cleanup()
    sql.execute("DELETE FROM indicators WHERE id = ANY(%s::uuid[])", [w.indicators])


def _read(report: sheets.Report) -> list[dict]:
    """The report rendered to XLSX (in process) and read back with openpyxl."""
    spec = ReportSpec(report.title, report.period_line, "Сформирован: 2026-10-26 10:00 UTC",
                      "2026-10-26T10:00:00.000Z", tuple(report.sheets))
    wb = load_workbook(io.BytesIO(render.render(spec, "xlsx")))
    out = []
    for ws in wb.worksheets:
        rows = list(ws.iter_rows())
        out.append({
            "name": ws.title,
            "header": [c.value for c in rows[0]],
            "bold": all(c.font.b for c in rows[0]),
            "rows": [[c.value for c in r] for r in rows[1:]],
            "types": [[c.data_type for c in r] for r in rows[1:]],
            "formats": [[c.number_format for c in r] for r in rows[1:]],
        })
    return out


def _window(day: str) -> Window:
    return Window(day, day)


def _today() -> str:
    return today_of(sql.scalar("SELECT now()"))


def test_batches_report_columns_order_and_types(world):
    farm, proc = world.org("FARM"), world.org("PROCESSOR")
    b2 = world.batch(farm)
    b1 = world.batch(farm, holder=proc)
    sql.execute("UPDATE batches SET mass_kg = 12.340, test_required = true, test_reason = 'NEW_FARM' WHERE id = %s",
                [b1])
    codes = sorted(sql.scalar("SELECT public_code FROM batches WHERE id = %s", [b]) for b in (b1, b2))
    report = snapshot(lambda tx, now: sheets.batches_report(tx, _window(DAY), farm, 50))
    assert report.file_base == f"agrotrace-batches_{DAY}_{DAY}" and report.title == "Реестр партий"
    assert report.period_line == f"Период: {DAY} — {DAY} (UTC)"
    [s] = _read(report)
    assert s["name"] == "Партии" and s["bold"]
    assert s["header"] == ["Код партии", "Продукт", "Категория", "Вид", "Масса, кг", "Статус", "Создатель",
                           "Держатель", "Дата производства (UTC)", "Анализ требуется", "Основание анализа",
                           "Изменена (UTC)"]
    assert [r[0] for r in s["rows"]] == codes  # publicCode, code points
    row = next(r for r in s["rows"] if r[0] == sql.scalar("SELECT public_code FROM batches WHERE id = %s", [b1]))
    i = s["rows"].index(row)
    assert row[1:4] == [sql.scalar("SELECT name FROM products WHERE id = %s", [world.product()]), "GRAIN", "RAW"]
    assert row[4] == 12.34 and s["types"][i][4] == "n" and s["formats"][i][4] == "0.000"
    assert row[8] == "2026-09-01 00:00" and row[9] == "да" and row[10] == "NEW_FARM"
    assert all(t == "s" for k, t in enumerate(s["types"][i]) if k != 4)


def test_recall_report_four_sheets(world):
    farm, proc = world.org("FARM"), world.org("PROCESSOR")
    src = world.batch(farm, status="Processed")
    child = world.batch(farm, status="Approved", holder=proc, kind="DERIVED")
    world.link(src, child)
    out = with_tx(lambda tx: engine.start_recall(
        tx, source_batch_id=src, trigger="INSPECTOR", opened_by=None, block_upstream=False, action="createRecall",
        reason="Отчёт"), **RECALL_TX)
    report = snapshot(lambda tx, now: sheets.recall_report(tx, out.recall_id))
    assert report is not None and report.file_base == f"agrotrace-recall_{out.recall_id}"
    assert report.period_line == f"Отзыв: {out.recall_id}"
    summary, members, tasks, chrono = _read(report)
    assert [x["name"] for x in (summary, members, tasks, chrono)] == ["Отзыв", "Партии", "Задачи", "Хронология"]
    assert summary["header"] == ["Поле", "Значение"]
    assert [r[0] for r in summary["rows"]] == ["ID", "Исходная партия", "Продукт", "Источник", "Причина", "Статус",
                                               "Блокировка источников", "Открыт (UTC)", "Закрыт (UTC)", "Инициатор",
                                               "Партий", "Задач", "Подтверждено"]
    values = {r[0]: (r[1], t[1], f[1]) for r, t, f in zip(summary["rows"], summary["types"], summary["formats"],
                                                         strict=True)}
    assert values["ID"][0] == out.recall_id and values["Блокировка источников"][0] == "нет"
    assert values["Закрыт (UTC)"][0] is None and values["Инициатор"][0] is None
    for k in ("Партий", "Задач", "Подтверждено"):  # «Поле | Значение»: counts are numbers (decision 8)
        assert values[k][1] == "n" and values[k][2] == "0", k
    assert values["Партий"][0] == len(members["rows"]) == 2
    assert members["header"] == ["Код партии", "Продукт", "Направление", "Глубина", "Статус до отзыва",
                                 "Статус сейчас", "Держатель"]
    assert members["rows"][0][2:4] == ["SOURCE", 0] and members["types"][0][3] == "n"
    assert tasks["header"] == ["Код партии", "Держатель", "Срок (UTC)", "Статус", "Эскалирована (UTC)",
                               "Подтверждена (UTC)", "Подтвердил", "Время подтверждения, ч"]
    assert len(tasks["rows"]) == values["Задач"][0]
    assert all(r[7] is None for r in tasks["rows"])  # nothing confirmed yet: no hours
    assert chrono["header"] == ["Время (UTC)", "Событие", "Партия", "Организация"]
    events = [r[1] for r in chrono["rows"]]
    assert events[0] == "RECALL_OPENED" and events[1:] == ["TASK_CREATED"] * len(tasks["rows"])
    assert all(len(r[0]) == 16 for r in chrono["rows"])
    assert snapshot(lambda tx, now: sheets.recall_report(tx, str(uuid.uuid4()))) is None


def test_recalls_lab_tests_complaints_and_org(world):
    farm, lab = world.org("FARM"), world.org("LAB")
    b = world.batch(farm)
    code = sql.scalar("SELECT public_code FROM batches WHERE id = %s", [b])
    done_at = datetime.now(UTC)
    t_done = world.lab_test(b, lab, status="DONE", conclusion="FAIL", completed_at=done_at)
    world.lab_test(b, lab)
    ind = sql.scalar("INSERT INTO indicators (name, unit) VALUES ('Свинец', 'мг/кг') RETURNING id::text")
    ind2 = sql.scalar("INSERT INTO indicators (name, unit) VALUES ('Кадмий', 'мг/кг') RETURNING id::text")
    world.indicators += [ind, ind2]
    for i in (ind, ind2):
        sql.execute("INSERT INTO lab_results (lab_test_id, indicator_id, value, is_exceeded) VALUES (%s, %s, 1, true)",
                    [t_done, i])
    world.complaints.append(sql.scalar(
        "INSERT INTO complaints (batch_id, text, contact) VALUES (%s, 'Жалоба на партию', %s) RETURNING id::text",
        [b, CONTACT]))
    world.recall(b, opened_at=done_at)
    today = _today()
    w = _window(today)

    rec = snapshot(lambda tx, now: sheets.recalls_report(tx, w, 1000))
    [s] = _read(rec)
    assert s["name"] == "Отзывы" and len(s["header"]) == 13
    mine = [(r, t, f) for r, t, f in zip(s["rows"], s["types"], s["formats"], strict=True) if r[1] == code]
    assert len(mine) == 1
    r, t, f = mine[0]
    assert r[8] == 0 and t[8] == "n" and f[8] == "0.00"  # CLOSED at once: 0.00 h
    assert r[9:] == [0, 0, 0, 0] and f[9:] == ["0"] * 4

    labs = snapshot(lambda tx, now: sheets.lab_tests_report(tx, w, lab, 1000))
    [s] = _read(labs)
    assert s["name"] == "Анализы" and len(s["rows"]) == 2
    row = next(r for r in s["rows"] if r[5] == "FAIL")
    assert row[11] == "Кадмий, Свинец" and row[10] == "нет"  # by name (code points)

    comp = snapshot(lambda tx, now: sheets.complaints_report(tx, w, 1000))
    [s] = _read(comp)
    assert s["header"] == ["Поступила (UTC)", "Код партии", "Продукт", "Текст", "Статус", "Решение", "Комментарий",
                           "Инспектор", "Решение принято (UTC)"]
    row = next(r for r in s["rows"] if r[1] == code)
    assert row[3:5] == ["Жалоба на партию", "NEW"] and row[5:] == [None, None, None, None]
    assert all(CONTACT not in str(v) for r in s["rows"] for v in r)

    org = snapshot(lambda tx, now: sheets.org_report(tx, w, farm, 1000))
    info, statuses, tests, tasks = _read(org)
    assert [x["name"] for x in (info, statuses, tests, tasks)] == ["Организация", "Партии по статусам", "Анализы",
                                                                    "Задачи отзыва"]
    assert [r[0] for r in info["rows"]] == ["Название", "ИНН", "Тип", "Регион", "Статус", "Рейтинг доверия", "Период"]
    assert info["rows"][5][1] == 80 and info["types"][5][1] == "n" and info["rows"][6][1] == f"{today} — {today}"
    assert info["types"][1][1] == "s"  # the INN is text
    assert dict((r[0], r[1]) for r in statuses["rows"])["Approved"] == 1 and len(statuses["rows"]) == 11
    assert all(f[1] == "0" for f in statuses["formats"])
    assert [r[0] for r in tests["rows"]] == [code] and tests["rows"][0][3] == "FAIL"
    assert tasks["header"] == ["Код партии", "ID отзыва", "Срок (UTC)", "Статус", "Подтверждена (UTC)"]
    labrep = snapshot(lambda tx, now: sheets.org_report(tx, w, lab, 1000))
    assert labrep.sheets[0].rows[5][1] == ("int", None)  # no rating for a laboratory
    assert [c[1] for c in labrep.sheets[2].rows[0]][0] == code  # the tests it performed
    assert snapshot(lambda tx, now: sheets.org_report(tx, w, str(uuid.uuid4()), 1000)) is None


def test_minute_truncates_in_utc():
    assert sheets.minute(datetime(2026, 9, 1, 23, 59, 59, 999999, tzinfo=UTC)) == "2026-09-01 23:59"
    assert sheets.minute("2026-09-01T23:59:59.999Z") == "2026-09-01 23:59"
    assert sheets.minute(datetime(5, 1, 2, 3, 4, tzinfo=UTC)) == "0005-01-02 03:04"
    assert sheets.minute(None) is None


def test_row_limit_13_is_a_file_14_is_too_many_rows(world, monkeypatch):
    monkeypatch.setattr(service, "config", lambda: SimpleNamespace(REPORT_MAX_ROWS=13))
    farm = world.org("FARM")
    head = Principal(user_id=str(uuid.uuid4()), org_id=farm, roles=("FARMER",), org_admin=True)
    for _ in range(13):
        world.batch(farm)
    q = {"format": "xlsx", "from": DAY, "to": DAY}
    f = service.download(head, "batches", q)
    assert f.file_name == f"agrotrace-batches_{DAY}_{DAY}.xlsx" and f.content_type.endswith(".sheet")
    assert load_workbook(io.BytesIO(f.body)).worksheets[0].max_row == 14
    pdf = service.download(head, "batches", {**q, "format": "pdf"})
    assert pdf.body[:5] == b"%PDF-" and pdf.content_type == "application/pdf"
    world.batch(farm)
    for fmt in ("xlsx", "pdf"):
        with pytest.raises(AppProblem) as e:
            service.download(head, "batches", {**q, "format": fmt})
        assert e.value.status == 400 and e.value.errors == {"type": ["validation.report.tooManyRows"]}


def test_access_and_parameter_order(world):
    farm = world.org("FARM")
    worker = Principal(user_id="u", org_id=farm, roles=("FARMER",), org_admin=False)
    head = Principal(user_id="u", org_id=farm, roles=("FARMER",), org_admin=True)
    with pytest.raises(AppProblem) as e:
        service.download(worker, "nope", {})
    assert e.value.errors == {"type": ["validation.enum"]}
    for who, typ in ((worker, "batches"), (head, "recalls"), (head, "lab-tests")):
        with pytest.raises(AppProblem) as e:
            service.download(who, typ, {"format": "bad"})
        assert (e.value.status, e.value.code, e.value.params) == (403, "FORBIDDEN", None)
    with pytest.raises(AppProblem) as e:
        service.download(head, "org", {"format": "csv", "id": str(uuid.uuid4()), "to": "2026-02-30"})
    assert e.value.errors == {"format": ["validation.enum"], "id": ["validation.id.notAllowed"],
                              "to": ["validation.date.format"]}
    insp = Principal(user_id="u", org_id=farm, roles=("INSPECTOR",), org_admin=False)
    with pytest.raises(AppProblem) as e:
        service.download(insp, "recall", {"format": "pdf", "from": DAY, "id": "x"})
    assert e.value.errors == {"id": ["validation.uuid"], "from": ["validation.from.notAllowed"]}
    with pytest.raises(AppProblem) as e:
        service.download(insp, "org", {"format": "pdf", "id": str(uuid.uuid4())})
    assert (e.value.status, e.value.code) == (404, "NOT_FOUND")


def test_xlsx_widths_and_numbers_as_exceljs_writes_them():
    """Widths min(60, max(8, longest + 2)) over the header and the first 200 rows (UTF-16 units); a column of the
    default width 9 gets no `<col>` (exceljs `isCustomWidth`); numbers as JS prints them."""
    from agrotrace.infra.xlsx_write import _sheet_xml, js_number

    xml = "".join(_sheet_xml(["Вид", "Глубина", "x" * 70, "Код"],
                             [[("text", "RAW"), ("int", 0), ("text", "a"), ("text", "😀" * 4)]]))
    assert '<col min="1" max="1" width="8" customWidth="1"/>' in xml
    assert 'min="2"' not in xml  # 7 + 2 = 9: the default
    assert '<col min="3" max="3" width="60" customWidth="1"/>' in xml
    assert '<col min="4" max="4" width="10" customWidth="1"/>' in xml  # 4 emoji = 8 UTF-16 units
    assert [js_number(v) for v in ("12.300", "0.000", "100.000", "0.01", 7, "123456789.999")] == \
        ["12.3", "0", "100", "0.01", "7", "123456789.999"]
