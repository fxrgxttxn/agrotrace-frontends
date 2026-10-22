"""
Dictionaries (contracts/openapi/paths/dictionaries.yaml, FR-ADM-02, FR-ANL-05; R51, R54/D29, R58, R59, R82, R93) and
the public regions list (public.yaml#listPublicRegions), the port of backend-express/src/modules/dictionaries/
{service,import}.ts: reading for every authenticated role, writes, the import and product photos for ADMIN.
Layout, views and row writes — store.py.

The import (`import_dictionary`): the file is read (infra.csv_read / infra.xlsx_scan — XLSX in a Lane child) and its
rows checked BEFORE any SQL, holding no pool connection (P61); only then one transaction does the lookups and writes
(`import_rows`). Row rules (decisions 6, 7, 11 of Express Tasks 4–5): a row of another width than the header →
`{column: null, validation.import.columns}`; values are never trimmed (R36) and follow `DictionaryInput` except the
import's number formats; `product`/`indicator` name a non-deleted row exactly; the key (`name`, `code`, the
`product`+`indicator` pair) belongs to the first row in file order that carries it as non-empty text — even a row with
value errors; every later row with that key → `validation.duplicate` at the key column; a row's errors are ordered by
column, the duplicate after the value errors of its column; rows with errors are skipped; `unchanged` compares
decimals numerically; `mercuryCode` is never set by the import.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypedDict

from agrotrace.core import audit, sql
from agrotrace.core.multipart import Upload
from agrotrace.core.params import QueryReader
from agrotrace.core.patterns import ecma
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx, with_tx
from agrotrace.domain.decimal import compare_decimal_strings
from agrotrace.infra import csv_read, images, xlsx_scan
from agrotrace.infra.xlsx_scan import Invalid
from agrotrace.modules.dictionaries import store
from agrotrace.modules.dictionaries.serializers import CATEGORIES, INPUTS, SUBSTANCE_TYPES
from agrotrace.modules.dictionaries.store import ENTITY_TYPE, SOFT_DELETE, Columns, Row
from agrotrace.modules.files import services as files
from agrotrace.modules.public import cache as public_cache
from agrotrace.security.jwt import Principal

PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
IMPORT_MAX_BYTES = 5 * 1024 * 1024


def _is_admin(p: Principal) -> bool:
    return "ADMIN" in p.roles


def parse_input(name: str, body: Any) -> Columns:
    """The body of `name` (DictionaryInput → the schema of that dictionary) as DB columns."""
    v = INPUTS[name].parse_body(body)
    if name == "products":
        # PUT replaces the whole entry: an absent mercuryCode is null (NullableMercuryCode).
        return {"name": v["name"], "category": v["category"], "loss_norm_percent": v["lossNormPercent"],
                "mercury_code": v.get("mercuryCode")}
    if name == "substances":
        return {"name": v["name"], "type": v["type"], "waiting_period_days": v["waitingPeriodDays"]}
    if name == "indicators":
        return {"name": v["name"], "unit": v["unit"]}
    if name == "norms":
        return {"product_id": v["productId"].lower(), "indicator_id": v["indicatorId"].lower(),
                "max_value": v["maxValue"]}
    return {"code": v["code"], "name": v["name"]}


def _view(name: str, row: Row) -> dict[str, Any]:
    return store.entry_views(sql, name, [row])[0]


def _check_norm_refs(tx: Tx, cols: Columns) -> None:
    """norms: productId/indicatorId must be non-deleted rows → 400 `validation.notFound` on each; FOR SHARE — a parallel
    soft delete of the product or indicator waits for this norm (P23)."""
    p = tx.one("SELECT id FROM products WHERE id = %s AND deleted_at IS NULL FOR SHARE", [cols["product_id"]])
    i = tx.one("SELECT id FROM indicators WHERE id = %s AND deleted_at IS NULL FOR SHARE", [cols["indicator_id"]])
    errors: dict[str, list[str]] = {}
    if p is None:
        errors["productId"] = ["validation.notFound"]
    if i is None:
        errors["indicatorId"] = ["validation.notFound"]
    if errors:
        raise validation_problem(errors)


def _key_holder(tx: Tx, name: str, cols: Columns, except_id: str | None = None) -> Row | None:
    """The row holding the unique key of `cols` other than `except_id` (soft-deleted included), FOR NO KEY UPDATE."""
    if name == "norms":
        where, params = "product_id = %s AND indicator_id = %s", [cols["product_id"], cols["indicator_id"]]
    elif name == "regions":
        where, params = "code = %s", [cols["code"]]
    else:
        where, params = "name = %s", [cols["name"]]
    if except_id is not None:
        where += " AND id <> %s"
        params.append(except_id)
    r = tx.one(f"SELECT * FROM {name} WHERE {where} FOR NO KEY UPDATE", params)  # noqa: S608
    return store.normalize(r) if r is not None else None


def _duplicate(name: str) -> AppProblem:
    key = "indicatorId" if name == "norms" else "code" if name == "regions" else "name"
    return validation_problem({key: ["validation.duplicate"]})


# ── listDictionary ────────────────────────────────────────────────────────────────────────────────────────────────

def list_entries(p: Principal, name: str, request) -> dict[str, Any]:
    """Filters per dictionary; a filter that does not apply or is not allowed → 400 (R51; includeDeleted — decision
    10: sent at all by a non-ADMIN or for norms/regions, even `false`, → notAllowed)."""
    q = QueryReader(request)
    page, size, sort = q.page(("name",), "name,asc")
    text = q.q()
    category = typ = product_id = indicator_id = None
    include_deleted = False
    if name == "products":
        category = q.enum_of("category", CATEGORIES)
    else:
        q.not_allowed("category")
    if name == "substances":
        typ = q.enum_of("type", SUBSTANCE_TYPES)
    else:
        q.not_allowed("type")
    if name == "norms":
        product_id = q.uuid("productId")
        indicator_id = q.uuid("indicatorId")
    else:
        q.not_allowed("productId")
        q.not_allowed("indicatorId")
    if _is_admin(p) and SOFT_DELETE[name]:
        include_deleted = bool(q.bool("includeDeleted"))
    else:
        q.not_allowed("includeDeleted")
    q.done()

    direction = "ASC" if sort.dir == "asc" else "DESC"
    conds = ["TRUE"]
    params: list[Any] = []
    source = f"{name} t"
    order = f't.name COLLATE "C" {direction}'
    if SOFT_DELETE[name] and not include_deleted:
        conds.append("t.deleted_at IS NULL")
    if category:
        conds.append("t.category = %s")
        params.append(category)
    if typ:
        conds.append("t.type = %s")
        params.append(typ)
    if name == "norms":
        source = "norms t JOIN products p ON p.id = t.product_id JOIN indicators i ON i.id = t.indicator_id"
        order = f'p.name COLLATE "C" {direction}, i.name COLLATE "C" {direction}'
        if product_id:
            conds.append("t.product_id = %s")
            params.append(product_id)
        if indicator_id:
            conds.append("t.indicator_id = %s")
            params.append(indicator_id)
    if text is not None:
        # A substring without case; `%`, `_`, `\` are ordinary characters (no LIKE).
        def has(col: str) -> str:
            params.append(text)
            return f"position(lower(%s) in lower({col})) > 0"

        if name == "norms":
            conds.append(f"({has('p.name')} OR {has('i.name')})")
        elif name == "regions":
            conds.append(f"({has('t.name')} OR {has('t.code')})")
        else:
            conds.append(has("t.name"))
    where = " AND ".join(conds)
    total = sql.scalar(f"SELECT count(*) FROM {source} WHERE {where}", params)  # noqa: S608
    rows = sql.all(f'SELECT t.* FROM {source} WHERE {where} ORDER BY {order}, t.id::text COLLATE "C" '  # noqa: S608
                   "LIMIT %s OFFSET %s", [*params, size, (page - 1) * size])
    return {"items": store.entry_views(sql, name, [store.normalize(r) for r in rows]), "page": page, "size": size,
            "total": int(total)}


# ── create / update / delete ──────────────────────────────────────────────────────────────────────────────────────

def create(p: Principal, name: str, body: Any) -> dict[str, Any]:
    """Order: body → norms references (notFound) → uniqueness (duplicate). A name held by a soft-deleted row restores
    that row with the body's values (201 with its id)."""
    cols = parse_input(name, body)

    def run(tx: Tx) -> Row:
        store.lock_dictionary(tx, name)
        if name == "norms":
            _check_norm_refs(tx, cols)
        held = _key_holder(tx, name, cols)
        if held is not None and not (store.is_named(name) and held["deleted_at"] is not None):
            raise _duplicate(name)
        before = None
        if held is not None:
            before = store.audit_view(name, held)
            after = store.update_row(tx, name, held["id"], cols, restore=True)
        else:
            after = store.insert_row(tx, name, cols)
        audit.record(tx, action="createDictionaryEntry", entity_type=ENTITY_TYPE[name], entity_id=after["id"],
                     actor=p, diff=audit.audit_diff(before, store.audit_view(name, after)))
        return after

    return _view(name, with_tx(run))


