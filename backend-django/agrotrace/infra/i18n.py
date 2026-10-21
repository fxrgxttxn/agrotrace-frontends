"""
Texts of letters (and later Telegram messages) from packages/i18n/locales/ru.json — the port of @agrotrace/i18n
`createT('ru')` lookup and `{name}` substitution (resolve.ts): a flat key inside the namespace wins over walking the
dotted segments; a missing key resolves to the key itself.
"""

from __future__ import annotations

import json
from functools import cache
from typing import Any

from agrotrace.core import config


@cache
def _dict(locale: str = "ru") -> dict[str, Any]:
    return json.loads((config.ROOT / "packages" / "i18n" / "locales" / f"{locale}.json").read_text("utf-8"))


def _resolve(d: dict[str, Any], key: str) -> str | None:
    if "." not in key:
        v = d.get(key)
        return v if isinstance(v, str) else None
    namespace, rest = key.split(".", 1)
    node = d.get(namespace)
    if not isinstance(node, dict):
        return None
    flat = node.get(rest)
    if isinstance(flat, str):
        return flat
    cursor: Any = node
    for seg in rest.split("."):
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(seg)
    return cursor if isinstance(cursor, str) else None


def t(key: str, params: dict[str, Any] | None = None, locale: str = "ru") -> str:
    out = _resolve(_dict(locale), key) or key
    for name, value in (params or {}).items():
        out = out.replace("{" + name + "}", str(value))
    return out
