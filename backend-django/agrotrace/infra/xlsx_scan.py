"""
The XLSX side of importDictionary (contract importDictionary, P23–P28), the port of backend-express/src/modules/
dictionaries/{xlsx-scan,xlsx-read,sheet}.ts. The cell values come from the SAME streaming scanner pass that checks the
limits of the sheet (D-I9): openpyxl is never used for reading an import (its date conversion by number format,
formulas instead of their values and whole-workbook loading do not fit).

Stages — the contract's precedence, the first failing check decides:
1. the ZIP directory (infra.zip): ≤ 64 entries, declared ≤ 16 MiB per entry and ≤ 32 MiB in all, then "not a workbook"
   (no `[Content_Types].xml` or `xl/workbook.xml` → 415 `{allowed}`), then the part caps (`xl/workbook.xml`, its
   relationships and `xl/styles.xml` ≤ 1 MiB) — on the request thread (`check_directory`, cheap), and again in the
   child;
2. inflating EVERY entry in central-directory order (larger than declared → too large; shorter or a bad CRC → 415);
3. the linear, namespace-aware pre-scan in document order: the workbook part and its relationships (the first
   `<sheet>`, its target per OPC), the first sheet (≤ 20 000 `<row>`, ≤ 64 `<c>` per row, no column beyond `BL`, the
   `r` rules of P26), then the shared strings (≤ 200 000 `<si>`, ≤ 200 000 runs `<r>`); on one element a malformed
   reference beats a limit; a sheet violation beats a shared-strings one;
4. reading: every part read is well-formed XML 1.0 (expat, the equivalent of the saxes parser exceljs reads with),
   ≤ 10 000 non-empty data rows (else `tooManyRows`), the result text ≤ 8 MiB of UTF-8;
5. the header (the caller).
Too large → 415 `{allowed, reason: workbook-too-large}`; anything unreadable → 415 `{allowed}`.

Stages 2–4 run in a child process behind one of two bounded Lanes (≤ 64 KiB and larger files; 1 running + 8 waiting,
a 10 s deadline counted from enqueue, 256 MB address space — Express's worker-queue lanes): a full lane, the deadline
or a child killed at its memory limit is too large. The request thread holds no pool connection meanwhile (P61).

Cell values (exceljs semantics where the contract and the task brief agree with it — test_xlsx_read.py):
- a shared string (`t="s"`) or an inline string (`t="inlineStr"`, `<is>`) — its text as is; rich text — its runs
  concatenated (phonetic `<rPh>` runs are not part of the text); `t="str"` — the text of `<v>`;
- a number (`t` absent or `n`) — the shortest decimal text without an exponent (`5` → `'5'`, `1.50` → `'1.5'`); a number
  whose cell (or, for a cell without a style, its row) has a date format — Invalid;
- `t="b"`, `t="e"`, `t="d"` — Invalid (`validation.pattern` in any column);
- a formula — its cached result `<v>` typed as above (`t="str"` text, `b`/`e` Invalid, otherwise a number); without
  `<v>` — empty;
- trailing empty cells are dropped (a narrower row is padded by the import); a gap by `r` is an empty cell;
- a cell over 1 000 characters never leaves the child: Invalid(`validation.maxLength`).
"""

from __future__ import annotations

import re
import xml.parsers.expat
from collections.abc import Callable
from typing import Any

from agrotrace.core.render import plain_number_text
from agrotrace.infra.csv_read import IMPORT_TYPES, Sheet
from agrotrace.infra.zip import ZipError, ZipLimits, directory, unzip

MiB = 1024 * 1024
ZIP_LIMITS = ZipLimits(max_entries=64, max_entry_bytes=16 * MiB, max_total_bytes=32 * MiB)
PART_CAPS = {"xl/workbook.xml": MiB, "xl/_rels/workbook.xml.rels": MiB, "xl/styles.xml": MiB}
MAX_ROWS = 20_000
MAX_CELLS_PER_ROW = 64
MAX_STRINGS = 200_000
MAX_RUNS = 200_000
MAX_ROW_NUMBER = 1_048_576
MAX_DATA_ROWS = 10_000
MAX_CELL_CHARS = 1000
MAX_RESULT_BYTES = 8 * MiB

SPREADSHEETML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
STRICT_SPREADSHEETML = "http://purl.oclc.org/ooxml/spreadsheetml/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
WORKSHEET_TYPE = R_NS + "/worksheet"
XML_NS = "http://www.w3.org/XML/1998/namespace"
XMLNS_NS = "http://www.w3.org/2000/xmlns/"
MAX_DEPTH = 256