def update(p: Principal, name: str, row_id: str, body: Any) -> dict[str, Any]:
    """Order: body → 404 (missing or soft-deleted) → norms references → uniqueness against every other row. Nothing
    changed → no write, no audit row (P23). A product rename drops its batches' public pages after the commit."""
    cols = parse_input(name, body)

    def run(tx: Tx) -> Row:
        store.lock_dictionary(tx, name)
        current = store.select_row(tx, name, row_id, "update")
        if current is None or (SOFT_DELETE[name] and current["deleted_at"] is not None):
            raise AppProblem(404, "NOT_FOUND")
        if name == "norms":
            _check_norm_refs(tx, cols)
        if _key_holder(tx, name, cols, row_id) is not None:
            raise _duplicate(name)
        if store.same_values(current, cols):
            return current
        after = store.update_row(tx, name, row_id, cols)
        diff = audit.audit_diff(store.audit_view(name, current), store.audit_view(name, after))
        audit.record(tx, action="updateDictionaryEntry", entity_type=ENTITY_TYPE[name], entity_id=row_id, actor=p,
                     diff=diff)
        if name == "products" and "name" in diff:
            public_cache.schedule_drop(tx, public_cache.codes_of_products(tx, [row_id]))
        return after

    return _view(name, with_tx(run))


