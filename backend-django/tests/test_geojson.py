"""FieldInput geometry (packages/validation fields.ts; decision 12 of Express Tasks 4–5): an open ring is reported at
`errors.geometry`; every other geometry error keeps its own path."""

import pytest

from agrotrace.core.problem import AppProblem
from agrotrace.modules.fields.serializers import parse_field_input

RING = [[37.0, 55.0], [37.1, 55.0], [37.1, 55.1], [37.0, 55.0]]


def field(geometry):
    return {"name": "Поле", "areaHa": "12.50", "regionCode": "33", "geometry": geometry}


def errors(body) -> dict:
    with pytest.raises(AppProblem) as e:
        parse_field_input(body)
    return e.value.errors


def test_a_closed_polygon_and_no_geometry_pass():
    assert parse_field_input(field({"type": "Polygon", "coordinates": [RING]}))["geometry"]["coordinates"] == [RING]
    assert parse_field_input(field(None))["geometry"] is None
    assert "geometry" not in parse_field_input({"name": "Поле", "areaHa": "1.00", "regionCode": "33"})


def test_an_open_ring_is_reported_at_geometry():
    open_ring = [[37.0, 55.0], [37.1, 55.0], [37.1, 55.1], [37.2, 55.2]]
    assert errors(field({"type": "Polygon", "coordinates": [open_ring]})) == {
        "geometry": ["validation.geometry.ringNotClosed"]}
    # Two open rings: one entry.
    assert errors(field({"type": "Polygon", "coordinates": [open_ring, open_ring]})) == {
        "geometry": ["validation.geometry.ringNotClosed"]}


def test_other_errors_keep_their_paths():
    assert errors(field({"type": "Polygon", "coordinates": [[[37.0, 55.0], [37.0, 55.0]]]})) == {
        "geometry.coordinates[0]": ["validation.minItems"]}
    assert errors(field({"type": "Polygon", "coordinates": [[[37.0, 55.0], [190, 55.0], [37.1, 55.1], [37.0, 55.0]]]
                         })) == {"geometry.coordinates[0][1][0]": ["validation.max"]}
    assert errors(field({"type": "Polygon", "coordinates": [[[37.0, -91], [37.1, 55.0], [37.1, 55.1], [37.0, -91]]]
                         })) == {"geometry.coordinates[0][0][1]": ["validation.min"],
                                 "geometry.coordinates[0][3][1]": ["validation.min"]}
    assert errors(field({"type": "Point", "coordinates": [RING]})) == {"geometry.type": ["validation.enum"]}
    assert errors(field({"type": "Polygon", "coordinates": []})) == {"geometry.coordinates": ["validation.minItems"]}
    assert errors(field({"type": "Polygon", "coordinates": [[]]})) == {"geometry.coordinates[0]": ["validation.minItems"]}
    assert errors(field({"type": "Polygon", "coordinates": [RING], "x": 1})) == {"geometry.x": ["validation.unknownField"]}


def test_tuples_too_short_too_long_and_typed():
    short = [[37.0], [37.1, 55.0], [37.1, 55.1], [37.0, 55.0]]
    assert errors(field({"type": "Polygon", "coordinates": [short]})) == {
        "geometry.coordinates[0][0]": ["validation.minItems"]}
    long = [[37.0, 55.0, 1], [37.1, 55.0], [37.1, 55.1], [37.0, 55.0]]
    assert errors(field({"type": "Polygon", "coordinates": [long]})) == {
        "geometry.coordinates[0][0]": ["validation.maxItems"]}
    typed = [["37", 55.0], [37.1, 55.0], [37.1, 55.1], [37.0, 55.0]]
    assert errors(field({"type": "Polygon", "coordinates": [typed]})) == {
        "geometry.coordinates[0][0][0]": ["validation.type"]}


def test_an_open_ring_together_with_other_errors():
    ring = [[37.0, 55.0], [37.1, 55.0], [37.2, 55.2]]  # too few positions and open
    got = errors(field({"type": "Polygon", "coordinates": [ring]}))
    assert got == {"geometry.coordinates[0]": ["validation.minItems"], "geometry": ["validation.geometry.ringNotClosed"]}