class Invalid:
    """A cell the import reports with `message` whatever the column's rule: another type (date, boolean, error) —
    `validation.pattern`; a text over 1 000 characters — `validation.maxLength`."""

    __slots__ = ("message",)

    def __init__(self, message: str):
        self.message = message

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Invalid) and other.message == self.message

    def __hash__(self) -> int:
        return hash(self.message)

    def __repr__(self) -> str:
        return f"Invalid({self.message!r})"

    def __reduce__(self):
        return (Invalid, (self.message,))


INVALID = Invalid("validation.pattern")
TOO_LONG = Invalid("validation.maxLength")
Cell = str | Invalid


class ScanError(Exception):
    def __init__(self, kind: str):  # 'malformed' | 'tooLarge'
        super().__init__(f"xlsx scan: {kind}")
        self.kind = kind


class _Stop(Exception):
    def __init__(self, kind: str):  # 'tooLarge' | 'unsupported' | 'tooManyRows'
        super().__init__(kind)
        self.kind = kind


def _malformed() -> ScanError:
    return ScanError("malformed")


# ── the scanner (xlsx-scan.ts scanXml) ───────────────────────────────────────────────────────────────────────────────

_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_NONSPACE = re.compile(r"[^ \t\n\r]")
_START = re.compile(
    r"([^ \t\n\r/><]++)((?:[ \t\n\r]*+[^ \t\n\r=>/<]++[ \t\n\r]*+=[ \t\n\r]*+(?:\"[^\"]*+\"|'[^']*+'))*+)"
    r"[ \t\n\r]*+(/?)>"
)
_END = re.compile(r"([^ \t\n\r/><]++)[ \t\n\r]*+>")
_ATTR = re.compile(r"[ \t\n\r]*+([^ \t\n\r=>/<]++)[ \t\n\r]*+=[ \t\n\r]*+(\"[^\"]*+\"|'[^']*+')")
_NAMED = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}
_SPACE = " \t\n\r"


def _legal_char(c: int) -> bool:
    return c in (0x9, 0xA, 0xD) or 0x20 <= c <= 0xD7FF or 0xE000 <= c <= 0xFFFD or 0x10000 <= c <= 0x10FFFF


def _entity_text(ent: str) -> str:
    """The text of an entity or character reference (`amp`, `#58`, `#x0000003A`); malformed when undefined/illegal."""
    named = _NAMED.get(ent)
    if named is not None:
        return named
    if len(ent) < 2 or ent[0] != "#":
        raise _malformed()
    hexa = ent[1] == "x"
    digits = ent[2:] if hexa else ent[1:]
    if not digits:
        raise _malformed()
    n = 0
    base = 16 if hexa else 10
    for ch in digits:
        if "0" <= ch <= "9":
            v = ord(ch) - 48
        elif hexa and "a" <= ch.lower() <= "f":
            v = ord(ch.lower()) - 87
        else:
            raise _malformed()
        n = n * base + v
        if n > 0x10FFFF:
            raise _malformed()
    if not _legal_char(n):
        raise _malformed()
    return chr(n)


def _decode(v: str) -> str:
    """Entity-decodes `v` (an attribute value or character data), validating every reference."""
    if "&" not in v:
        return v
    out = []
    i = 0
    while True:
        amp = v.find("&", i)
        if amp < 0:
            out.append(v[i:])
            return "".join(out)
        semi = v.find(";", amp)
        if semi < 0:
            raise _malformed()
        out.append(v[i:amp])
        out.append(_entity_text(v[amp + 1: semi]))
        i = semi + 1


def _text_value(raw: str) -> str:
    """Character data as an XML parser reports it: line ends normalized (CRLF/CR → LF), then references decoded."""
    if "\r" in raw:
        raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    return _decode(raw)


def _split_name(q: str) -> tuple[str, str]:
    """A QName: `local` or `prefix:local`, both parts non-empty, at most one `:` (P28)."""
    i = q.find(":")
    if i < 0:
        return "", q
    if i == 0 or i == len(q) - 1 or q.find(":", i + 1) >= 0:
        raise _malformed()
    return q[:i], q[i + 1:]


#: on_tag(end, self_closing, local_name, prefixed, ns, default_ns, attrs)
OnTag = Callable[[bool, bool, str, bool, str, "str | None", dict], None]
#: on_text(raw_text, is_cdata) — character data inside the root element
OnText = Callable[[str, bool], None]
_NO_ATTRS: dict = {}