def remove(p: Principal, name: str, row_id: str) -> None:
    """Soft for products/substances/indicators, physical for norms and regions (FOR UPDATE); a region an organization
    or a field (soft-deleted included) refers to → 409 REFERENCE_IN_USE {usedBy}."""

    def run(tx: Tx) -> None:
        store.lock_dictionary(tx, name)
        current = store.select_row(tx, name, row_id, "update" if SOFT_DELETE[name] else "delete")
        if current is None or (SOFT_DELETE[name] and current["deleted_at"] is not None):
            raise AppProblem(404, "NOT_FOUND")
        if SOFT_DELETE[name]:
            now = tx.now
            tx.execute(f"UPDATE {name} SET deleted_at = %s WHERE id = %s", [now, row_id])  # noqa: S608
            diff = {"deletedAt": [None, iso(now)]}
        else:
            if name == "regions":
                used = tx.one("SELECT EXISTS (SELECT 1 FROM organizations WHERE region_id = %s) AS orgs, "
                              "EXISTS (SELECT 1 FROM fields WHERE region_id = %s) AS fields", [row_id, row_id])
                assert used is not None
                used_by = [t for t, flag in (("organizations", used["orgs"]), ("fields", used["fields"])) if flag]
                if used_by:
                    raise AppProblem(409, "REFERENCE_IN_USE", params={"usedBy": used_by})
            tx.execute(f"DELETE FROM {name} WHERE id = %s", [row_id])  # noqa: S608
            diff = audit.audit_removal(store.audit_view(name, current))
        audit.record(tx, action="deleteDictionaryEntry", entity_type=ENTITY_TYPE[name], entity_id=row_id, actor=p,
                     diff=diff)

    with_tx(run)


