"""
Query parameters by the contract's schemas (components/parameters.yaml), the port of backend-express/src/http/
params.ts `QueryReader`: every problem is a 400 VALIDATION entry under the parameter's name and all parameters of a
request are reported together (`done()`); unknown parameters are ignored.

Values are read as Express 4's `qs` parser presents them: a parameter given once is a string, given twice an array
(`?type=A&type=B`), in bracket form `name[]=…` / `name[0]=…` an array and `name[key]=…` an object — so a scalar
parameter given twice or in bracket form is `validation.type`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import parse_qsl

from agrotrace.core.patterns import ecma
from agrotrace.core.problem import validation_problem

_UUID = ecma(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i")
_INT = ecma(r"^-?\d{1,15}$")
_SORT = ecma(r"^([a-zA-Z]+),(asc|desc)$")


class _Obj(dict):
    """A bracket-form object value (`name[key]=…`)."""


def parse_query(query_string: str) -> dict[str, Any]:
    """`qs`-like: name → str | list[str] | dict (bracket objects)."""
    out: dict[str, Any] = {}
    for key, value in parse_qsl(query_string, keep_blank_values=True):
        lb = key.find("[")
        if lb > 0 and key.endswith("]"):
            name, inner = key[:lb], key[lb + 1: key.index("]", lb)]
            cur = out.get(name)
            if inner == "" or inner.isdigit():
                if isinstance(cur, list):
                    cur.append(value)
                elif isinstance(cur, str):
                    out[name] = [cur, value]
                elif isinstance(cur, _Obj):
                    cur[str(len(cur))] = value
                else:
                    out[name] = [value]
            else:
                obj = cur if isinstance(cur, _Obj) else _Obj()
                if isinstance(cur, list):
                    obj.update({str(i): v for i, v in enumerate(cur)})
                elif isinstance(cur, str):
                    obj["0"] = cur
                obj[inner] = value
                out[name] = obj
            continue
        cur = out.get(key)
        if cur is None:
            out[key] = value
        elif isinstance(cur, list):
            cur.append(value)
        elif isinstance(cur, _Obj):
            cur[str(len(cur))] = value
        else:
            out[key] = [cur, value]
    return out


@dataclass(frozen=True)
class Sort:
    field: str
    dir: Literal["asc", "desc"]


class QueryReader:
    def __init__(self, request_or_query: Any):
        if isinstance(request_or_query, dict):
            self.query = request_or_query
        else:
            self.query = parse_query(request_or_query.META.get("QUERY_STRING", ""))
        self.errors: dict[str, list[str]] = {}

    def add(self, name: str, key: str) -> None:
        self.errors.setdefault(name, []).append(key)

    def has(self, name: str) -> bool:
        return name in self.query

    def string(self, name: str) -> str | None:
        v = self.query.get(name)
        if v is None:
            return None
        if not isinstance(v, str):
            self.add(name, "validation.type")
            return None
        return v

    def int(self, name: str, min: int, max: int | None, fallback: int | None = None) -> int | None:  # noqa: A002
        s = self.string(name)
        if s is None:
            return None if name in self.errors else fallback
        if not _INT.search(s):
            self.add(name, "validation.type")
            return None
        n = int(s)
        if n < min:
            self.add(name, "validation.min")
            return None
        if max is not None and n > max:
            self.add(name, "validation.max")
            return None
        return n

    def enum_of(self, name: str, values: tuple[str, ...] | list[str]) -> str | None:
        s = self.string(name)
        if s is None:
            return None
        if s not in values:
            self.add(name, "validation.enum")
            return None
        return s

    def enum_list(self, name: str, values: tuple[str, ...] | list[str]) -> list[str] | None:
        raw = self.query.get(name)
        if raw is None:
            return None
        items = [raw] if isinstance(raw, str) else raw if isinstance(raw, list) else None
        if items is None or any(not isinstance(x, str) for x in items):
            self.add(name, "validation.type")
            return None
        if any(x not in values for x in items):
            self.add(name, "validation.enum")
            return None
        if len(set(items)) != len(items):
            self.add(name, "validation.duplicate")
            return None
        return items

    def uuid(self, name: str) -> str | None:
        s = self.string(name)
        if s is None:
            return None
        if not _UUID.search(s):
            self.add(name, "validation.uuid")
            return None
        return s.lower()

    def q(self, name: str = "q") -> str | None:
        """`Q`: 1…100 code points."""
        s = self.string(name)
        if s is None:
            return None
        if len(s) < 1:
            self.add(name, "validation.minLength")
            return None
        if len(s) > 100:
            self.add(name, "validation.maxLength")
            return None
        return s

    def text(self, name: str, max_length: int) -> str | None:
        s = self.string(name)
        if s is None:
            return None
        if len(s) > max_length:
            self.add(name, "validation.maxLength")
            return None
        return s

    def matching(self, name: str, pattern: str) -> str | None:
        """A string matching the contract's `pattern` (ECMA, unanchored search) — otherwise `validation.pattern`."""
        s = self.string(name)
        if s is None:
            return None
        if not ecma(pattern).search(s):
            self.add(name, "validation.pattern")
            return None
        return s

    def bool(self, name: str) -> bool | None:
        s = self.string(name)
        if s is None:
            return None
        if s not in ("true", "false"):
            self.add(name, "validation.type")
            return None
        return s == "true"

    def date(self, name: str) -> str | None:
        """`format: date` — a real calendar day `YYYY-MM-DD` (2026-02-30 is not), else `validation.date.format`."""
        s = self.string(name)
        if s is None:
            return None
        if not is_calendar_date(s):
            self.add(name, "validation.date.format")
            return None
        return s

    def date_range(self) -> tuple[str | None, str | None]:
        """`DateFrom`/`DateTo` (UTC days, inclusive): `from` after `to` → `errors.from: [validation.range]`."""
        frm = self.date("from")
        to = self.date("to")
        if frm is not None and to is not None and frm > to:
            self.add("from", "validation.range")
        return frm, to

    def not_allowed(self, name: str) -> None:
        if self.has(name):
            self.errors[name] = [f"validation.{name}.notAllowed"]

    def page(self, fields: tuple[str, ...], default: str) -> tuple[int, int, Sort]:
        """`Page`, `Size` (1…100, default 20) and `Sort` against the operation's `x-sort`."""
        page = self.int("page", 1, None, 1) or 1
        size = self.int("size", 1, 100, 20) or 20
        raw = self.string("sort")
        if raw is None and "sort" not in self.errors:
            raw = default
        f, d = default.split(",")
        sort = Sort(f, d)  # type: ignore[arg-type]
        if raw is not None:
            m = _SORT.search(raw)
            if not m or m.group(1) not in fields:
                self.add("sort", "validation.sort")
            else:
                sort = Sort(m.group(1), m.group(2))  # type: ignore[arg-type]
        return page, size, sort

    def done(self) -> None:
        if self.errors:
            raise validation_problem(self.errors)


def variant_param(request) -> int:
    """`ImageVariant` (96 | 480, default 480)."""
    q = QueryReader(request)
    v = q.enum_of("variant", ("96", "480"))
    q.done()
    return 96 if v == "96" else 480


_CALENDAR = ecma(r"^(\d{4})-(\d{2})-(\d{2})$")


def is_calendar_date(s: str) -> bool:
    """`YYYY-MM-DD` naming a day that exists (backend-express isCalendarDate; year 0000 included)."""
    m = _CALENDAR.search(s)
    if not m:
        return False
    y, mo, d = (int(g) for g in m.groups())
    if not 1 <= mo <= 12 or d < 1:
        return False
    leap = y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    days = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[mo - 1]
    return d <= days


def day_start(date: str) -> datetime:
    """The first instant of the UTC day `date`."""
    if date[:4] == "0000":  # no year 0 in Python (nor in PostgreSQL): the earliest instant
        return datetime.min.replace(tzinfo=UTC)
    return datetime(int(date[:4]), int(date[5:7]), int(date[8:10]), tzinfo=UTC)


def day_after(date: str) -> datetime:
    """The first instant after the UTC day `date` (the exclusive upper bound of an inclusive `to`)."""
    return day_start(date) + timedelta(days=1)