def scan_xml(text: str, want_attrs: Callable[[str], bool], on_tag: OnTag, on_text: OnText | None = None) -> None:
    """Calls `on_tag` for every tag of `text` in order (attributes collected when `want_attrs(local)`: an unprefixed one
    by its name, a prefixed one as `{namespace}local`, values decoded) and `on_text` for character data inside the
    root. Raises ScanError('malformed') for what is not namespace-well-formed XML 1.0 (the P27/P28 list)."""
    if _ILLEGAL.search(text):
        raise _malformed()
    n = len(text)
    find = text.find
    stack: list[tuple[str, list | None]] = []
    bindings: dict[str, str | None] = {"xml": XML_NS}
    next_amp = -2
    root_seen = root_done = False
    i = 0
    while True:
        lt = find("<", i)
        seg_end = n if lt < 0 else lt
        if seg_end > i:
            if not stack:
                if _NONSPACE.search(text, i, seg_end):
                    raise _malformed()  # outside the root only whitespace
            else:
                # The references of this segment (the next `&` is remembered: one pass over the document).
                frm = i
                while True:
                    if next_amp != -1 and next_amp < frm:
                        next_amp = find("&", frm)
                    if next_amp < 0 or next_amp >= seg_end:
                        break
                    semi = find(";", next_amp)
                    if semi < 0 or semi > seg_end:
                        raise _malformed()
                    _entity_text(text[next_amp + 1: semi])
                    frm = semi + 1
                if on_text is not None:
                    on_text(text[i:seg_end], False)
        if lt < 0:
            break
        c = text[lt + 1: lt + 2]
        if c == "?":
            end = find("?>", lt + 2)
            if end < 0:
                raise _malformed()
            if text.startswith("<?xml", lt) and text[lt + 5: lt + 6] in (" ", "\t", "\n", "\r") and lt + 5 < n:
                decl = text[lt:end]
                k = decl.find("encoding")
                if k >= 0:
                    q = decl.find('"', k)
                    q2 = decl.find("'", k)
                    if q < 0 or (0 <= q2 < q):
                        q = q2
                    close = -1 if q < 0 else decl.find(decl[q], q + 1)
                    if close < 0 or decl[q + 1: close].lower() != "utf-8":
                        raise _malformed()
            i = end + 2
            continue
        if c == "!":
            if text.startswith("<!--", lt):
                close = find("-->", lt + 4)
                if close < 0:
                    raise _malformed()
                dd = find("--", lt + 4)
                if dd < close or (close > lt + 4 and text[close - 1] == "-"):
                    raise _malformed()
                i = close + 3
            elif text.startswith("<![CDATA[", lt) and stack:
                close = find("]]>", lt + 9)
                if close < 0:
                    raise _malformed()
                if on_text is not None:
                    on_text(text[lt + 9: close], True)
                i = close + 3
            else:
                raise _malformed()  # DOCTYPE, entity declarations, CDATA outside the root
            continue
        if c == "/":
            m = _END.match(text, lt + 2)
            if m is None:
                raise _malformed()
            qname = m.group(1)
            prefix, name = _split_name(qname)
            if prefix == "xmlns":
                raise _malformed()
            if not stack or stack[-1][0] != qname:
                raise _malformed()
            _, undo = stack.pop()
            ns = bindings.get(prefix) if prefix else bindings.get("")
            if undo:
                for p, prev in reversed(undo):
                    bindings[p] = prev
            if not stack:
                root_done = True
            i = m.end()
            on_tag(True, False, name, prefix != "", ns or "", None, _NO_ATTRS)
            continue

        m = _START.match(text, lt + 1)
        if m is None:
            raise _malformed()
        qname, raw_attrs, slash = m.group(1), m.group(2), m.group(3)
        prefix, name = _split_name(qname)
        if prefix == "xmlns":
            raise _malformed()
        if root_done:
            raise _malformed()  # a second root element
        collect = want_attrs(name)
        attrs: dict | None = None
        decls: list[tuple[str, str]] | None = None
        default_ns: str | None = None
        prefixed_attrs: list[tuple[str, str, str]] | None = None
        if raw_attrs:
            if "<" in raw_attrs:
                raise _malformed()  # `<` in an attribute value
            seen: set[str] = set()
            for attr_name, quoted in _ATTR.findall(raw_attrs):
                if attr_name in seen:
                    raise _malformed()
                seen.add(attr_name)
                value = _decode(quoted[1:-1])
                if ":" not in attr_name:
                    if attr_name == "xmlns":
                        if value in (XML_NS, XMLNS_NS):
                            raise _malformed()
                        default_ns = value
                        (decls := decls if decls is not None else []).append(("", value))
                    elif collect:
                        (attrs := attrs if attrs is not None else {})[attr_name] = value
                    continue
                ap, al = _split_name(attr_name)
                if ap == "xmlns":
                    if al == "xmlns" or value == "" or value == XMLNS_NS:
                        raise _malformed()
                    if (al == "xml") != (value == XML_NS):
                        raise _malformed()
                    if al != "xml":
                        (decls := decls if decls is not None else []).append((al, value))
                else:
                    (prefixed_attrs := prefixed_attrs if prefixed_attrs is not None else []).append((ap, al, value))
        undo: list | None = None
        if decls:
            undo = []
            for p, uri in decls:
                undo.append((p, bindings.get(p)))
                bindings[p] = None if (p == "" and uri == "") else uri
        if prefix:
            ns = bindings.get(prefix)
            if ns is None:
                raise _malformed()  # unbound prefix
        else:
            ns = bindings.get("") or ""
        if prefixed_attrs:
            expanded: set[str] = set()
            for ap, al, value in prefixed_attrs:
                uri = bindings.get(ap)
                if uri is None:
                    raise _malformed()  # unbound attribute prefix
                key = "{" + uri + "}" + al
                if key in expanded:
                    raise _malformed()  # one expanded name twice
                expanded.add(key)
                if collect:
                    (attrs := attrs if attrs is not None else {})[key] = value
        root_seen = True
        self_closing = slash == "/"
        if self_closing:
            if undo:
                for p, prev in reversed(undo):
                    bindings[p] = prev
            if not stack:
                root_done = True
        else:
            stack.append((qname, undo))
            if len(stack) > MAX_DEPTH:
                raise _malformed()
        i = m.end()
        on_tag(False, self_closing, name, prefix != "", ns, default_ns, attrs if attrs is not None else _NO_ATTRS)
    if not root_seen or stack:
        raise _malformed()  # no root, or an unclosed element


