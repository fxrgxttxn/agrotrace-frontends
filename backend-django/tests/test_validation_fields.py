"""
core.validation against the shared Zod schemas (packages/validation/src/common.ts): every expectation below is the
output of the real schemas (zod 3.25.76, `toFieldErrors`), taken once with tsx — the Django port must produce the same
`Problem.errors` keys and paths, and the same parsed values.
"""

import pytest

from agrotrace.core.problem import AppProblem
from agrotrace.core.validation import (
    Bool,
    ContractSerializer,
    DecimalString,
    Email,
    Enum,
    Inn,
    Int,
    IsoDate,
    IsoDateTime,
    ListOf,
    Literal,
    Mass,
    NameString,
    Password,
    Percent,
    RegionCode,
    Uuid,
    format_error_path,
    no_duplicate,
)

U = "8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e"


def one(field, value=...):
    class S(ContractSerializer):
        pass

    S.fields = {"f": field}
    ok, out, errors = S.validate({} if value is ... else {"f": value})
    return (out.get("f") if ok else None), errors.get("f", errors)


@pytest.mark.parametrize(
    ("field", "value", "expected"),
    [
        (NameString(), "", ["validation.required", "validation.pattern"]),
        (NameString(), " ", ["validation.pattern"]),
        (NameString(), ..., ["validation.required"]),
        (NameString(), 5, ["validation.type"]),
        (NameString(), None, ["validation.type"]),
        (NameString(), "😀" * 256, ["validation.maxLength"]),
        (Int(0, 3650), "5", ["validation.type"]),
        (Int(0, 3650), True, ["validation.type"]),
        (Int(0, 3650), 5.5, ["validation.type"]),
        (Int(0, 3650), -1.5, ["validation.type", "validation.min"]),
        (Uuid(), "8f0a2c4e6a8c4e0a9c2e4a6c8e0a2c4e", ["validation.uuid"]),
        (IsoDateTime(), "2026-09-24T08:30:00+03:00", ["validation.dateTime.format"]),
        (IsoDateTime(), "2026-02-30T08:30:00Z", ["validation.dateTime.format"]),
        (Mass(), "0.000", ["validation.positive"]),
        (Mass(), "abc", ["validation.mass.format"]),
        (Mass(), "1.2345", ["validation.mass.format"]),
        (Inn(), "7707083894", ["validation.inn.checksum"]),
        (Inn(), "abc", ["validation.inn.format", "validation.inn.checksum"]),
        (Email(), "", ["validation.required", "validation.email"]),
        (Email(), "a@b", ["validation.email"]),
        (Email(), "a@b.Ka", ["validation.email"]),  # KELVIN SIGN is not an ASCII letter (JS /i)
        (Password(), "", ["validation.required", "validation.password.min"]),
        (Password(), "abc", ["validation.password.min"]),
        (Enum(["A", "B"]), "C", ["validation.enum"]),
        (Enum(["A", "B"]), 1, ["validation.type"]),
        (Bool(), "true", ["validation.type"]),
        (NameString().optional(), None, ["validation.type"]),
        (RegionCode(), "ru-77", ["validation.pattern"]),
        (Percent(), "1.5", ["validation.percent.format"]),
        (DecimalString(), "1.1234567", ["validation.decimal.format"]),
        (Literal("X"), ..., ["validation.enum"]),
    ],
)
def test_error_keys_match_zod(field, value, expected):
    assert one(field, value)[1] == expected


@pytest.mark.parametrize(
    ("field", "value", "parsed"),
    [
        (NameString(), "ab", "ab"),  # two characters pass NameString (`\S` is a search, not a full match)
        (NameString(), "  a  ", "  a  "),  # never trimmed
        (NameString(), "😀" * 255, "😀" * 255),  # length in code points
        (Int(0, 3650), 5.0, 5),  # JSON 5.0 is the integer 5
        (Uuid(), U.upper(), U.upper()),
        (IsoDateTime(), "2026-09-24T08:30:00.123Z", "2026-09-24T08:30:00.123Z"),
        (IsoDateTime(), "2026-09-24T08:30Z", "2026-09-24T08:30Z"),
        (IsoDate(), "2026-02-30", "2026-02-30"),  # the shape only (calendar checks are the operations')
        (Mass(), "1.5", "1.500"),
        (Inn(), "7707083893", "7707083893"),
        (Email(), "Ivan.Petrov@Agro-Trace.test", "Ivan.Petrov@Agro-Trace.test"),
        (NameString().nullable(), None, None),
    ],
)
def test_accepted_values_match_zod(field, value, parsed):
    out, errors = one(field, value)
    assert errors == {}
    assert out == parsed
    assert type(out) is type(parsed)


class Item(ContractSerializer):
    batchId = Uuid()
    m = Mass()


class Body(ContractSerializer):
    items = ListOf(Item(), 1, 2).super_refine(no_duplicate("batchId"))


def errors_of(cls, data):
    return cls.validate(data)[2]


def test_unknown_keys_one_entry_per_key_at_its_own_path():
    class N(ContractSerializer):
        n = NameString()

    assert errors_of(N, {"n": "a", "extra": 1, "other": 2}) == {
        "extra": ["validation.unknownField"],
        "other": ["validation.unknownField"],
    }


def test_root_of_a_non_object_body():
    class N(ContractSerializer):
        n = NameString()

    assert errors_of(N, [1]) == {"_root": ["validation.type"]}
    assert errors_of(N, None) == {"_root": ["validation.type"]}


def test_array_paths_and_duplicates():
    assert errors_of(Body, {"items": [{"batchId": "x", "m": "1"}]}) == {"items[0].batchId": ["validation.uuid"]}
    assert errors_of(Body, {"items": [{"batchId": U, "m": "1"}, {"batchId": U, "m": "1"}]}) == {
        "items[1].batchId": ["validation.duplicate"]
    }
    # An aborted element (here: a mass whose transform did not run) aborts the array: no duplicate check.
    assert errors_of(Body, {"items": [{"batchId": U, "m": "x"}, {"batchId": U, "m": "1"}]}) == {
        "items[0].m": ["validation.mass.format"]
    }
    assert errors_of(Body, {"items": [{"batchId": U, "m": 1}, {"batchId": U, "m": "1"}]}) == {
        "items[0].m": ["validation.type"]
    }
    assert errors_of(Body, {"items": [{}, {}, {}]}) == {
        "items": ["validation.maxItems"],
        "items[0].batchId": ["validation.required"],
        "items[0].m": ["validation.required"],
        "items[1].batchId": ["validation.required"],
        "items[1].m": ["validation.required"],
        "items[2].batchId": ["validation.required"],
        "items[2].m": ["validation.required"],
    }
    assert errors_of(Body, {"items": []}) == {"items": ["validation.minItems"]}


def test_parse_body_raises_one_400_with_extra_errors_merged():
    with pytest.raises(AppProblem) as e:
        Body.parse_body({"items": []}, extra_errors={"If-Match": ["validation.required"]})
    assert e.value.status == 400 and e.value.code == "VALIDATION"
    assert e.value.errors == {"items": ["validation.minItems"], "If-Match": ["validation.required"]}
    assert Body.parse_body({"items": [{"batchId": U, "m": "2"}]}) == {"items": [{"batchId": U, "m": "2.000"}]}


def test_format_error_path():
    assert format_error_path(()) == "_root"
    assert format_error_path(("items", 0, "batchId")) == "items[0].batchId"
    assert format_error_path(("a", "b", 2)) == "a.b[2]"
