"""
The CSV side of importDictionary (R58, contract importDictionary "Формат файла"), the port of backend-express/src/
modules/dictionaries/sheet.ts `readSheet`/`parseCsv`: UTF-8 (one leading BOM skipped), `;` separators, RFC 4180 quotes
(`""` inside a quoted field), records ending at LF or CRLF; the final line break does not start another record.

- a byte NUL → 415 `{allowed}`; invalid UTF-8 → 400 `errors.file: [validation.import.format]`;
- a field is quoted when it STARTS with `"`; a quote inside an unquoted field is an ordinary character; after a closing
  quote only `;` or a record end may follow, and a quote left open at the end of the file — both 400 format;
- a lone CR (not followed by LF) is data.

Bounded work (P61 holder rule: it runs before any SQL, on the request thread, holding no connection). Express parses
CSV on its event loop; here every step is a C-level `str`/`re` operation over a record or a run of records, so a
5 MiB file never turns into a Python loop per character or per field:
- runs of empty records (only `;` and `""` fields) are skipped by one bounded regex call per 4096 records;
- a record without quotes is a line (`find`), its fields counted with `count(';')`;
- a record with quotes is matched by possessive (non-backtracking) regexes, 4096 fields per call (one call holds
  the GIL; a call over a whole 5 MiB record stalled other request threads for ~0.5 s);
- only the header and the non-empty data rows whose field count fits the dictionary are split into fields — a row of
  the wrong width becomes a `None` marker (the import reports it as `validation.import.columns` and never looks at its
  cells), so a 5 MiB record of one-character fields costs no per-field objects;
- after 10 000 non-empty data rows nothing more is kept; the rest of the file is still checked for format errors (they
  win over `tooManyRows`, as Express parses the whole file first) — in bounded runs, skipped when no quote follows.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

MAX_DATA_ROWS = 10_000
IMPORT_TYPES = ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]

_Q = r'"[^"]*+(?:""[^"]*+)*+"'
_U = r'(?!")[^;\n\r]*+(?:\r(?!\n)[^;\n\r]*+)*+'
_FIELD = f"(?:{_Q}|{_U})"
_EMPTY = r'(?:""|)(?:;(?:""|))*+'
_EMPTY_RUN = re.compile(f"(?:(?>{_EMPTY})\\r?\\n){{0,4096}}+")
_FIRST_FIELD = re.compile(_FIELD)
_MORE_FIELDS = re.compile(f"(?:;{_FIELD}){{0,4096}}+")
_EMPTY_MORE = re.compile(r'(?:;(?:""|))*+')
_QUOTED_AFTER_SEMI = re.compile(f"(?<=;){_Q}")
#: Runs of well-formed short records (the tail check after 10 000 rows), at most 4096 per call.
_REST_RUN = re.compile(f"(?:{_FIELD}(?:;{_FIELD}){{0,64}}+(?:\\r\\n|\\n)){{0,4096}}+")
_FIELD_TOKEN = re.compile(f"({_Q})|({_U})")


@dataclass
class Sheet:
    """The header and the data rows of an import file. `rows`: (row number, cells) — the CSV record number / the sheet
    row number (the header is 1, skipped empty rows are counted); `cells` None — a CSV row whose width differs from
    the dictionary's columns (only its number matters). `pad_short`: XLSX rows narrower than the header are padded."""

    header: list[Any] | None
    rows: list[tuple[int, list[Any] | None]] = field(default_factory=list)
    pad_short: bool = False


class FormatError(Exception):
    """400 `errors.file: [validation.import.format]`."""


class NulByte(Exception):
    """415 `{allowed}` (R58)."""


class TooManyRows(Exception):
    """400 `errors.file: [validation.import.tooManyRows]`."""


def decode(data: bytes) -> str:
    if b"\x00" in data:
        raise NulByte()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise FormatError() from None
    return text[1:] if text.startswith("﻿") else text


def _fields(text: str, start: int, end: int, quoted: bool) -> list[str]:
    """The fields of the record text[start:end] (known well-formed)."""
    if not quoted:
        return text[start:end].split(";")
    out = []
    p = start
    while True:
        m = _FIELD_TOKEN.match(text, p, end)
        assert m is not None
        q = m.group(1)
        out.append(q[1:-1].replace('""', '"') if q is not None else m.group(2))
        p = m.end()
        if p >= end:
            return out
        p += 1  # the `;`


