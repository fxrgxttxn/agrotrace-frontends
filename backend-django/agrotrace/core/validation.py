"""
Request-body validation with the error keys of `@agrotrace/validation` (packages/validation/src/common.ts) — the port
of the shared Zod schemas. DRF fields are not used: they trim strings, coerce `"5"` to 5 and `"true"` to True, accept
uuids without dashes and dates with a zone, and count length in UTF-16 code units (Review Focus 6).

Semantics reproduced from Zod 3 (so a body gets the same `Problem.errors` as from Express):
- every parse returns a status — VALID, DIRTY (a check failed, parsing goes on) or ABORTED (a wrong type: the parent
  stops). A string's checks and refinements all run while the value is a string (`''` for NameString gives both
  `validation.required` and `validation.pattern`); a refinement runs on a DIRTY value, but a transform over a DIRTY
  value ABORTS (Zod 3.25: `'abc'` as a mass gives only `validation.mass.format`); an object or array with an ABORTED
  member is ABORTED (its `superRefine`, e.g. `no_duplicate`, does not run). Expected keys in test_validation_fields.py
  were taken from the real schemas of packages/validation (zod 3.25.76);
- missing → `validation.required`, wrong type (`null` included) → `validation.type`; objects are strict: an unknown
  key is `validation.unknownField` at its own path; paths are `items[0].batchId`, the body itself is `_root`;
- strings are never trimmed and their length is counted in code points (R36); patterns are ECMA (`core.patterns`);
- numbers are JS numbers: `5.0` is the integer 5, `true` is not a number, `"5"` is not a number.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from decimal import Decimal
from typing import Any, ClassVar

from agrotrace.core.patterns import ecma
from agrotrace.core.problem import validation_problem

VALID, DIRTY, ABORTED = 0, 1, 2


class _Missing:
    __slots__ = ()

    def __repr__(self) -> str:
        return "MISSING"


#: An absent property (JavaScript `undefined`).
MISSING: Any = _Missing()

Path = tuple[str | int, ...]


def format_error_path(path: Path) -> str:
    """The contract's `Problem.errors` key: `items[0].batchId`; the body root is `_root` (formatErrorPath)."""
    if not path:
        return "_root"
    out = ""
    for seg in path:
        if isinstance(seg, int):
            out += f"[{seg}]"
        else:
            out = seg if out == "" else f"{out}.{seg}"
    return out


class Ctx:
    """Issues collected during one parse (path → keys, in the order Zod reports them)."""

    def __init__(self) -> None:
        self.errors: dict[str, list[str]] = {}

    def add(self, path: Path, key: str) -> None:
        self.errors.setdefault(format_error_path(path), []).append(key)


def code_point_length(s: str) -> int:
    """Length in Unicode code points (R36) — Python's len() already is."""
    return len(s)


def _type_issue(ctx: Ctx, path: Path, value: Any) -> tuple[int, Any]:
    ctx.add(path, "validation.required" if value is MISSING else "validation.type")
    return ABORTED, value


def _is_js_number(v: Any) -> bool:
    return type(v) in (int, float)


class Field:
    """A schema node. Subclasses implement `_parse_inner`; wrappers add optional/nullable/default/refine/transform."""

    def parse(self, value: Any, path: Path, ctx: Ctx) -> tuple[int, Any]:
        return self._parse_inner(value, path, ctx)

    def _parse_inner(self, value: Any, path: Path, ctx: Ctx) -> tuple[int, Any]:  # pragma: no cover
        raise NotImplementedError

    # ── modifiers (Zod: .optional(), .nullable(), .default(), .refine(), .transform(), .superRefine()) ──
    def optional(self) -> Field:
        return _Optional(self)

    def nullable(self) -> Field:
        return _Nullable(self)

    def default(self, value: Any) -> Field:
        return _Default(self, value)

    def refine(self, check: Callable[[Any], bool], key: str | Callable[[Any], str]) -> Field:
        return _Refine(self, check, key)

    def transform(self, fn: Callable[[Any], Any]) -> Field:
        return _Transform(self, fn)

    def super_refine(self, fn: Callable[[Any, Callable[[Path, str], None]], None]) -> Field:
        return _SuperRefine(self, fn)


class _Optional(Field):
    def __init__(self, inner: Field):
        self.inner = inner

    def parse(self, value, path, ctx):
        return (VALID, MISSING) if value is MISSING else self.inner.parse(value, path, ctx)


class _Nullable(Field):
    def __init__(self, inner: Field):
        self.inner = inner

    def parse(self, value, path, ctx):
        return (VALID, None) if value is None else self.inner.parse(value, path, ctx)


class _Default(Field):
    def __init__(self, inner: Field, value: Any):
        self.inner, self.value = inner, value

    def parse(self, value, path, ctx):
        return self.inner.parse(self.value if value is MISSING else value, path, ctx)


