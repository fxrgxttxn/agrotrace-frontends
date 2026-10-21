"""core.patterns.ecma: contract patterns keep their ECMA-262 / JSON Schema meaning in Python (D-I1)."""

from agrotrace.core.patterns import ecma
from agrotrace.domain.idempotency import idempotency_decision


def test_non_space_is_a_search_not_a_full_match():
    assert ecma(r"\S").search("ab")  # a two-character NameString passes
    assert ecma(r"\S").search(" ") is None  # NBSP is JS white space
    assert ecma(r"\S").search(" ﻿") is None  # so is the BOM
    assert ecma(r"\S").search(" \t 　x")


def test_anchored_prefix():
    assert ecma("^otpauth://totp/").search("otpauth://totp/AgroTrace:ivan?secret=" + "A" * 200)
    assert ecma("^otpauth://totp/").search("xotpauth://totp/") is None


def test_dot_does_not_match_line_terminators():
    for c in "\n\r  ":
        assert ecma("^a.b$").search(f"a{c}b") is None
    assert ecma("^a.b$").search("a b")
    assert ecma("^a.b$", "s").search("a b")


def test_digits_are_ascii_and_dollar_is_the_very_end():
    assert ecma(r"^\d+$").search("123")
    assert ecma(r"^\d+$").search("٣") is None  # ARABIC-INDIC DIGIT THREE
    assert ecma(r"^\d+$").search("1\n") is None  # Python's `$` would accept the trailing newline
    assert ecma(r"^\w+$").search("ж") is None


def test_br11_key_with_a_trailing_newline_is_invalid():
    assert idempotency_decision("abcdefgh", None, "f") == "EXECUTE"
    assert idempotency_decision("abcdefgh\n", None, "f") == "INVALID_KEY"
    assert idempotency_decision("abc", None, "f") == "INVALID_KEY"
    assert idempotency_decision("abcdefgh", {"fingerprint": "f"}, "f") == "REPLAY"
    assert idempotency_decision("abcdefgh", {"fingerprint": "g"}, "f") == "CONFLICT"


def test_character_classes_and_case_folding():
    assert ecma(r"^[\s]$").search(" ")
    assert ecma(r"^[a\S]$").search("x")  # a negated shorthand inside a class
    assert ecma("^[A-Z]+$", "i").search("abc")
    assert ecma("^[A-Z]+$", "i").search("K") is None  # KELVIN SIGN never folds onto K in JS
    assert ecma(r"^(?<y>\d{4})$").search("2026").group("y") == "2026"
    assert ecma(r"\bab\b").search("x ab y")
    assert ecma(r"\bab\b").search("жabж")  # Cyrillic is not a JS word character