class _Reader:
    def __init__(self, text: str):
        self.text = text
        self.n = len(text)

    def record(self, pos: int) -> tuple[int, int, int, bool, int, bool]:
        """The record at pos: (content start, content end, next position, has quotes, number of fields, all fields
        empty); FormatError if malformed. A quoted record is matched 4096 fields per regex call, so no single call
        (which holds the GIL) runs over a whole 5 MiB record."""
        text, n = self.text, self.n
        nl = text.find("\n", pos)
        line_end = n if nl < 0 else nl
        if text.find('"', pos, line_end) < 0:
            # No quote on the line: the record is the line (a lone CR is data; CRLF ends it).
            end = line_end - 1 if nl >= 0 and line_end > pos and text[line_end - 1] == "\r" else line_end
            semis = text.count(";", pos, end)
            return pos, end, (n if nl < 0 else nl + 1), False, semis + 1, semis == end - pos
        m = _FIRST_FIELD.match(text, pos)
        if m is None:
            raise FormatError()  # a quote left open at the start of the first field
        end = m.end()
        width = 1
        empty = end - pos == 0 or text.startswith('""', pos) and end - pos == 2
        while True:
            m = _MORE_FIELDS.match(text, end)
            e = m.end()
            if e == end:
                break
            chunk = text[end:e]
            width += _QUOTED_AFTER_SEMI.sub("", chunk).count(";")
            if empty and _EMPTY_MORE.fullmatch(chunk) is None:
                empty = False
            end = e
        if end >= n:
            return pos, end, n, True, width, empty
        if text[end] == "\n":
            return pos, end, end + 1, True, width, empty
        if text.startswith("\r\n", end):
            return pos, end, end + 2, True, width, empty
        raise FormatError()  # a character after a closing quote, or an unclosed quote

    def check_rest(self, pos: int) -> None:
        """FormatError if the text from pos on is not well-formed CSV (format errors win over tooManyRows): nothing to
        check without a quote; otherwise runs of short records per regex call, wide ones via record()."""
        text, n = self.text, self.n
        if text.find('"', pos) < 0:
            return
        while pos < n:
            e = _REST_RUN.match(text, pos).end()
            if e > pos:
                pos = e
                continue
            pos = self.record(pos)[2]


def parse(text: str, ncols: int | None = None, max_rows: int | None = MAX_DATA_ROWS) -> Sheet:
    """The header (record 1) and the non-empty data rows. With `ncols`, a header or row of another width is reduced to
    None (see the module docstring); without it every record keeps its fields (tests). More than `max_rows` non-empty
    data rows → TooManyRows, after the rest of the file was checked for format errors."""
    r = _Reader(text)
    n = r.n
    sheet = Sheet(header=None)
    if n == 0:
        return sheet
    start, end, pos, quoted, width, _ = r.record(0)
    sheet.header = _fields(text, start, end, quoted) if ncols is None or width == ncols else None
    number = 1
    while pos < n:
        m = _EMPTY_RUN.match(text, pos)
        if m.end() > pos:
            number += text.count("\n", pos, m.end())
            pos = m.end()
            continue
        start, end, next_pos, quoted, width, empty = r.record(pos)
        number += 1
        if empty:
            pos = next_pos
            continue
        if max_rows is not None and len(sheet.rows) == max_rows:
            r.check_rest(start)
            raise TooManyRows()
        pos = next_pos
        cells = _fields(text, start, end, quoted) if ncols is None or width == ncols else None
        sheet.rows.append((number, cells))
    return sheet


def read(data: bytes) -> list[list[str]]:
    """Every record of a CSV file as its fields (the header first, empty records included as parsed) — the plain
    RFC 4180 reading, for tests and tools; the import uses `read_sheet`."""
    text = decode(data)
    r = _Reader(text)
    out: list[list[str]] = []
    pos = 0
    while pos < r.n:
        start, end, pos, quoted, _, _ = r.record(pos)
        out.append(_fields(text, start, end, quoted))
    return out


def read_sheet(data: bytes, ncols: int) -> Sheet:
    """The import's reading of a CSV file (see the module docstring); raises NulByte, FormatError, TooManyRows."""
    return parse(decode(data), ncols)
