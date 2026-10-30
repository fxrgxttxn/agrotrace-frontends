"""
Texts of letters and notifications from packages/i18n/locales/{ru,en}.json — the port of @agrotrace/i18n:

- `t(key, params)` — `createT(locale)` (translate.ts, resolve.ts): a flat key inside the namespace wins over walking
  the dotted segments; a missing key resolves to the key itself; ICU-lite plurals `{count, plural, one {…} few {…}
  many {…} other {…}}` when `params['count']` is a number (`Intl.PluralRules` categories, `#` → the count); then every
  `{name}` of `params` is replaced;
- `format_date` / `format_date_time` — format.ts (`25.09.2026`, `25.09.2026 15:00`: the UTC digits of the ISO text);
- `notification_message(type, payload, part)` — notification.ts `notificationMessage` (R87): key
  `notification.<TYPE>[.<event>].<part>`; params — enum codes of `reason`/`conclusion`/`trigger` through their label
  namespaces (the code itself when there is no label), `*At` instants through `format_date_time`, other strings and
  numbers as they are (booleans, nulls, objects are not params).
Users have no locale: the backends send Russian.
"""

from __future__ import annotations

import json
import re
from functools import cache
from typing import Any, Literal

from agrotrace.core import config

Locale = Literal["ru", "en"]
NotificationPart = Literal["title", "body", "email.subject", "email.body", "telegram"]

#: notification.ts NOTIFICATION_PARAM_LABELS.
NOTIFICATION_PARAM_LABELS: dict[str, str] = {
    "reason": "labTestReason",
    "conclusion": "labConclusion",
    "trigger": "recallTrigger",
}
_ISO_DATETIME = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}")
_PLURAL_TEMPLATE = re.compile(r"^\{([A-Za-z0-9_]+),[ \t\n\r\f\v]*plural,[ \t\n\r\f\v]*(.+)\}\Z", re.S)
_PLURAL_CATEGORY = re.compile(r"([A-Za-z0-9_]+)[ \t\n\r\f\v]*\{([^{}]*)\}")


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


def _is_number(v: Any) -> bool:
    return type(v) in (int, float)


def _js_string(v: Any) -> str:
    """`String(value)` for the params a template gets (strings and JS numbers; an integral float prints as JS does)."""
    if type(v) is float and v == v and v.is_integer() and abs(v) < 10 ** 21:
        return str(int(v))
    return str(v)


def plural_category(n: int | float, locale: str = "ru") -> str:
    """`new Intl.PluralRules(locale).select(n)` for the two locales (CLDR cardinal rules)."""
    integral = type(n) is int or (type(n) is float and n.is_integer())
    if locale == "en":
        return "one" if integral and abs(n) == 1 else "other"
    if not integral:
        return "other"
    i = abs(int(n))
    if i % 10 == 1 and i % 100 != 11:
        return "one"
    if 2 <= i % 10 <= 4 and not 12 <= i % 100 <= 14:
        return "few"
    return "many"


def _plural(template: str, count: int | float, locale: str) -> str:
    m = _PLURAL_TEMPLATE.search(template)
    if not m:
        return template
    categories = {c.group(1): c.group(2) for c in _PLURAL_CATEGORY.finditer(m.group(2))}
    text = categories.get(plural_category(count, locale), categories.get("other", ""))
    return text.replace("#", _js_string(count))


def t(key: str, params: dict[str, Any] | None = None, locale: Locale = "ru") -> str:
    template = _resolve(_dict(locale), key) or key
    if params and _is_number(params.get("count")) and _PLURAL_TEMPLATE.search(template):
        template = _plural(template, params["count"], locale)
    for name, value in (params or {}).items():
        template = template.replace("{" + name + "}", _js_string(value))
    return template


def format_date(iso: str, locale: Locale = "ru") -> str:
    y, m, d = iso[0:4], iso[5:7], iso[8:10]
    return f"{d}.{m}.{y}" if locale == "ru" else f"{m}/{d}/{y}"


def format_date_time(iso: str, locale: Locale = "ru") -> str:
    return f"{format_date(iso, locale)} {iso[11:16]}"


def notification_message(type: str, payload: dict[str, Any], part: NotificationPart,  # noqa: A002
                         locale: Locale = "ru") -> str:
    event = payload.get("event")
    key = f"notification.{type}.{event}.{part}" if isinstance(event, str) else f"notification.{type}.{part}"
    params: dict[str, Any] = {}
    for name, value in payload.items():
        if isinstance(value, str) and name in NOTIFICATION_PARAM_LABELS:
            label_key = f"{NOTIFICATION_PARAM_LABELS[name]}.{value}"
            label = t(label_key, locale=locale)
            params[name] = value if label == label_key else label
        elif isinstance(value, str) and name.endswith("At") and _ISO_DATETIME.search(value):
            params[name] = format_date_time(value, locale)
        elif isinstance(value, str) or _is_number(value):
            params[name] = value
    return t(key, params, locale)
