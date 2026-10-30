"""infra.csv_read — the CSV side of importDictionary (R58, decision 8 of Express Tasks 4–5): `;`, a BOM, RFC 4180
quotes, a quote inside an unquoted field is ordinary, a character after a closing quote → format, a lone CR is data,
invalid UTF-8 → 400 format, NUL → 415; and the bounded reading of the import (`read_sheet`)."""

import time

import pytest

from agrotrace.infra import csv_read
from agrotrace.infra.csv_read import FormatError, NulByte, TooManyRows, read, read_sheet


def test_semicolons_crlf_lf_and_the_final_line_break():
    assert read(b"a;b\r\nc;d\ne;f\n") == [["a", "b"], ["c", "d"], ["e", "f"]]
    assert read(b"a;b") == [["a", "b"]]
    assert read(b"a\n\n") == [["a"], [""]]
    assert read(b"") == []
    assert read(b";;\n") == [["", "", ""]]


def test_a_leading_bom_is_skipped_once():
    assert read(b"\xef\xbb\xbfname;unit\n") == [["name", "unit"]]
    assert read(b"\xef\xbb\xbf\xef\xbb\xbfx") == [["﻿x"]]


def test_quotes():
    assert read(b'"a;b";"c""d"\n"line\nbreak";x') == [["a;b", 'c"d'], ["line\nbreak", "x"]]
    assert read(b'"";x') == [["", "x"]]
    assert read(b'"a"\r\nb') == [["a"], ["b"]]


def test_a_quote_inside_an_unquoted_field_is_an_ordinary_character():
    assert read(b'a"b;c"d\n') == [['a"b', 'c"d']]
    assert read(b'x;5"') == [["x", '5"']]


@pytest.mark.parametrize("data", [b'"a"b;c', b'"a" ;b', b'x;"a"b', b'"a"\rb', b'"unclosed', b'x;"open\n'])
def test_a_character_after_a_closing_quote_or_an_unclosed_quote_is_a_format_error(data):
    with pytest.raises(FormatError):
        read(data)


def test_a_lone_cr_is_data():
    assert read(b"a\rb;c\n") == [["a\rb", "c"]]
    assert read(b"a;b\r") == [["a", "b\r"]]
    assert read(b'"q"\r\n"r"') == [["q"], ["r"]]


def test_invalid_utf8_is_a_format_error_and_nul_is_unsupported():
    with pytest.raises(FormatError):
        read(b"name;unit\n\xff\xfe;x")
    with pytest.raises(FormatError):
        read(b"\xed\xa0\x80")  # an encoded surrogate
    with pytest.raises(NulByte):
        read(b"name;unit\nx\x00;y")


def test_read_sheet_numbers_rows_skips_empty_ones_and_marks_wrong_widths():
    sheet = read_sheet(b'code;name\n\n;\n"";""\nA;x\nB;y;z\n"C";"q;r"\r\n\nD\n', 2)
    assert sheet.header == ["code", "name"]
    assert sheet.rows == [(5, ["A", "x"]), (6, None), (7, ["C", "q;r"]), (9, None)]
    assert sheet.pad_short is False
    # A header of another width is no header.
    assert read_sheet(b"code;name;extra\nA;b\n", 2).header is None
    assert read_sheet(b"", 2).header is None


def test_more_than_10000_rows_is_too_many_but_a_later_format_error_wins():
    rows = b"".join(b"R%d;x\n" % i for i in range(10_001))
    with pytest.raises(TooManyRows):
        read_sheet(b"code;name\n" + rows, 2)
    assert len(read_sheet(b"code;name\n" + rows[: rows.index(b"R10000")], 2).rows) == 10_000
    with pytest.raises(FormatError):
        read_sheet(b"code;name\n" + rows + b'"open', 2)
    with pytest.raises(FormatError):
        read_sheet(b"code;name\n" + rows + b'"a"b\n', 2)
    # Empty rows do not count.
    assert len(read_sheet(b"code;name\n" + b"\n;\n" * 20_000 + b"A;b\n", 2).rows) == 1


def test_bounded_on_adversarial_files():
    """5 MiB of tiny fields, empty lines or quoted fields: C-level work per record or run, no per-field objects."""
    cases = [
        b"name;unit\n" + b";" * (5 * 1024 * 1024),
        b"name;unit\n" + b"\n" * (5 * 1024 * 1024),
        b"name;unit\n" + b'"";' * (1700 * 1024),
        b"name;unit\n" + b'x;"a""b";' * (500 * 1024),
        b"name;unit\n" + b"a\n" * (2500 * 1024),
    ]
    for data in cases:
        started = time.monotonic()
        try:
            read_sheet(data, 2)
        except (TooManyRows, FormatError):
            pass
        assert time.monotonic() - started < 3.0, data[:40]


def test_the_import_types():
    assert csv_read.IMPORT_TYPES == ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]


def test_quoted_records_wider_than_one_regex_chunk():
    """Widths and emptiness are summed over the 4096-field chunks of a quoted record."""
    empty = b'"";' * 9000 + b'""\n'
    wide = b'"x";' * 9000 + b'"y"\n'
    sheet = read_sheet(b"code;name\n" + empty + wide + b'"a;b";"c"\n', 2)
    assert sheet.rows == [(3, None), (4, ["a;b", "c"])]
    assert len(read(b"" + wide)[0]) == 9001
    with pytest.raises(FormatError):
        read_sheet(b"code;name\n" + b'"x";' * 9000 + b'"y"z\n', 2)