def spreadsheet_guard(root: str) -> Callable[[bool, str, bool, str, str | None], bool]:
    """The SpreadsheetML rules of one part (P26/P27), run on every tag; returns whether the tag is a SpreadsheetML
    element to look at (other namespaces — `x14:`, `xm:`, `mc:` … — are ignored): the root is `root`, unprefixed,
    declaring the Transitional main namespace as its default; no element declares another default namespace; no element
    of the main (or Strict) namespace carries a prefix."""
    first = [True]

    def guard(end: bool, name: str, prefixed: bool, ns: str, default_ns: str | None) -> bool:
        if not end and first[0]:
            first[0] = False
            if name != root or prefixed or default_ns != SPREADSHEETML:
                raise _malformed()
            return True
        if not end and default_ns is not None and default_ns != SPREADSHEETML:
            raise _malformed()
        if ns == SPREADSHEETML or ns == STRICT_SPREADSHEETML:
            if prefixed:
                raise _malformed()
            return True
        return False

    return guard


def _resolve_target(target: str) -> str | None:
    """A relationship target of `xl/workbook.xml` per OPC (absolute, or relative to `xl/` with `.`/`..`)."""
    absolute = target.startswith("/")
    parts: list[str] = [] if absolute else ["xl"]
    for seg in (target[1:] if absolute else target).split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(seg)
    return "/".join(parts) if parts else None


def first_sheet_path(workbook: str, rels: str) -> str | None:
    """The archive path of the first sheet (P27): the first `<sheet>` of the workbook whatever its type, its target
    resolved per OPC; a relationship that is missing, external or not a worksheet → None (415 `{allowed}`)."""
    found: list[str | None] = []
    guard = spreadsheet_guard("workbook")

    def on_wb(end, sc, name, prefixed, ns, dns, attrs):
        if not guard(end, name, prefixed, ns, dns) or end or name != "sheet" or found:
            return
        found.append(attrs.get("{" + R_NS + "}id"))

    scan_xml(workbook, lambda name: name == "sheet", on_wb)
    rid = found[0] if found else None
    if not rid:
        return None
    target: list[str | None] = [None]

    def on_rels(end, sc, name, prefixed, ns, dns, attrs):
        if end or name != "Relationship" or ns != PKG_NS or attrs.get("Id") != rid:
            return
        if attrs.get("Type") != WORKSHEET_TYPE or attrs.get("TargetMode") == "External":
            return
        target[0] = _resolve_target(attrs.get("Target", ""))

    scan_xml(rels, lambda name: name == "Relationship", on_rels)
    return target[0]


