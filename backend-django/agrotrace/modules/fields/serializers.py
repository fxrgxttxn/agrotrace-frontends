"""Request bodies of /fields/* and /treatments/* — the port of packages/validation/src/fields.ts (FieldInput with a
GeoJSON Polygon, TreatmentInput)."""

from __future__ import annotations

from agrotrace.core.validation import (
    ContractSerializer,
    Enum,
    IsoDateTime,
    ListOf,
    Literal,
    Num,
    RegionCode,
    Str,
    String,
    Tuple,
    Uuid,
    _regex,
)

RING_NOT_CLOSED = "validation.geometry.ringNotClosed"
DOSE_UNITS = ("л/га", "мл/га", "кг/га", "г/га")


def _closed(ring: list) -> bool:
    # An empty ring is reported by min(4) alone (the refinement still runs on a "dirty" array).
    if len(ring) == 0:
        return True
    first, last = ring[0], ring[-1]
    return first[0] == last[0] and first[1] == last[1]


_ring = ListOf(Tuple(Num(-180, 180), Num(-90, 90)), 4, 1000).refine(_closed, RING_NOT_CLOSED)


class GeoJsonPolygon(ContractSerializer):
    type = Literal("Polygon")
    coordinates = ListOf(_ring, 1, 10)


class FieldInput(ContractSerializer):
    name = String(1, 160, r"\S")
    areaHa = Str([(_regex(r"^(?!0+\.00$)\d{1,8}\.\d{2}$"), "validation.areaHa.format")])  # noqa: N815
    regionCode = RegionCode()  # noqa: N815
    geometry = GeoJsonPolygon().nullable().optional()


class TreatmentInput(ContractSerializer):
    substanceId = Uuid()  # noqa: N815
    dose = Str([(_regex(r"^(?!0+\.000$)\d{1,7}\.\d{3}$"), "validation.dose.format")])
    doseUnit = Enum(DOSE_UNITS)  # noqa: N815
    appliedAt = IsoDateTime()  # noqa: N815


def parse_field_input(body) -> dict:
    """FieldInput by the shared schema; the contract reports an open ring at `errors.geometry` (not at the ring's own
    path), other geometry errors keep their paths (`geometry.coordinates[0]`, `geometry.coordinates[0][1][0]` …) —
    decision 12 of Express Tasks 4–5."""
    from agrotrace.core.problem import validation_problem

    ok, value, errors = FieldInput.validate(body)
    if ok:
        return value
    for path in list(errors):
        keys = errors[path]
        if path == "geometry" or not path.startswith("geometry") or RING_NOT_CLOSED not in keys:
            continue
        rest = [k for k in keys if k != RING_NOT_CLOSED]
        if rest:
            errors[path] = rest
        else:
            del errors[path]
        at = errors.setdefault("geometry", [])
        if RING_NOT_CLOSED not in at:
            at.append(RING_NOT_CLOSED)
    raise validation_problem(errors)
