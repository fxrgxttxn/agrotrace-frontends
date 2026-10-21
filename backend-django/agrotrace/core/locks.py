"""
Row locks of the protocol R47/R52 (contract info.description, P57): one total order for every operation —
waybill → recall → labTest → complaint → organization → batches (all affected rows in ONE statement `ORDER BY id`) →
recallTasks (`ORDER BY id`) → other rows. The default strength is `FOR NO KEY UPDATE` (Django's `select_for_update()`
would be `FOR UPDATE`, which conflicts with `FOR KEY SHARE` — the deadlock I2 of Express's final review); `update`
is only for the physical deletion of a dictionary row and deleteField (test_static_guards.py ALLOWED); jobs and the
sweeper take `skip_locked`. A lock outside a transaction locks nothing: it is refused.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Literal

from django.db import connection, models

Strength = Literal["no key update", "update", "share", "key share"]

_CLAUSE: dict[str, str] = {
    "no key update": "NO KEY UPDATE",
    "update": "UPDATE",
    "share": "SHARE",
    "key share": "KEY SHARE",
}


def lock[M: models.Model](
    table_model: type[M],
    ids: Iterable[str],
    *,
    strength: Strength = "no key update",
    skip_locked: bool = False,
) -> list[M]:
    """The rows of `table_model` with these ids, locked in one statement `ORDER BY id`; missing ids are absent."""
    assert connection.in_atomic_block, "lock() outside a transaction locks nothing"
    wanted = sorted({str(i) for i in ids})
    if not wanted:
        return []
    table = connection.ops.quote_name(table_model._meta.db_table)
    pk = connection.ops.quote_name(table_model._meta.pk.column)
    clause = "FOR " + _CLAUSE[strength] + (" SKIP LOCKED" if skip_locked else "")
    query = f"SELECT * FROM {table} WHERE {pk} = ANY(%s::uuid[]) ORDER BY {pk} {clause}"
    return list(table_model.objects.raw(query, [wanted]))