def _row_number(s: str) -> int | None:
    """A row reference: a positive integer without sign, leading zero or fraction, ≤ 1 048 576; else None."""
    if not s or len(s) > 7 or not s.isascii() or not s.isdigit() or s[0] == "0":
        return None
    n = int(s)
    return n if n <= MAX_ROW_NUMBER else None


def _cell_ref(s: str) -> tuple[int, int] | None:
    """A cell reference: 1–3 upper-case letters, then its row number; no `$`, no space; (column, row) or None."""
    col = 0
    k = 0
    while k < len(s) and k < 4 and "A" <= s[k] <= "Z":
        col = col * 26 + (ord(s[k]) - 64)
        k += 1
    if k == 0 or k > 3:
        return None
    row = _row_number(s[k:])
    return None if row is None else (col, row)


# ── JavaScript number parsing (exceljs: parseFloat / parseInt of the cell text) ───────────────────────────────────

_JS_WS = "\t\n\x0b\x0c\r                " \
         "  　﻿"
_FLOAT_PREFIX = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
_INT_PREFIX = re.compile(r"[+-]?[0-9]+")


def js_parse_float(s: str) -> float:
    m = _FLOAT_PREFIX.match(s.lstrip(_JS_WS))
    if m is None:
        return float("nan")
    t = m.group(0)
    if t.endswith("Infinity"):
        return float("-inf") if t.startswith("-") else float("inf")
    return float(t)


def js_parse_int(s: str) -> int | None:
    m = _INT_PREFIX.match(s.lstrip(_JS_WS))
    return int(m.group(0)) if m else None


# ── styles (exceljs StylesXform: cellXfs numFmtId → format code; isDateFmt) ─────────────────────────────────────

_DEFAULT_FORMATS = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?",
    13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM",
    20: "h:mm", 21: "h:mm:ss", 22: 'm/d/yy "h":mm', 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)",
    39: "#,##0.00 ;(#,##0.00)", 40: "#,##0.00 ;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0",
    48: "##0.0E+0", 49: "@",
}
_BRACKETS = re.compile(r"\[[^\]]*\]")
_QUOTED = re.compile(r'"[^"]*"')
_DATE_CHARS = re.compile(r"[ymdhMsb]")
_ESCAPED = re.compile(r"\\(.)", re.S)


def is_date_format(fmt: str | None) -> bool:
    """exceljs utils.isDateFmt: after removing `[…]` and `"…"`, any of `ymdhMsb`."""
    if not fmt:
        return False
    return _DATE_CHARS.search(_QUOTED.sub("", _BRACKETS.sub("", fmt))) is not None


def parse_styles(data: bytes | None) -> list[str | None]:
    """The number format of every cell style (`cellXfs` index → format code or None). Not well-formed → _Stop."""
    if data is None:
        return []
    custom: dict[int, str] = {}
    xfs: list[int | None] = []
    where: list[str] = []

    def start(name, attrs):
        where.append(name)
        if name == "numFmt" and "numFmts" in where[:-1]:
            if "formatCode" not in attrs:
                raise _Stop("unsupported")  # exceljs fails reading such a style sheet
            fid = js_parse_int(attrs.get("numFmtId", ""))
            if fid is not None:
                custom[fid] = _ESCAPED.sub(r"\1", attrs["formatCode"])
        elif name == "xf" and len(where) >= 2 and where[-2] == "cellXfs":
            xfs.append(js_parse_int(attrs.get("numFmtId", "")))

    p = xml.parsers.expat.ParserCreate()
    p.StartElementHandler = start
    p.EndElementHandler = lambda name: where.pop()
    try:
        p.Parse(data, True)
    except xml.parsers.expat.ExpatError:
        raise _Stop("unsupported") from None
    out: list[str | None] = []
    for fid in xfs:
        out.append((custom.get(fid) or _DEFAULT_FORMATS.get(fid)) if fid else None)
    return out


def _well_formed(data: bytes) -> bool:
    """XML 1.0 well-formedness of a part (expat — what saxes checks for exceljs; the scanner checked the rest)."""
    p = xml.parsers.expat.ParserCreate()
    try:
        p.Parse(data, True)
    except xml.parsers.expat.ExpatError:
        return False
    return True


# ── shared strings and the sheet: pre-scan + values in one pass ───────────────────────────────────────────────────

