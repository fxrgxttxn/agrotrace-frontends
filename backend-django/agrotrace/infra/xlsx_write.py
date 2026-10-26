"""
Report workbooks (downloadReport, contract `Файл` rules), the port of backend-express/src/infra/xlsx.ts (exceljs):
one worksheet per sheet in order, named as given; row 1 — the column headers in bold; data from row 2. Cell types:
text — a string cell; int — a number with format `0`; mass — a number with format `0.000`; dec2 — a number with
format `0.00`; None — no cell at all. Column widths as Express: min(60, max(8, longest + 2)) over the header and the
first 200 rows (lengths in UTF-16 code units, as JS `String.length`).

Written directly as SpreadsheetML (a few fixed parts plus one XML per sheet, streamed into the zip): no workbook
model in memory, so a 50 000-row sheet stays fast and small in the report Lane's child. Strings are inline
(`t="inlineStr"`) — the same string cells a reader sees as exceljs's shared strings. A number is written as JS prints
it (`Number("12.300")` → `12.3`), the value exceljs stores. Runs in the Lane's child: standard library only.
"""

from __future__ import annotations

import io
import re
import zipfile
from collections.abc import Iterable, Sequence
from decimal import Decimal
from typing import Any

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"

#: Style index (cellXfs) of each cell kind: 1 — the bold header; numbers by their format.
STYLE = {"header": 1, "int": 2, "dec2": 3, "mass": 4}
FORMATS = {"int": "0", "mass": "0.000", "dec2": "0.00"}
WIDTH_ROWS = 200
#: exceljs writes no `<col>` for a column of its default width 9 (`Column.isCustomWidth`).
DEFAULT_WIDTH = 9
#: XML 1.0 forbids these characters; SpreadsheetML escapes them as `_xHHHH_` (and a literal `_xHHHH_` as `_x005F_…`).
_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|_(?=x[0-9A-Fa-f]{4}_)|[\ud800-\udfff]")


def _esc(s: str) -> str:
    s = _ILLEGAL.sub(lambda m: "_x005F_" if m.group() == "_" else f"_x{ord(m.group()):04X}_", s)
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _col(i: int) -> str:
    """Column letters of the 0-based index `i` (0 → A, 26 → AA)."""
    out = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        out = chr(65 + r) + out
    return out


def js_number(v: Any) -> str:
    """The number as JS `String(Number(v))` prints it, for the counts and the decimal strings of the reports (at most
    15 significant digits, so the shortest round trip is the decimal itself)."""
    if isinstance(v, int) and not isinstance(v, bool):
        return str(v)
    d = Decimal(str(v)).normalize()
    s = format(d, "f")
    return "0" if s in ("-0", "") else s


def _js_len(s: str) -> int:
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def _text_cell(ref: str, text: str, style: int | None = None) -> str:
    s = f' s="{style}"' if style else ""
    space = ' xml:space="preserve"' if text != text.strip() or "\n" in text else ""
    return f'<c r="{ref}"{s} t="inlineStr"><is><t{space}>{_esc(text)}</t></is></c>'


def _widths(header: Sequence[str], rows: Sequence[Sequence[tuple[str, Any]]]) -> list[int]:
    out = []
    for i, h in enumerate(header):
        longest = max([_js_len(h), *(_js_len("" if r[i][1] is None else str(r[i][1]))
                                     for r in rows[:WIDTH_ROWS] if i < len(r))])
        out.append(min(60, max(8, longest + 2)))
    return out


