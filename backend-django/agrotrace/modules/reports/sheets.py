"""
Report contents (downloadReport, contracts/openapi/paths/reports.yaml; FR-ANL-04, FR-ANL-05), the port of
backend-express/src/modules/reports/sheets.ts: the sheets of each report type with the contract's names, columns, row
orders and cell types, read in the caller's snapshot (analytics/window.snapshot). Rendering (XLSX, PDF) is
modules/reports/render.py, in the report Lane.

Cells are `(type, value)` pairs (plain data, pickled to the Lane's child): text — a string; int — a count (format
`0`); mass — kg as the decimal string of the DB (format `0.000`); dec2 — percents and `Hours` (format `0.00`); moments
— text `YYYY-MM-DD HH:MM` in UTC, truncated to the minute (never rounded, R59); booleans — `да`/`нет`; enum codes as in
the API; None — an empty cell.

Every data query reads at most `max_rows` + 1 rows (REPORT_MAX_ROWS): more than `max_rows` in any sheet is
`errors.type: [validation.report.tooManyRows]` (checked by the caller).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from agrotrace.core.tx import Tx
from agrotrace.domain.state_machine import batch_statuses
from agrotrace.modules.analytics.dashboard import held_by_status, hours
from agrotrace.modules.analytics.window import Window
from agrotrace.modules.recalls.mappers import load_recall
from agrotrace.modules.reports.render import Sheet

Cell = tuple[str, Any]


@dataclass
class Report:
    #: «Реестр партий» … (the PDF title is `AgroTrace — <title>`).
    title: str
    #: The file name without the extension.
    file_base: str
    #: `Период: <from> — <to> (UTC)` or `Отзыв: <id>`.
    period_line: str
    sheets: list[Sheet]


def T(v: str | None) -> Cell:  # noqa: N802 - the cell constructors of sheets.ts
    return ("text", v)


def N(v: int | None) -> Cell:  # noqa: N802
    return ("int", v)


def M(v: str | None) -> Cell:  # noqa: N802
    return ("mass", v)


def D2(v: str | None) -> Cell:  # noqa: N802
    return ("dec2", v)


def yes(b: bool) -> Cell:
    return T("да" if b else "нет")


def minute(v: datetime | str | None) -> str | None:
    """`YYYY-MM-DD HH:MM` (UTC), seconds and fractions truncated; an ISO instant string is cut the same way."""
    if v is None:
        return None
    if isinstance(v, str):
        return f"{v[:10]} {v[11:16]}"
    u = v.astimezone(UTC)
    return f"{u.year:04d}-{u.month:02d}-{u.day:02d} {u.hour:02d}:{u.minute:02d}"


def _period(w: Window) -> str:
    return f"Период: {w.frm} — {w.to} (UTC)"


LAB_OPEN = "('QUEUED', 'SAMPLED', 'ESCALATED')"
_IN = "%s::timestamptz"


# ── batches ───────────────────────────────────────────────────────────────────────────────────────────────────────

def batches_report(tx: Tx, w: Window, head_org: str | None, max_rows: int) -> Report:
    s, e = w.bounds()
    rows = tx.all(
        "SELECT b.public_code, p.name AS product, p.category, b.kind, b.mass_kg::text AS mass_kg, b.status, "
        "o.name AS origin, h.name AS holder, coalesce(b.harvested_at, b.produced_at) AS at, b.test_required, "
        "b.test_reason, b.updated_at "
        "FROM batches b JOIN products p ON p.id = b.product_id JOIN organizations o ON o.id = b.origin_org_id "
        "LEFT JOIN organizations h ON h.id = b.holder_org_id "
        f"WHERE b.deleted_at IS NULL AND coalesce(b.harvested_at, b.produced_at) >= {_IN} "
        f"AND coalesce(b.harvested_at, b.produced_at) < {_IN} "
        "AND (%s::uuid IS NULL OR b.origin_org_id = %s::uuid OR b.holder_org_id = %s::uuid) "
        'ORDER BY b.public_code COLLATE "C" LIMIT %s', [s, e, head_org, head_org, head_org, max_rows + 1])
    return Report(
        title="Реестр партий",
        file_base=f"agrotrace-batches_{w.frm}_{w.to}",
        period_line=_period(w),
        sheets=[Sheet(
            "Партии",
            ["Код партии", "Продукт", "Категория", "Вид", "Масса, кг", "Статус", "Создатель", "Держатель",
             "Дата производства (UTC)", "Анализ требуется", "Основание анализа", "Изменена (UTC)"],
            [[T(r["public_code"]), T(r["product"]), T(r["category"]), T(r["kind"]), M(r["mass_kg"]), T(r["status"]),
              T(r["origin"]), T(r["holder"]), T(minute(r["at"])), yes(r["test_required"]), T(r["test_reason"]),
              T(minute(r["updated_at"]))] for r in rows])])


# ── recalls (registry) ────────────────────────────────────────────────────────────────────────────────────────────

def recalls_report(tx: Tx, w: Window, max_rows: int) -> Report:
    s, e = w.bounds()
    rows = tx.all(
        "SELECT r.id::text AS id, b.public_code, p.name AS product, r.trigger, r.reason, r.status, r.opened_at, "
        "r.closed_at, floor(extract(epoch FROM r.closed_at - r.opened_at))::bigint::text AS secs, "
        "(SELECT count(*)::int FROM recall_batches rb WHERE rb.recall_id = r.id) AS batches, "
        "(SELECT count(*)::int FROM recall_tasks t WHERE t.recall_id = r.id) AS total, "
        "(SELECT count(*)::int FROM recall_tasks t WHERE t.recall_id = r.id AND t.status = 'CONFIRMED') AS confirmed, "
        "(SELECT count(*)::int FROM recall_tasks t "
        " WHERE t.recall_id = r.id AND t.status <> 'CONFIRMED' AND now() > t.due_at) AS overdue "
        "FROM recalls r JOIN batches b ON b.id = r.source_batch_id JOIN products p ON p.id = b.product_id "
        f"WHERE r.deleted_at IS NULL AND r.opened_at >= {_IN} AND r.opened_at < {_IN} "
        'ORDER BY r.opened_at, r.id::text COLLATE "C" LIMIT %s', [s, e, max_rows + 1])
    return Report(
        title="Реестр отзывов",
        file_base=f"agrotrace-recalls_{w.frm}_{w.to}",
        period_line=_period(w),
        sheets=[Sheet(
            "Отзывы",
            ["ID отзыва", "Исходная партия", "Продукт", "Источник", "Причина", "Статус", "Открыт (UTC)",
             "Закрыт (UTC)", "Длительность, ч", "Партий", "Задач", "Подтверждено", "Просрочено"],
            [[T(r["id"]), T(r["public_code"]), T(r["product"]), T(r["trigger"]), T(r["reason"]), T(r["status"]),
              T(minute(r["opened_at"])), T(minute(r["closed_at"])),
              D2(None if r["secs"] is None else hours(r["secs"], 1)), N(r["batches"]), N(r["total"]),
              N(r["confirmed"]), N(r["overdue"])] for r in rows])])


# ── recall (FR-ANL-04) ────────────────────────────────────────────────────────────────────────────────────────────

EVENT_ORDER = ("RECALL_OPENED", "TASK_CREATED", "TASK_OVERDUE", "TASK_CONFIRMED", "RECALL_CLOSED")


def _ms(dt: datetime) -> datetime:
    """The instant as Express holds it (a JS Date: milliseconds) — events compare at that precision."""
    return dt.replace(microsecond=dt.microsecond - dt.microsecond % 1000)


def recall_report(tx: Tx, recall_id: str) -> Report | None:
    """The recall report, or None when the recall does not exist or is deleted."""
    r = load_recall(recall_id)
    if r is None:
        return None
    head = tx.one(
        "SELECT r.opened_at, r.closed_at, o.name AS origin FROM recalls r "
        "JOIN batches b ON b.id = r.source_batch_id JOIN organizations o ON o.id = b.origin_org_id "
        "WHERE r.id = %s", [recall_id])
    assert head is not None
    by_task = {t["id"]: t for t in tx.all(
        "SELECT t.id::text AS id, t.escalated_at, t.confirmed_at, "
        "floor(extract(epoch FROM t.confirmed_at - r.opened_at))::bigint::text AS secs "
        "FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id WHERE t.recall_id = %s", [recall_id])}
    source = r["sourceBatch"]["publicCode"]
    events: list[tuple[datetime, int, bytes, str, str, str]] = []

    def add(at: datetime, event: str, code: str, org: str) -> None:
        events.append((_ms(at), EVENT_ORDER.index(event), code.encode("utf-8", "surrogatepass"), event, code, org))

    add(head["opened_at"], "RECALL_OPENED", source, head["origin"])
    for t in r["tasks"]:
        raw = by_task[t["id"]]
        code, holder = t["batch"]["publicCode"], t["holder"]["name"]
        add(head["opened_at"], "TASK_CREATED", code, holder)
        if raw["escalated_at"] is not None:
            add(raw["escalated_at"], "TASK_OVERDUE", code, holder)
        if raw["confirmed_at"] is not None:
            add(raw["confirmed_at"], "TASK_CONFIRMED", code, holder)
    if head["closed_at"] is not None:
        add(head["closed_at"], "RECALL_CLOSED", source, head["origin"])
    events.sort(key=lambda ev: ev[:3])
    opened_by = r["openedBy"]
    return Report(
        title="Отчёт по отзыву",
        file_base=f"agrotrace-recall_{r['id']}",
        period_line=f"Отзыв: {r['id']}",
        sheets=[
            Sheet("Отзыв", ["Поле", "Значение"], [
                [T("ID"), T(r["id"])],
                [T("Исходная партия"), T(source)],
                [T("Продукт"), T(r["sourceBatch"]["product"]["name"])],
                [T("Источник"), T(r["trigger"])],
                [T("Причина"), T(r["reason"])],
                [T("Статус"), T(r["status"])],
                [T("Блокировка источников"), yes(r["blockUpstream"])],
                [T("Открыт (UTC)"), T(minute(r["openedAt"]))],
                [T("Закрыт (UTC)"), T(minute(r["closedAt"]))],
                [T("Инициатор"), T(opened_by["fullName"] if opened_by else None)],
                [T("Партий"), N(r["batchesCount"])],
                [T("Задач"), N(r["progress"]["total"])],
                [T("Подтверждено"), N(r["progress"]["confirmed"])],
            ]),
            Sheet("Партии", ["Код партии", "Продукт", "Направление", "Глубина", "Статус до отзыва", "Статус сейчас",
                             "Держатель"],
                  [[T(m["batch"]["publicCode"]), T(m["batch"]["product"]["name"]), T(m["direction"]), N(m["depth"]),
                    T(m["statusBefore"]), T(m["batch"]["status"]),
                    T(m["batch"]["holder"]["name"] if m["batch"]["holder"] else None)] for m in r["batches"]]),
            Sheet("Задачи", ["Код партии", "Держатель", "Срок (UTC)", "Статус", "Эскалирована (UTC)",
                             "Подтверждена (UTC)", "Подтвердил", "Время подтверждения, ч"],
                  [[T(t["batch"]["publicCode"]), T(t["holder"]["name"]), T(minute(t["dueAt"])), T(t["status"]),
                    T(minute(t["escalatedAt"])), T(minute(t["confirmedAt"])),
                    T(t["confirmedBy"]["fullName"] if t["confirmedBy"] else None),
                    D2(None if by_task[t["id"]]["secs"] is None else hours(by_task[t["id"]]["secs"], 1))]
                   for t in r["tasks"]]),
            Sheet("Хронология", ["Время (UTC)", "Событие", "Партия", "Организация"],
                  [[T(minute(at)), T(event), T(code), T(org)] for at, _, _, event, code, org in events]),
        ])


# ── lab tests ─────────────────────────────────────────────────────────────────────────────────────────────────────

def lab_tests_report(tx: Tx, w: Window, head_org: str | None, max_rows: int) -> Report:
    s, e = w.bounds()
    rows = tx.all(
        "SELECT b.public_code, p.name AS product, l.name AS lab, lt.reason, lt.status, lt.conclusion, lt.created_at, "
        "lt.due_at, lt.sampled_at, lt.completed_at, "
        f"(lt.status IN {LAB_OPEN} AND now() > lt.due_at) AS overdue, "
        "(SELECT string_agg(i.name, ', ' ORDER BY i.name COLLATE \"C\") "
        " FROM lab_results lr JOIN indicators i ON i.id = lr.indicator_id "
        " WHERE lr.lab_test_id = lt.id AND lr.is_exceeded) AS exceeded "
        "FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN products p ON p.id = b.product_id "
        "JOIN organizations l ON l.id = lt.lab_org_id "
        "WHERE lt.deleted_at IS NULL AND b.deleted_at IS NULL "
        f"AND lt.created_at >= {_IN} AND lt.created_at < {_IN} "
        "AND (%s::uuid IS NULL OR lt.lab_org_id = %s::uuid) "
        'ORDER BY lt.created_at, lt.id::text COLLATE "C" LIMIT %s', [s, e, head_org, head_org, max_rows + 1])
    return Report(
        title="Лабораторные анализы",
        file_base=f"agrotrace-lab-tests_{w.frm}_{w.to}",
        period_line=_period(w),
        sheets=[Sheet(
            "Анализы",
            ["Код партии", "Продукт", "Лаборатория", "Основание", "Статус", "Заключение", "Создан (UTC)",
             "Срок (UTC)", "Проба (UTC)", "Завершён (UTC)", "Просрочен", "Превышенные показатели"],
            [[T(r["public_code"]), T(r["product"]), T(r["lab"]), T(r["reason"]), T(r["status"]), T(r["conclusion"]),
              T(minute(r["created_at"])), T(minute(r["due_at"])), T(minute(r["sampled_at"])),
              T(minute(r["completed_at"])), yes(r["overdue"] is True), T(r["exceeded"])] for r in rows])])


# ── complaints ────────────────────────────────────────────────────────────────────────────────────────────────────

def complaints_report(tx: Tx, w: Window, max_rows: int) -> Report:
    """No buyer contact: it is shown only on the inspector's complaint card (R59)."""
    s, e = w.bounds()
    rows = tx.all(
        "SELECT c.created_at, b.public_code, p.name AS product, c.text, c.status, c.decision, c.decision_comment, "
        "u.full_name AS inspector, c.decided_at "
        "FROM complaints c JOIN batches b ON b.id = c.batch_id JOIN products p ON p.id = b.product_id "
        "LEFT JOIN users u ON u.id = c.inspector_id "
        f"WHERE c.deleted_at IS NULL AND c.created_at >= {_IN} AND c.created_at < {_IN} "
        'ORDER BY c.created_at, c.id::text COLLATE "C" LIMIT %s', [s, e, max_rows + 1])
    return Report(
        title="Жалобы",
        file_base=f"agrotrace-complaints_{w.frm}_{w.to}",
        period_line=_period(w),
        sheets=[Sheet(
            "Жалобы",
            ["Поступила (UTC)", "Код партии", "Продукт", "Текст", "Статус", "Решение", "Комментарий", "Инспектор",
             "Решение принято (UTC)"],
            [[T(minute(r["created_at"])), T(r["public_code"]), T(r["product"]), T(r["text"]), T(r["status"]),
              T(r["decision"]), T(r["decision_comment"]), T(r["inspector"]), T(minute(r["decided_at"]))]
             for r in rows])])