def scan_shared_strings(text: str) -> list[str]:
    """The texts of `<si>` items (runs concatenated, `<rPh>` left out), limits P24 checked."""
    guard = spreadsheet_guard("sst")
    strings: list[str] = []
    counts = [0, 0]  # si, r
    depth = {"t": 0, "rPh": 0}
    state = {"buf": None}

    def on_tag(end, sc, name, prefixed, ns, dns, attrs):
        if not guard(end, name, prefixed, ns, dns):
            return
        if not end:
            if name == "si":
                counts[0] += 1
                if counts[0] > MAX_STRINGS:
                    raise ScanError("tooLarge")
                state["buf"] = []
            elif name == "r":
                counts[1] += 1
                if counts[1] > MAX_RUNS:
                    raise ScanError("tooLarge")
            elif name == "t" and not sc:
                depth["t"] += 1
            elif name == "rPh" and not sc:
                depth["rPh"] += 1
            if sc and name == "si":
                strings.append("")
                state["buf"] = None
            return
        if name == "t":
            depth["t"] -= 1
        elif name == "rPh":
            depth["rPh"] -= 1
        elif name == "si":
            b = state["buf"]
            strings.append("".join(b) if b else "")
            state["buf"] = None

    def on_text(raw, cdata):
        b = state["buf"]
        if b is not None and depth["t"] > 0 and depth["rPh"] == 0:
            b.append(raw if cdata else _text_value(raw))

    scan_xml(text, lambda name: False, on_tag, on_text)
    return strings


class _SheetReader:
    """The first sheet: the P24–P27 pre-scan and the cell values in one pass (see the module docstring)."""

    def __init__(self, strings: list[str], styles: list[str | None]):
        self.strings = strings
        self.styles = styles
        self.guard = spreadsheet_guard("worksheet")
        self.rows_seen = 0
        self.cells_in_row = 0
        self.in_row = False
        self.last_row = 0
        self.last_col = 0
        # values
        self.in_sheet_data = False
        self.row: int | None = None
        self.row_fmt: str | None = None
        self.values: dict[int, Cell] = {}
        self.cell: list | None = None  # [col, t, fmt, has_f, v_parts | None, is_parts | None]
        self.capture: list[str] | None = None
        self.t_depth = 0
        self.rph_depth = 0
        self.header: list[Cell] | None = None
        self.first = True
        self.data_rows: list[tuple[int, list[Cell]]] = []
        self.data_count = 0
        self.too_many = False
        self.result_bytes = 0

    def _fmt(self, s: str | None) -> tuple[bool, str | None]:
        """(the style exists, its number format) of a style index attribute (exceljs getStyleModel)."""
        if s is None:
            return False, None
        k = js_parse_int(s)
        if k is None or k < 0 or k >= len(self.styles):
            return False, None
        return True, self.styles[k]

    def on_tag(self, end, sc, name, prefixed, ns, dns, attrs):
        if not self.guard(end, name, prefixed, ns, dns):
            return
        if name == "row":
            if end:
                self.in_row = False
                self._end_row()
                return
            r = _row_number(attrs.get("r", ""))
            if r is None or r <= self.last_row:
                raise _malformed()
            self.rows_seen += 1
            if self.rows_seen > MAX_ROWS:
                raise ScanError("tooLarge")
            self.last_row = r
            self.last_col = 0
            self.cells_in_row = 0
            self.in_row = not sc
            if self.in_sheet_data:
                self.row = r
                exists, fmt = self._fmt(attrs.get("s"))
                self.row_fmt = fmt if exists else None
                self.values = {}
                if sc:
                    self._end_row()
            return
        if name == "c":
            if end:
                self._end_cell()
                return
            ref = _cell_ref(attrs.get("r", ""))
            if not self.in_row or ref is None or ref[1] != self.last_row or ref[0] <= self.last_col:
                raise _malformed()
            self.last_col = ref[0]
            self.cells_in_row += 1
            if self.cells_in_row > MAX_CELLS_PER_ROW or ref[0] > MAX_CELLS_PER_ROW:
                raise ScanError("tooLarge")
            if self.row is not None:
                s = attrs.get("s")
                k = js_parse_int(s) if s is not None else None
                if k:  # exceljs: a falsy style index keeps the row's style
                    exists, fmt = self._fmt(s)
                    fmt = fmt if exists else self.row_fmt
                else:
                    fmt = self.row_fmt
                self.cell = [ref[0], attrs.get("t"), fmt, False, None, None]
                if sc:
                    self._end_cell()
            return
        if name == "sheetData":
            self.in_sheet_data = not end and not sc
            return
        cell = self.cell
        if cell is None:
            return
        if name == "v":
            if end:
                self.capture = None
            else:
                cell[4] = []
                self.capture = None if sc else cell[4]
        elif name == "f":
            if not end:
                cell[3] = True
        elif name == "is":
            if end:
                self.capture = None
            else:
                cell[5] = []
                self.t_depth = self.rph_depth = 0
                self.capture = None
        elif name == "t" and cell[5] is not None:
            if end:
                self.t_depth -= 1
            elif not sc:
                self.t_depth += 1
            self.capture = cell[5] if self.t_depth > 0 and self.rph_depth == 0 else None
        elif name == "rPh" and cell[5] is not None:
            if end:
                self.rph_depth -= 1
            elif not sc:
                self.rph_depth += 1
            self.capture = cell[5] if self.t_depth > 0 and self.rph_depth == 0 else None

    def on_text(self, raw, cdata):
        if self.capture is not None:
            self.capture.append(raw if cdata else _text_value(raw))

    def _end_cell(self):
        cell = self.cell
        if cell is None:
            return
        self.cell = None
        self.capture = None
        col, t, fmt, has_f, v_parts, is_parts = cell
        v = "".join(v_parts) if v_parts is not None else None
        inline = "".join(is_parts) if is_parts is not None else None
        value: Cell | None
        if has_f:
            if v is None:
                value = ""
            elif t == "str":
                value = v
            elif t in ("b", "e"):
                value = INVALID
            else:
                value = self._number(v)
        elif t == "s":
            k = js_parse_int(v) if v is not None else None
            value = self.strings[k] if k is not None and 0 <= k < len(self.strings) else None
        elif t in ("inlineStr", "str"):
            value = inline if inline is not None else v
        elif t in ("b", "e"):
            value = INVALID if (v is not None or inline is not None) else None
        elif t == "d":
            value = INVALID if (v is not None or inline is not None) else None
        else:
            text = v if v is not None else inline
            if text is None:
                value = None
            elif is_date_format(fmt):
                value = INVALID
            else:
                value = self._number(text)
        if value is not None and value != "":
            self.values[col] = value

    @staticmethod
    def _number(text: str) -> Cell:
        x = js_parse_float(text)
        if x != x or x in (float("inf"), float("-inf")):
            return INVALID
        return plain_number_text(x)

    def _bounded(self, cells: list[Cell]) -> list[Cell]:
        out: list[Cell] = []
        for c in cells:
            if isinstance(c, str):
                if len(c) > MAX_CELL_CHARS:
                    out.append(TOO_LONG)
                    continue
                self.result_bytes += len(c) if c.isascii() else len(c.encode("utf-8", "surrogatepass"))
            out.append(c)
        return out

    def _end_row(self):
        if self.row is None:
            return
        number, values = self.row, self.values
        self.row = None
        self.values = {}
        cells: list[Cell] = [""] * (max(values) if values else 0)
        for col, v in values.items():
            cells[col - 1] = v
        if self.first:
            self.first = False
            if number == 1:
                self.header = self._bounded(cells)
                return
        if number == 1 or not cells:
            return
        self.data_count += 1
        if self.data_count > MAX_DATA_ROWS:
            self.too_many = True
            return
        if self.result_bytes > MAX_RESULT_BYTES:
            return  # already too large: keep nothing, keep counting rows
        self.data_rows.append((number, self._bounded(cells)))


