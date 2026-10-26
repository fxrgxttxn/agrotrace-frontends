"""markNotificationsRead body (modules/notifications/serializers.py) — Zod 3 `z.union` of two strict objects, keys as
`MarkReadRequestSchema` gives them: the first DIRTY option's issues, else `_root: validation.invalid`."""

import pytest

from agrotrace.modules.notifications.serializers import validate_mark_read

U1 = "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e"
U2 = "B7C8D9E0-F1A2-4B3C-8D4E-5F6A7B8C9D0F"


@pytest.mark.parametrize("body, errors", [
    ({"ids": [U1, U2]}, {}),
    ({"upToSeq": 3}, {}),
    ({"upToSeq": 3.0}, {}),
    ({"ids": []}, {"ids": ["validation.minItems"]}),
    ({"ids": [U1, U1]}, {"ids": ["validation.duplicate"]}),
    ({"ids": ["x", "x"]}, {"ids[0]": ["validation.uuid"], "ids[1]": ["validation.uuid"],
                           "ids": ["validation.duplicate"]}),
    ({"ids": [U1] * 101}, {"ids": ["validation.maxItems", "validation.duplicate"]}),
    ({"upToSeq": 0}, {"upToSeq": ["validation.min"]}),
    ({"upToSeq": 1.5}, {"upToSeq": ["validation.type"]}),
    ({"ids": [U1], "upToSeq": 1}, {"upToSeq": ["validation.unknownField"]}),
    ({"upToSeq": 1, "x": 1}, {"x": ["validation.unknownField"]}),
    ({}, {"_root": ["validation.invalid"]}),
    ({"ids": [1]}, {"_root": ["validation.invalid"]}),
    ({"ids": "x"}, {"_root": ["validation.invalid"]}),
    ({"upToSeq": "1"}, {"_root": ["validation.invalid"]}),
    ({"upToSeq": True}, {"_root": ["validation.invalid"]}),
    ([], {"_root": ["validation.invalid"]}),
    (None, {"_root": ["validation.invalid"]}),
])
def test_union_errors(body, errors):
    _status, _value, got = validate_mark_read(body)
    assert got == errors