# ── org ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def org_report(tx: Tx, w: Window, org_id: str, max_rows: int) -> Report | None:
    """The organization summary, or None when the organization does not exist or is deleted."""
    org = tx.one(
        "SELECT o.name, o.inn, o.type, r.name AS region, o.status, o.trust_rating "
        "FROM organizations o JOIN regions r ON r.id = o.region_id WHERE o.id = %s AND o.deleted_at IS NULL",
        [org_id])
    if org is None:
        return None
    s, e = w.bounds()
    counts = held_by_status(tx, org_id)
    whose = "lt.lab_org_id = %s" if org["type"] == "LAB" else "b.origin_org_id = %s"
    tests = tx.all(
        "SELECT b.public_code, p.name AS product, l.name AS lab, lt.conclusion, lt.completed_at "
        "FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN products p ON p.id = b.product_id "
        "JOIN organizations l ON l.id = lt.lab_org_id "
        "WHERE lt.deleted_at IS NULL AND b.deleted_at IS NULL AND lt.status = 'DONE' "
        f"AND lt.completed_at >= {_IN} AND lt.completed_at < {_IN} AND {whose} "
        'ORDER BY lt.completed_at, lt.id::text COLLATE "C" LIMIT %s', [s, e, org_id, max_rows + 1])
    tasks = tx.all(
        "SELECT b.public_code, t.recall_id::text AS recall_id, t.due_at, t.status, t.confirmed_at "
        "FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id JOIN batches b ON b.id = t.batch_id "
        "WHERE t.holder_org_id = %s AND r.deleted_at IS NULL AND b.deleted_at IS NULL "
        f"AND t.created_at >= {_IN} AND t.created_at < {_IN} "
        'ORDER BY t.due_at, t.id::text COLLATE "C" LIMIT %s', [org_id, s, e, max_rows + 1])
    return Report(
        title="Сводка по организации",
        file_base=f"agrotrace-org_{org['inn']}_{w.frm}_{w.to}",
        period_line=_period(w),
        sheets=[
            Sheet("Организация", ["Поле", "Значение"], [
                [T("Название"), T(org["name"])],
                [T("ИНН"), T(org["inn"])],
                [T("Тип"), T(org["type"])],
                [T("Регион"), T(org["region"])],
                [T("Статус"), T(org["status"])],
                [T("Рейтинг доверия"), N(org["trust_rating"] if org["type"] == "FARM" else None)],
                [T("Период"), T(f"{w.frm} — {w.to}")],
            ]),
            Sheet("Партии по статусам", ["Статус", "Количество"],
                  [[T(st), N(counts.get(st, 0))] for st in batch_statuses()]),
            Sheet("Анализы", ["Код партии", "Продукт", "Лаборатория", "Заключение", "Завершён (UTC)"],
                  [[T(r["public_code"]), T(r["product"]), T(r["lab"]), T(r["conclusion"]),
                    T(minute(r["completed_at"]))] for r in tests]),
            Sheet("Задачи отзыва", ["Код партии", "ID отзыва", "Срок (UTC)", "Статус", "Подтверждена (UTC)"],
                  [[T(r["public_code"]), T(r["recall_id"]), T(minute(r["due_at"])), T(r["status"]),
                    T(minute(r["confirmed_at"]))] for r in tasks]),
        ])