def _utf8(b: bytes) -> str:
    try:
        text = b.decode("utf-8")
    except UnicodeDecodeError:
        raise _Stop("unsupported") from None
    return text[1:] if text.startswith("﻿") else text


def _scan_error(e: ScanError) -> _Stop:
    return _Stop("tooLarge" if e.kind == "tooLarge" else "unsupported")


def _read(data: bytes) -> tuple[list[Cell] | None, list[tuple[int, list[Cell]]]]:
    try:
        parts = unzip(data, ZIP_LIMITS)
    except ZipError as e:
        raise _Stop("tooLarge" if e.kind == "too_large" else "unsupported") from None
    for name, body in parts.items():
        if PART_CAPS.get(name, len(body)) < len(body):
            raise _Stop("tooLarge")
    workbook = parts.get("xl/workbook.xml")
    rels = parts.get("xl/_rels/workbook.xml.rels")
    if "[Content_Types].xml" not in parts or workbook is None or rels is None:
        raise _Stop("unsupported")
    try:
        path = first_sheet_path(_utf8(workbook), _utf8(rels))
    except ScanError as e:
        raise _scan_error(e) from None
    sheet = parts.get(path) if path else None
    if sheet is None:
        raise _Stop("unsupported")
    # Styles and shared strings are read before the sheet (its values need them); their failures are reported in the
    # contract's order — after the sheet's own violations.
    styles_failed = False
    try:
        styles = parse_styles(parts.get("xl/styles.xml"))
    except _Stop:
        styles, styles_failed = [], True
    sst = parts.get("xl/sharedStrings.xml")
    sst_error: _Stop | None = None
    strings: list[str] = []
    if sst is not None:
        try:
            strings = scan_shared_strings(_utf8(sst))
        except ScanError as e:
            sst_error = _scan_error(e)
        except _Stop as e:
            sst_error = e
    reader = _SheetReader(strings, styles)
    try:
        scan_xml(_utf8(sheet), lambda name: name in ("c", "row"), reader.on_tag, reader.on_text)
    except ScanError as e:
        raise _scan_error(e) from None
    if sst_error is not None:
        raise sst_error
    # (4) reading: every part read is well-formed XML 1.0.
    if styles_failed or not all(_well_formed(p) for p in (workbook, rels, sst, sheet) if p is not None):
        raise _Stop("unsupported")
    if reader.too_many:
        raise _Stop("tooManyRows")
    if reader.result_bytes > MAX_RESULT_BYTES:
        raise _Stop("tooLarge")
    return reader.header, reader.data_rows


