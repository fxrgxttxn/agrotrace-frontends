"""core.render.js_number_text = JavaScript's String(number) (Review Focus 7); plain_number_text = the contract's
XLSX numeric cell (the shortest decimal text, no exponent — backend-express numberText)."""

import pytest

from agrotrace.core.render import js_number_text, plain_number_text


@pytest.mark.parametrize(("x", "text"), [
    (5, "5"),
    (5.0, "5"),
    (0.1, "0.1"),
    (1e21, "1e+21"),
    (1e-7, "1e-7"),
    (123456789012345680000, "123456789012345680000"),
    (1.2345678901234568e20, "123456789012345680000"),
    (1.5, "1.5"),
    (-2.25, "-2.25"),
    (0.000001, "0.000001"),
    (1.5e-10, "1.5e-10"),
    (2.5e21, "2.5e+21"),
    (-0.0, "0"),
    (100.0, "100"),
    (0.30000000000000004, "0.30000000000000004"),
    (float("nan"), "NaN"),
    (float("inf"), "Infinity"),
    (float("-inf"), "-Infinity"),
])
def test_js_number_text(x, text):
    assert js_number_text(x) == text


@pytest.mark.parametrize(("x", "text"), [
    (2, "2"), (2.0, "2"), (0.1, "0.1"), (1.5, "1.5"), (1e-7, "0.0000001"), (1e21, "1000000000000000000000"),
    (1.5e-10, "0.00000000015"), (2.5e21, "2500000000000000000000"), (-1e-7, "-0.0000001"), (3650, "3650"),
])
def test_plain_number_text_never_has_an_exponent(x, text):
    assert plain_number_text(x) == text


def test_js_number_text_refuses_bool():
    with pytest.raises(TypeError):
        js_number_text(True)