def _sheet_xml(header: Sequence[str], rows: Sequence[Sequence[tuple[str, Any]]]) -> Iterable[str]:
    last = f"{_col(len(header) - 1)}{len(rows) + 1}" if header else "A1"
    yield (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="{NS}" xmlns:r="{R_NS}">'
           f'<dimension ref="A1:{last}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
           '<sheetFormatPr defaultRowHeight="15"/>')
    cols = [f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
            for i, w in enumerate(_widths(header, rows)) if w != DEFAULT_WIDTH]
    if cols:
        yield "<cols>" + "".join(cols) + "</cols>"
    yield "<sheetData>"
    cols = [_col(i) for i in range(len(header))]
    yield '<row r="1">' + "".join(_text_cell(f"{cols[i]}1", h, STYLE["header"]) for i, h in enumerate(header)) + \
        "</row>"
    for n, row in enumerate(rows, start=2):
        cells = []
        for i, (t, v) in enumerate(row):
            if v is None:
                continue
            ref = f"{cols[i]}{n}"
            if t == "text":
                cells.append(_text_cell(ref, v))
            else:
                cells.append(f'<c r="{ref}" s="{STYLE[t]}"><v>{js_number(v)}</v></c>')
        yield f'<row r="{n}">' + "".join(cells) + "</row>"
    yield "</sheetData></worksheet>"


def _styles() -> str:
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="{NS}">'
            '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts>'
            '<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/>'
            '<scheme val="minor"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/>'
            '<family val="2"/><scheme val="minor"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill>'
            '<fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
            '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
            '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
            '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            '<dxfs count="0"/><tableStyles count="0"/></styleSheet>')


def write_xlsx(sheets: Sequence[Any], created_at_iso: str) -> bytes:
    """`sheets`: objects with `name`, `header` and `rows` (rows of `(type, value)` cells); `created_at_iso` — the
    snapshot instant (`…T…Z`), the workbook's created/modified."""
    w3c = created_at_iso[:19] + "Z"
    stamp = (int(w3c[:4]), int(w3c[5:7]), int(w3c[8:10]), int(w3c[11:13]), int(w3c[14:16]), int(w3c[17:19]))
    if stamp[0] < 1980:  # the zip format's epoch (the warm-up job renders at 1970)
        stamp = (1980, 1, 1, 0, 0, 0)
    n = len(sheets)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        def put(name: str, data: str | Iterable[str]) -> None:
            info = zipfile.ZipInfo(name, stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            with z.open(info, "w") as f:
                for chunk in [data] if isinstance(data, str) else data:
                    f.write(chunk.encode("utf-8", "surrogatepass"))

        put("[Content_Types].xml",
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="{CT_NS}">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" '
                      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                      for i in range(n))
            + '<Override PartName="/xl/styles.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '<Override PartName="/docProps/core.xml" '
            'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
            '<Override PartName="/docProps/app.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>')
        put("_rels/.rels",
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{PKG_NS}">'
            f'<Relationship Id="rId1" Type="{R_NS}/officeDocument" Target="xl/workbook.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/'
            'core-properties" Target="docProps/core.xml"/>'
            f'<Relationship Id="rId3" Type="{R_NS}/extended-properties" Target="docProps/app.xml"/>'
            '</Relationships>')
        put("docProps/app.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties '
            'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
            "<Application>AgroTrace</Application></Properties>")
        put("docProps/core.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties '
            'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            "<dc:creator>AgroTrace</dc:creator><cp:lastModifiedBy>AgroTrace</cp:lastModifiedBy>"
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{w3c}</dcterms:created>'
            f'<dcterms:modified xsi:type="dcterms:W3CDTF">{w3c}</dcterms:modified></cp:coreProperties>')
        put("xl/workbook.xml",
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="{NS}" xmlns:r="{R_NS}">'
            '<bookViews><workbookView/></bookViews><sheets>'
            + "".join(f'<sheet name="{_esc(s.name)}" sheetId="{i + 1}" r:id="rId{i + 1}"/>'
                      for i, s in enumerate(sheets))
            + "</sheets></workbook>")
        put("xl/_rels/workbook.xml.rels",
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{PKG_NS}">'
            + "".join(f'<Relationship Id="rId{i + 1}" Type="{R_NS}/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
                      for i in range(n))
            + f'<Relationship Id="rId{n + 1}" Type="{R_NS}/styles" Target="styles.xml"/></Relationships>')
        put("xl/styles.xml", _styles())
        for i, s in enumerate(sheets):
            put(f"xl/worksheets/sheet{i + 1}.xml", _sheet_xml(s.header, s.rows))
    return buf.getvalue()