def read_workbook(data: bytes) -> tuple:
    """Stages 2–4 (the Lane's child job; never raises): ('ok', header, rows) or (kind,) — 'tooLarge', 'unsupported',
    'tooManyRows'."""
    try:
        header, rows = _read(data)
        return ("ok", header, rows)
    except _Stop as e:
        return (e.kind,)
    except MemoryError:
        return ("tooLarge",)
    except Exception:  # noqa: BLE001 - anything else is a workbook that cannot be read
        return ("unsupported",)


# ── the request-thread side ───────────────────────────────────────────────────────────────────────────────────────

XLSX_DEADLINE_S = 10.0
XLSX_QUEUE_WAITING = 8
XLSX_SMALL_LANE_BYTES = 64 * 1024
XLSX_MEMORY_MB = 256
_lanes: dict[str, Any] = {}


def is_zip(data: bytes) -> bool:
    return data[:4] == b"PK\x03\x04"


def lane(kind: str):
    from agrotrace.infra.lanes import Lane

    found = _lanes.get(kind)
    if found is None:
        found = _lanes.setdefault(kind, Lane(f"xlsx-{kind}", max_waiting=XLSX_QUEUE_WAITING, deadline_s=XLSX_DEADLINE_S,
                                             memory_mb=XLSX_MEMORY_MB))
    return found


def unsupported(reason: str | None = None):
    from agrotrace.core.problem import AppProblem

    params: dict[str, Any] = {"allowed": list(IMPORT_TYPES)}
    if reason:
        params["reason"] = reason
    return AppProblem(415, "UNSUPPORTED_MEDIA_TYPE", params=params)


def too_large():
    return unsupported("workbook-too-large")


def check_directory(data: bytes) -> None:
    """Stage 1 on the request thread: the ZIP directory (declared sizes) and the part caps; nothing is inflated."""
    try:
        entries = directory(data, ZIP_LIMITS)
    except ZipError as e:
        raise (too_large() if e.kind == "too_large" else unsupported()) from None
    names = {e.name for e in entries}
    if "[Content_Types].xml" not in names or "xl/workbook.xml" not in names:
        raise unsupported()
    for e in entries:
        if PART_CAPS.get(e.name, e.size) < e.size:
            raise too_large()


def read_first_sheet(data: bytes, cancelled: Callable[[], bool] | None = None, *, lane_override=None) -> Sheet:
    """The import's reading of an XLSX file (stages 1–4): the header and the data rows of the first sheet. Raises the
    415s (`reason: workbook-too-large` for the limits, a full lane, the deadline, a child killed at its memory limit)
    and 400 tooManyRows."""
    from agrotrace.core.context import client_gone
    from agrotrace.core.problem import validation_problem

    check_directory(data)
    ln = lane_override or lane("small" if len(data) <= XLSX_SMALL_LANE_BYTES else "large")
    out = ln.run(read_workbook, data, cancelled=cancelled or client_gone)
    if not out.ok:
        # too-complex (busy, timeout, a crashed child) → too large; aborted → nobody reads the answer.
        raise too_large() if out.reason == "too-complex" else unsupported()
    result = out.value
    kind = result[0]
    if kind == "tooLarge":
        raise too_large()
    if kind == "tooManyRows":
        raise validation_problem({"file": ["validation.import.tooManyRows"]})
    if kind != "ok":
        raise unsupported()
    return Sheet(header=result[1], rows=result[2], pad_short=True)
