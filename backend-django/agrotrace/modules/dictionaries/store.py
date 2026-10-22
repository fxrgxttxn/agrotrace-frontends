"""
The five dictionaries of spec 7.2 (contracts/openapi/paths/dictionaries.yaml, R54/D29), the port of
backend-express/src/modules/dictionaries/store.ts: table layout, API views, audit views (API names and formats,
decision 4 of Express Tasks 4–5) and the row writes shared by the CRUD operations and the import.

products, substances, indicators — soft delete (`deleted_at`), a unique `name` among all rows (a soft-deleted row keeps
its name and is restored by a create/import with that name); norms — hard delete, unique (product, indicator);
regions — hard delete, unique `code`, no timestamps. Every write of a dictionary runs under the transaction-scoped
advisory lock `dictionary:<name>`, taken FIRST in the transaction (R93): the uniqueness checks and the import's lookups
see a stable dictionary and parallel writes never race into a 23505. Row locks (P23/P57): rows FOR NO KEY UPDATE, the
physical deletion of a norm or region FOR UPDATE (it waits for, then sees, a pending key-share reference).
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from agrotrace.core.problem import validation_problem
from agrotrace.core.render import iso_or_null
from agrotrace.core.tx import Tx
from agrotrace.domain.decimal import compare_decimal_strings
from agrotrace.infra import file_urls

DICT_NAMES = ("products", "substances", "indicators", "norms", "regions")
SOFT_DELETE = {"products": True, "substances": True, "indicators": True, "norms": False, "regions": False}
ENTITY_TYPE = {"products": "product", "substances": "substance", "indicators": "indicator", "norms": "norm",
               "regions": "region"}
#: Decimal columns: compared numerically (R59 `unchanged`).
DECIMAL_COLUMNS = frozenset({"loss_norm_percent", "max_value"})
Row = dict[str, Any]
Columns = dict[str, Any]


def is_named(name: str) -> bool:
    return name not in ("norms", "regions")


def dict_name(value: Any) -> str:
    """`DictionaryName` → 400 `errors.name: [validation.enum]` for any other value (alone, before the id)."""
    if value not in DICT_NAMES:
        raise validation_problem({"name": ["validation.enum"]})
    return value


def lock_dictionary(tx: Tx, name: str) -> None:
    """R93: serializes the writes of one dictionary; the first statement of every writing transaction."""
    tx.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [f"dictionary:{name}"])


def decimal_text(v: Any) -> str | None:
    """A numeric column as PostgreSQL's text (`2.50`, `500.000000`) — what the Express driver returns."""
    if v is None:
        return None
    return format(v, "f") if isinstance(v, Decimal) else str(v)


def normalize(row: dict[str, Any]) -> Row:
    """A raw row with uuids as lower-case text."""
    return {k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in row.items()}


def audit_view(name: str, r: Row) -> dict[str, Any]:
    if name == "products":
        return {"name": r["name"], "category": r["category"], "lossNormPercent": decimal_text(r["loss_norm_percent"]),
                "mercuryCode": r["mercury_code"], "imageFileId": r["image_file_id"],
                "deletedAt": iso_or_null(r["deleted_at"])}
    if name == "substances":
        return {"name": r["name"], "type": r["type"], "waitingPeriodDays": r["waiting_period_days"],
                "deletedAt": iso_or_null(r["deleted_at"])}
    if name == "indicators":
        return {"name": r["name"], "unit": r["unit"], "deletedAt": iso_or_null(r["deleted_at"])}
    if name == "norms":
        return {"productId": r["product_id"], "indicatorId": r["indicator_id"], "maxValue": decimal_text(r["max_value"])}
    return {"code": r["code"], "name": r["name"]}