# ── uploadProductImage / listPublicRegions ────────────────────────────────────────────────────────────────────────

def upload_image(p: Principal, product_id: str, upload: Upload) -> dict[str, Any]:
    """After the form (400) and the size (413): 404 for a missing or soft-deleted product, then the type (415,
    JPEG/PNG/WebP by signature; the raster Lane). The previous photo is soft-deleted; the product's public pages are
    dropped after the commit (R82, decision 16)."""
    if sql.one("SELECT id FROM products WHERE id = %s AND deleted_at IS NULL", [product_id]) is None:
        raise AppProblem(404, "NOT_FOUND")
    f = files.prepare(upload, kind="PRODUCT_IMAGE", owner_id=p.user_id, allowed=images.RASTER_TYPES)
    files.store_objects(f)

    def run(tx: Tx) -> Row:
        current = store.select_row(tx, "products", product_id, "update")
        if current is None or current["deleted_at"] is not None:
            raise AppProblem(404, "NOT_FOUND")
        now = tx.now
        files.insert(tx, f)
        after = store.update_row(tx, "products", product_id, {"image_file_id": f.id})
        audit.record(tx, action="uploadProductImage", entity_type="file", entity_id=f.id, actor=p,
                     diff=audit.audit_diff(None, files.audit_view(f)))
        old = current["image_file_id"]
        audit.record(tx, action="uploadProductImage", entity_type="product", entity_id=product_id, actor=p,
                     diff={"imageFileId": [old, f.id]})
        if files.soft_delete(tx, old, now):
            audit.record(tx, action="uploadProductImage", entity_type="file", entity_id=old, actor=p,
                         diff={"deletedAt": [None, iso(now)]})
        public_cache.schedule_drop(tx, public_cache.codes_of_products(tx, [product_id]))
        return after

    return _view("products", with_tx(run))


def public_regions() -> list[dict[str, str]]:
    """Every region by name (code points), then code; no paging."""
    rows = sql.all('SELECT code, name FROM regions ORDER BY name COLLATE "C", code COLLATE "C"')
    return [{"code": r["code"], "name": r["name"]} for r in rows]


# ── importDictionary ──────────────────────────────────────────────────────────────────────────────────────────────

IMPORT_COLUMNS = {
    "products": ("name", "category", "lossNormPercent"),
    "substances": ("name", "type", "waitingPeriodDays"),
    "indicators": ("name", "unit"),
    "norms": ("product", "indicator", "maxValue"),
    "regions": ("code", "name"),
}
KEY_COLUMN = {"products": "name", "substances": "name", "indicators": "name", "norms": "indicator", "regions": "code"}


class ImportErrorEntry(TypedDict):
    row: int
    column: str | None
    message: str


class ImportReport(TypedDict):
    created: int
    updated: int
    unchanged: int
    errors: list[ImportErrorEntry]


Rule = Callable[[str], str | None]
_NON_SPACE = ecma(r"\S")


def _text(max_len: int) -> Rule:
    """A name-like string: required, `maxLength` in code points, not only white space (`\\S`)."""

    def rule(v: str) -> str | None:
        if v == "":
            return "validation.required"
        if len(v) > max_len:
            return "validation.maxLength"
        return None if _NON_SPACE.search(v) else "validation.pattern"

    return rule


def _one_of(values: tuple[str, ...]) -> Rule:
    return lambda v: "validation.required" if v == "" else None if v in values else "validation.enum"


def _number(pattern: str, maximum: str) -> Rule:
    rx = ecma(pattern)

    def rule(v: str) -> str | None:
        if v == "":
            return "validation.required"
        if not rx.search(v):
            return "validation.pattern"
        return "validation.max" if compare_decimal_strings(v, maximum) > 0 else None

    return rule


def _matching(pattern: str) -> Rule:
    rx = ecma(pattern)
    return lambda v: "validation.required" if v == "" else None if rx.search(v) else "validation.pattern"


