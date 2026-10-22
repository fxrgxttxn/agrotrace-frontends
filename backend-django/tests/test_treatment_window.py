"""domain.dates.can_edit_treatment — every case of contracts/rules/vectors/treatment-edit.json (the 24 h boundary is
inclusive, instants at millisecond precision)."""

import json
from datetime import UTC, datetime

import pytest

from agrotrace.core.config import ROOT
from agrotrace.domain.dates import can_edit_treatment, editable_until

VECTORS = json.loads((ROOT / "contracts" / "rules" / "vectors" / "treatment-edit.json").read_text("utf-8"))


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_vectors(case):
    assert {"allowed": can_edit_treatment(case["input"]["createdAt"], case["input"]["now"])} == case["expected"]


def test_datetimes_count_milliseconds_only():
    created = datetime(2026, 9, 9, 10, 0, 0, 999, tzinfo=UTC)  # +999 µs: still 10:00:00.000 for JavaScript
    assert can_edit_treatment(created, datetime(2026, 9, 10, 10, 0, 0, 0, tzinfo=UTC))
    assert not can_edit_treatment(created, datetime(2026, 9, 10, 10, 0, 0, 1000, tzinfo=UTC))
    assert editable_until(created) == datetime(2026, 9, 10, 10, 0, 0, 999, tzinfo=UTC)
    with pytest.raises(ValueError):
        can_edit_treatment(datetime(2026, 1, 1), datetime(2026, 1, 1, tzinfo=UTC))