def entry_views(tx_or_sql: Any, name: str, rows: list[Row]) -> list[dict[str, Any]]:
    """`DictionaryEntry` views of rows of one dictionary, in the given order (`tx_or_sql`: a Tx or core.sql)."""
    if name == "products":
        return [{"id": r["id"], "name": r["name"], "category": r["category"],
                 "lossNormPercent": decimal_text(r["loss_norm_percent"]), "mercuryCode": r["mercury_code"],
                 "imageUrl": file_urls.public_url(r["image_file_id"]) if r["image_file_id"] else None,
                 "createdAt": iso_or_null(r["created_at"]), "updatedAt": iso_or_null(r["updated_at"]),
                 "deletedAt": iso_or_null(r["deleted_at"])} for r in rows]
    if name == "substances":
        return [{"id": r["id"], "name": r["name"], "type": r["type"], "waitingPeriodDays": r["waiting_period_days"],
                 "createdAt": iso_or_null(r["created_at"]), "updatedAt": iso_or_null(r["updated_at"]),
                 "deletedAt": iso_or_null(r["deleted_at"])} for r in rows]
    if name == "indicators":
        return [{"id": r["id"], "name": r["name"], "unit": r["unit"], "createdAt": iso_or_null(r["created_at"]),
                 "updatedAt": iso_or_null(r["updated_at"]), "deletedAt": iso_or_null(r["deleted_at"])} for r in rows]
    if name == "regions":
        return [{"id": r["id"], "code": r["code"], "name": r["name"]} for r in rows]
    if not rows:
        return []
    refs = tx_or_sql.all(
        "SELECT n.id::text AS id, p.name AS product_name, i.name AS indicator_name, i.unit AS indicator_unit "
        "FROM norms n JOIN products p ON p.id = n.product_id JOIN indicators i ON i.id = n.indicator_id "
        "WHERE n.id = ANY(%s::uuid[])", [[r["id"] for r in rows]])
    by_id = {x["id"]: x for x in refs}
    out = []
    for r in rows:
        ref = by_id[r["id"]]
        out.append({"id": r["id"], "product": {"id": r["product_id"], "name": ref["product_name"]},
                    "indicator": {"id": r["indicator_id"], "name": ref["indicator_name"],
                                  "unit": ref["indicator_unit"]},
                    "maxValue": decimal_text(r["max_value"]), "createdAt": iso_or_null(r["created_at"]),
                    "updatedAt": iso_or_null(r["updated_at"])})
    return out


def select_row(tx: Tx, name: str, row_id: str, lock: str | None = None) -> Row | None:
    """A row by id; `update` — FOR NO KEY UPDATE (a change that keeps the key does not block the foreign-key checks
    of other tables); `delete` — FOR UPDATE (only the physical deletion of a norm or region, P57)."""
    clause = {"update": " FOR NO KEY UPDATE", "delete": " FOR UPDATE", None: ""}[lock]
    r = tx.one(f"SELECT * FROM {name} WHERE id = %s{clause}", [row_id])  # noqa: S608 - name is DICT_NAMES
    return normalize(r) if r is not None else None


def insert_row(tx: Tx, name: str, cols: Columns) -> Row:
    keys = list(cols)
    r = tx.one(f"INSERT INTO {name} ({', '.join(keys)}) VALUES ({', '.join(['%s'] * len(keys))}) RETURNING *",  # noqa: S608
               [cols[k] for k in keys])
    assert r is not None
    return normalize(r)


def update_row(tx: Tx, name: str, row_id: str, cols: Columns, *, restore: bool = False) -> Row:
    """Writes `cols` (plus `updated_at`, except regions — no timestamps; `restore` clears `deleted_at`)."""
    sets = [f"{k} = %s" for k in cols]
    params = list(cols.values())
    if name != "regions":
        sets.append("updated_at = now()")
    if restore:
        sets.append("deleted_at = NULL")
    r = tx.one(f"UPDATE {name} SET {', '.join(sets)} WHERE id = %s RETURNING *", [*params, row_id])  # noqa: S608
    assert r is not None
    return normalize(r)


def same_values(row: Row, cols: Columns) -> bool:
    """Whether the row already holds these values (decimals compared numerically — `5` = `5.00`, R59)."""
    for k, v in cols.items():
        cur = row.get(k)
        if k in DECIMAL_COLUMNS and cur is not None and v is not None:
            if compare_decimal_strings(cur if isinstance(cur, Decimal) else str(cur), str(v)) != 0:
                return False
        elif cur != v:
            return False
    return True