RULES: dict[str, list[Rule]] = {
    "products": [_text(160), _one_of(CATEGORIES), _number(r"^\d{1,3}(\.\d{1,2})?$", "100")],
    "substances": [_text(160), _one_of(SUBSTANCE_TYPES), _number(r"^\d{1,4}$", "3650")],
    "indicators": [_text(160), _text(24)],
    # product / indicator: exact names, looked up inside the transaction.
    "norms": [_text(160), _text(160), _matching(r"^\d{1,8}(\.\d{1,6})?$")],
    "regions": [_matching(r"^[0-9A-Z-]{1,8}$"), _text(120)],
}
_VALUE, _NOT_FOUND, _DUPLICATE = 0, 1, 2


@dataclass
class CheckedRow:
    """A data row after the checks that need no database: `errors` (column, rank, message) — rank orders the errors
    of one column: value, notFound, duplicate; `columns` — the row's width differs from the header."""

    number: int
    cells: list[Any] = field(default_factory=list)
    errors: list[tuple[int, int, str]] = field(default_factory=list)
    columns: bool = False


def check_rows(name: str, sheet: csv_read.Sheet) -> list[CheckedRow]:
    """The value rules and the key rule of every data row (no SQL: it runs before the transaction)."""
    columns = IMPORT_COLUMNS[name]
    width = len(columns)
    rules = RULES[name]
    key_col = columns.index(KEY_COLUMN[name])
    keys: set[str] = set()
    out: list[CheckedRow] = []
    for number, cells in sheet.rows:
        if cells is not None and sheet.pad_short and len(cells) < width:
            cells = [*cells, *([""] * (width - len(cells)))]
        if cells is None or len(cells) != width:
            out.append(CheckedRow(number, columns=True))
            continue
        row = CheckedRow(number, cells)
        for col, cell in enumerate(cells):
            message = cell.message if isinstance(cell, Invalid) else rules[col](cell)
            if message:
                row.errors.append((col, _VALUE, message))
        key_cells = cells[:2] if name == "norms" else cells[:1]
        if all(isinstance(k, str) and k != "" for k in key_cells):
            key = "\0".join(key_cells)
            if key in keys:
                row.errors.append((key_col, _DUPLICATE, "validation.duplicate"))
            else:
                keys.add(key)
        out.append(row)
    return out


def _columns_of(name: str, v: list[str], refs: dict[str, dict[str, str]]) -> Columns:
    if name == "products":
        return {"name": v[0], "category": v[1], "loss_norm_percent": v[2]}
    if name == "substances":
        return {"name": v[0], "type": v[1], "waiting_period_days": int(v[2])}
    if name == "indicators":
        return {"name": v[0], "unit": v[1]}
    if name == "norms":
        return {"product_id": refs["products"][v[0]], "indicator_id": refs["indicators"][v[1]], "max_value": v[2]}
    return {"code": v[0], "name": v[1]}


def _row_key(name: str, cols: Columns) -> str:
    if name == "norms":
        return f"{cols['product_id']}|{cols['indicator_id']}"
    return str(cols["code"] if name == "regions" else cols["name"])


def _existing_rows(tx: Tx, name: str, valid: list[tuple[int, str, Columns]]) -> dict[str, Row]:
    """The existing rows (soft-deleted included) holding the keys of `valid`, FOR NO KEY UPDATE, by key."""
    out: dict[str, Row] = {}
    for i in range(0, len(valid), 1000):
        chunk = [cols for _, _, cols in valid[i: i + 1000]]
        if name == "norms":
            found = tx.all(
                "SELECT n.* FROM norms n JOIN unnest(%s::uuid[], %s::uuid[]) AS k(product_id, indicator_id) "
                "ON k.product_id = n.product_id AND k.indicator_id = n.indicator_id FOR NO KEY UPDATE OF n",
                [[c["product_id"] for c in chunk], [c["indicator_id"] for c in chunk]])
        else:
            column = "code" if name == "regions" else "name"
            found = tx.all(f"SELECT * FROM {name} WHERE {column} = ANY(%s::text[]) FOR NO KEY UPDATE",  # noqa: S608
                           [[c[column] for c in chunk]])
        for r in found:
            row = store.normalize(r)
            out[_row_key(name, row)] = row
    return out