class _Refine(Field):
    def __init__(self, inner: Field, check, key):
        self.inner, self.check, self.key = inner, check, key

    def parse(self, value, path, ctx):
        status, out = self.inner.parse(value, path, ctx)
        if status == ABORTED:
            return ABORTED, out
        if not self.check(out):
            ctx.add(path, self.key(out) if callable(self.key) else self.key)
            status = DIRTY
        return status, out


class _Transform(Field):
    def __init__(self, inner: Field, fn):
        self.inner, self.fn = inner, fn

    def parse(self, value, path, ctx):
        status, out = self.inner.parse(value, path, ctx)
        if status != VALID:
            # Zod 3.25: a transform over a DIRTY value is INVALID (aborted) — later refinements do not run.
            return ABORTED, out
        return VALID, self.fn(out)


class _SuperRefine(Field):
    def __init__(self, inner: Field, fn):
        self.inner, self.fn = inner, fn

    def parse(self, value, path, ctx):
        status, out = self.inner.parse(value, path, ctx)
        if status == ABORTED:
            return ABORTED, out
        issues: list[tuple[Path, str]] = []
        self.fn(out, lambda rel, key: issues.append((rel, key)))
        for rel, key in issues:
            ctx.add(path + tuple(rel), key)
        return (DIRTY if issues else status), out


# ── primitives ────────────────────────────────────────────────────────────────────────────────────────────────────

class Str(Field):
    """`z.string()` with checks: [(predicate, key)] — every check runs (Zod string checks are not fatal)."""

    def __init__(self, checks: Sequence[tuple[Callable[[str], bool], str]] = ()):
        self.checks = list(checks)

    def _parse_inner(self, value, path, ctx):
        if not isinstance(value, str):
            return _type_issue(ctx, path, value)
        status = VALID
        for ok, key in self.checks:
            if not ok(value):
                ctx.add(path, key)
                status = DIRTY
        return status, value


def _regex(pattern: str, flags: str = "") -> Callable[[str], bool]:
    rx = ecma(pattern, flags)
    return lambda s: rx.search(s) is not None


def String(min: int = 0, max: int | None = None, pattern: str | None = None) -> Field:  # noqa: N802, A002
    """`codePointString(min, max, pattern)`: empty → required (min > 0), shorter → minLength, longer → maxLength."""
    rx = ecma(pattern) if pattern is not None else None
    f: Field = Str()
    f = f.refine(lambda s: len(s) >= min, lambda s: "validation.required" if len(s) == 0 else "validation.minLength")
    f = f.refine(lambda s: max is None or len(s) <= max, "validation.maxLength")
    f = f.refine(lambda s: rx is None or rx.search(s) is not None, "validation.pattern")
    return f


def NameString() -> Field:  # noqa: N802
    """Contract `NameString`: 1…255 code points, not only white space, never trimmed."""
    return String(1, 255, r"\S")


_EMAIL = r"^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$"
_UUID = r"^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$"
_DATE_SRC = (r"((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])"
             r"-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))")
_DATETIME = "^" + _DATE_SRC + r"T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z)$"


def Email() -> Field:  # noqa: N802
    """Contract `Email`: Zod 3's email regex (ASCII), at most 254 code points."""
    return Str([(lambda s: len(s) >= 1, "validation.required"), (_regex(_EMAIL, "i"), "validation.email")]).refine(
        lambda s: len(s) <= 254, "validation.maxLength"
    )


def Password() -> Field:  # noqa: N802
    """Contract `Password`: 10…128 code points, compared byte-exact (never trimmed or normalized)."""
    return (
        Str([(lambda s: len(s) >= 1, "validation.required")])
        .refine(lambda s: len(s) >= 10, "validation.password.min")
        .refine(lambda s: len(s) <= 128, "validation.password.max")
    )


def Uuid() -> Field:  # noqa: N802
    return Str([(_regex(_UUID, "i"), "validation.uuid")])


def IsoDate() -> Field:  # noqa: N802
    return Str([(_regex(r"^\d{4}-\d{2}-\d{2}$"), "validation.date.format")])


def IsoDateTime() -> Field:  # noqa: N802
    """Contract `DateTime`: an instant in UTC with a `Z` suffix (Zod `datetime({offset: false})`)."""
    return Str([(_regex(_DATETIME), "validation.dateTime.format")])


def Mass() -> Field:  # noqa: N802
    """`massKg`: up to 3 decimals accepted and zero-padded to exactly 3; zero → validation.positive."""

    def pad(s: str) -> str:
        int_part, _, dec = s.partition(".")
        return f"{int_part}.{dec.ljust(3, '0')}"

    positive = _regex(r"^(?!0+\.000$)\d{1,9}\.\d{3}$")
    return Str([(_regex(r"^\d{1,9}(\.\d{1,3})?$"), "validation.mass.format")]).transform(pad).refine(
        positive, "validation.positive"
    )


def DecimalString() -> Field:  # noqa: N802
    return Str([(_regex(r"^\d{1,8}(\.\d{1,6})?$"), "validation.decimal.format")])


def Percent() -> Field:  # noqa: N802
    return Str([(_regex(r"^\d{1,3}\.\d{2}$"), "validation.percent.format")])


_INN_10 = (2, 4, 10, 3, 5, 9, 4, 6, 8)
_INN_11 = (7, 2, 4, 10, 3, 5, 9, 4, 6, 8)
_INN_12 = (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8)
_INN_SHAPE = ecma(r"^\d{10}(\d{2})?$")


def is_valid_inn(s: str) -> bool:
    """FNS checksum of a 10- or 12-digit INN."""
    if not _INN_SHAPE.search(s):
        return False
    d = [int(c) for c in s]

    def ctl(weights: tuple[int, ...]) -> int:
        return sum(w * d[i] for i, w in enumerate(weights)) % 11 % 10

    if len(d) == 10:
        return ctl(_INN_10) == d[9]
    return ctl(_INN_11) == d[10] and ctl(_INN_12) == d[11]


def Inn() -> Field:  # noqa: N802
    return Str([(_regex(r"^\d{10}(\d{2})?$"), "validation.inn.format")]).refine(is_valid_inn, "validation.inn.checksum")


def RegionCode() -> Field:  # noqa: N802
    return Str([(_regex(r"^[0-9A-Z-]{1,8}$"), "validation.pattern")])


class Enum(Field):
    def __init__(self, values: Iterable[str]):
        self.values = tuple(values)

    def _parse_inner(self, value, path, ctx):
        if not isinstance(value, str):
            return _type_issue(ctx, path, value)
        if value not in self.values:
            ctx.add(path, "validation.enum")
            return ABORTED, value
        return VALID, value


class Literal(Field):
    def __init__(self, value: Any):
        self.value = value

    def _parse_inner(self, value, path, ctx):
        # Zod: `input !== value` → invalid_literal (→ validation.enum), also for a missing property.
        if value is MISSING or not same_value_zero(value, self.value):
            ctx.add(path, "validation.enum")
            return ABORTED, value
        return VALID, value