def import_rows(tx: Tx, name: str, rows: list[CheckedRow], actor: Principal) -> ImportReport:
    """The transaction of an import (the advisory lock first, R93): references, the report, creates/updates/restores
    with an audit row each; the changed products' public pages are dropped after the commit."""
    store.lock_dictionary(tx, name)
    columns = IMPORT_COLUMNS[name]
    report: ImportReport = {"created": 0, "updated": 0, "unchanged": 0, "errors": []}
    refs: dict[str, dict[str, str]] = {"products": {}, "indicators": {}}
    if name == "norms":
        # Non-deleted products and indicators by exact name, FOR SHARE — no parallel soft delete (P23).
        refs["products"] = {r["name"]: r["id"] for r in tx.all(
            "SELECT id::text AS id, name FROM products WHERE deleted_at IS NULL FOR SHARE")}
        refs["indicators"] = {r["name"]: r["id"] for r in tx.all(
            "SELECT id::text AS id, name FROM indicators WHERE deleted_at IS NULL FOR SHARE")}
    valid: list[tuple[int, str, Columns]] = []
    for row in rows:
        if row.columns:
            report["errors"].append({"row": row.number, "column": None, "message": "validation.import.columns"})
            continue
        errors = list(row.errors)
        if name == "norms":
            for col, table in ((0, "products"), (1, "indicators")):
                cell = row.cells[col]
                if (isinstance(cell, str) and cell != "" and not any(e[0] == col for e in errors)
                        and cell not in refs[table]):
                    errors.append((col, _NOT_FOUND, "validation.notFound"))
        if errors:
            for col, _, message in sorted(errors, key=lambda e: (e[0], e[1])):
                report["errors"].append({"row": row.number, "column": columns[col], "message": message})
            continue
        cols = _columns_of(name, row.cells, refs)
        valid.append((row.number, _row_key(name, cols), cols))

    existing = _existing_rows(tx, name, valid)
    changed_products: list[str] = []
    for _, key, cols in valid:
        current = existing.get(key)
        before = None
        if current is None:
            after = store.insert_row(tx, name, cols)
            report["created"] += 1
        else:
            restore = store.is_named(name) and current["deleted_at"] is not None
            if not restore and store.same_values(current, cols):
                report["unchanged"] += 1
                continue
            before = store.audit_view(name, current)
            after = store.update_row(tx, name, current["id"], cols, restore=restore)
            report["updated"] += 1
            if name == "products":
                changed_products.append(current["id"])
        audit.record(tx, action="importDictionary", entity_type=ENTITY_TYPE[name], entity_id=after["id"], actor=actor,
                     diff=audit.audit_diff(before, store.audit_view(name, after)))
    public_cache.schedule_drop(tx, public_cache.codes_of_products(tx, changed_products))
    return report


def read_file(name: str, data: bytes) -> csv_read.Sheet:
    """The file (R58): its type by content — a ZIP is XLSX (read in a Lane child), anything else CSV — then the
    header (400 `validation.import.header`). No pool connection is held meanwhile (P61)."""
    sql.release()
    width = len(IMPORT_COLUMNS[name])
    if xlsx_scan.is_zip(data):
        sheet = xlsx_scan.read_first_sheet(data)
    else:
        try:
            sheet = csv_read.read_sheet(data, width)
        except csv_read.NulByte:
            raise xlsx_scan.unsupported() from None
        except csv_read.FormatError:
            raise validation_problem({"file": ["validation.import.format"]}) from None
        except csv_read.TooManyRows:
            raise validation_problem({"file": ["validation.import.tooManyRows"]}) from None
    if sheet.header is None or list(sheet.header) != list(IMPORT_COLUMNS[name]):
        raise validation_problem({"file": ["validation.import.header"]})
    return sheet


def import_dictionary(p: Principal, name: str, data: bytes) -> ImportReport:
    sheet = read_file(name, data)
    rows = check_rows(name, sheet)
    return with_tx(lambda tx: import_rows(tx, name, rows, p))