def same_value_zero(a: Any, b: Any) -> bool:
    """JavaScript SameValueZero for JSON values (Set membership): numbers by value (1 == 1.0), bool apart, objects by
    identity."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if _is_js_number(a) and _is_js_number(b):
        return a == b
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return a is b
    return type(a) is type(b) and a == b


class Num(Field):
    """`z.number()` with `.int()`, `.min()`, `.max()` — all checks run; an integral float is an integer (JS)."""

    def __init__(self, min: float | None = None, max: float | None = None, *, integer: bool = False):  # noqa: A002
        self.min, self.max, self.integer = min, max, integer

    def _parse_inner(self, value, path, ctx):
        if not _is_js_number(value) or value != value:  # bool is not a number; NaN is invalid_type
            return _type_issue(ctx, path, value)
        status = VALID
        if self.integer and not (isinstance(value, int) or value.is_integer()):
            ctx.add(path, "validation.type")
            status = DIRTY
        if self.min is not None and value < self.min:
            ctx.add(path, "validation.min")
            status = DIRTY
        if self.max is not None and value > self.max:
            ctx.add(path, "validation.max")
            status = DIRTY
        if self.integer and isinstance(value, float) and value.is_integer():
            value = int(value)
        return status, value


def Int(min: int | None = None, max: int | None = None) -> Field:  # noqa: N802, A002
    return Num(min, max, integer=True)


class Bool(Field):
    def _parse_inner(self, value, path, ctx):
        if type(value) is not bool:
            return _type_issue(ctx, path, value)
        return VALID, value


class ListOf(Field):
    """`z.array(child).min(min_items).max(max_items)`; an ABORTED element aborts the array (Zod mergeArray)."""

    def __init__(self, child: Field, min_items: int = 0, max_items: int | None = None):
        self.child, self.min_items, self.max_items = child, min_items, max_items

    def _parse_inner(self, value, path, ctx):
        if not isinstance(value, list):
            return _type_issue(ctx, path, value)
        status = VALID
        if len(value) < self.min_items:
            ctx.add(path, "validation.minItems")
            status = DIRTY
        if self.max_items is not None and len(value) > self.max_items:
            ctx.add(path, "validation.maxItems")
            status = DIRTY
        out = []
        aborted = False
        for i, item in enumerate(value):
            s, v = self.child.parse(item, path + (i,), ctx)
            if s == ABORTED:
                aborted = True
            elif s == DIRTY:
                status = DIRTY
            out.append(v)
        return (ABORTED if aborted else status), out


class Tuple(Field):
    """`z.tuple([a, b, …])` (Zod 3.25): not an array → type (aborted); fewer items → minItems at the tuple (aborted);
    more items → maxItems (dirty) and only the declared items are parsed; then the arrays' merge (an aborted item
    aborts the tuple)."""

    def __init__(self, *items: Field):
        self.items = items

    def _parse_inner(self, value, path, ctx):
        if not isinstance(value, list):
            return _type_issue(ctx, path, value)
        if len(value) < len(self.items):
            ctx.add(path, "validation.minItems")
            return ABORTED, value
        status = VALID
        if len(value) > len(self.items):
            ctx.add(path, "validation.maxItems")
            status = DIRTY
        out = []
        aborted = False
        for i, item in enumerate(self.items):
            s, v = item.parse(value[i], path + (i,), ctx)
            if s == ABORTED:
                aborted = True
            elif s == DIRTY:
                status = DIRTY
            out.append(v)
        return (ABORTED if aborted else status), out


def no_duplicate(field: str) -> Callable[[list, Callable[[Path, str], None]], None]:
    """superRefine: every repeated element (not the first) gets `validation.duplicate` at its own `[i].field`."""

    def check(items: list, add: Callable[[Path, str], None]) -> None:
        seen: list[Any] = []
        for i, item in enumerate(items):
            v = item.get(field, MISSING) if isinstance(item, dict) else MISSING
            if any(same_value_zero(v, s) for s in seen):
                add((i, field), "validation.duplicate")
            seen.append(v)

    return check


# ── objects ───────────────────────────────────────────────────────────────────────────────────────────────────────

class _ObjectMeta(type):
    def __new__(mcs, name, bases, ns):
        cls = super().__new__(mcs, name, bases, ns)
        fields: dict[str, Field] = {}
        for base in reversed(cls.__mro__[1:]):
            fields.update(getattr(base, "fields", {}) or {})
        for k, v in ns.items():
            if isinstance(v, Field):
                fields[ns.get("_wire_names", {}).get(k, k)] = v
        cls.fields = fields
        return cls


class ContractSerializer(Field, metaclass=_ObjectMeta):
    """
    A strict object schema (`z.object({...}).strict()`): fields are class attributes named as on the wire; a usable
    nested field as an instance (`admin = AdminSerializer()`). `parse_body(data)` returns the parsed dict (absent
    optional fields left out) or raises 400 VALIDATION with every error.
    """

    fields: ClassVar[dict[str, Field]] = {}
    #: Python attribute → wire name, for wire names that are not identifiers.
    _wire_names: ClassVar[dict[str, str]] = {}

    def _parse_inner(self, value, path, ctx):
        if not isinstance(value, dict):
            return _type_issue(ctx, path, value)
        status = VALID
        out: dict[str, Any] = {}
        aborted = False
        for name, f in self.fields.items():
            s, v = f.parse(value.get(name, MISSING), path + (name,), ctx)
            if s == ABORTED:
                aborted = True
            elif s == DIRTY:
                status = DIRTY
            if v is not MISSING:
                out[name] = v
        extra = [k for k in value if k not in self.fields]
        for k in extra:
            ctx.add(path + (k,), "validation.unknownField")
        if extra:
            status = DIRTY
        return (ABORTED if aborted else status), out

    #: `atLeastOneKey` (JSON Schema `minProperties: 1`): an object without any known field → `_root
    #: validation.minProperties` (a refinement: it runs unless a member ABORTED).
    min_properties: ClassVar[bool] = False

    @classmethod
    def schema(cls) -> Field:
        if cls.min_properties:
            return cls().refine(lambda obj: len(obj) > 0, "validation.minProperties")
        return cls()

    @classmethod
    def validate(cls, data: Any, schema: Field | None = None) -> tuple[bool, Any, dict[str, list[str]]]:
        ctx = Ctx()
        status, value = (schema or cls.schema()).parse(data, (), ctx)
        return status == VALID, value, ctx.errors

    @classmethod
    def parse_body(cls, data: Any, *, extra_errors: dict[str, list[str]] | None = None) -> dict[str, Any]:
        ok, value, errors = cls.validate(data)
        for path, keys in (extra_errors or {}).items():
            errors.setdefault(path, []).extend(keys)
        if errors:
            raise validation_problem(errors)
        return value


def wire_mass_ok(value: Any) -> bool:
    """Contract `Mass`/`PositiveMass` on the wire: exactly three decimals (the server does not normalize)."""
    return not isinstance(value, str) or ecma(r"^\d{1,9}\.\d{3}$").search(value) is not None


def to_decimal(s: str) -> Decimal:
    return Decimal(s)
