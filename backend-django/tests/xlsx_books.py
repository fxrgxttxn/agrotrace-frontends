"""Hand-made workbooks for the XLSX tests (the builders of backend-express/test/xlsx-limits.test.ts)."""

from __future__ import annotations

import struct
import zlib

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
MiB = 1024 * 1024
WB = f'<workbook xmlns="{NS}" xmlns:r="{R_NS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'
RELS = (f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{R_NS}/worksheet" '
        'Target="worksheets/sheet1.xml"/></Relationships>')
HDR = '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>'


def zip_of(parts: list[dict]) -> bytes:
    """parts: {name, data (str|bytes), declared (deflate and declare this size), bad_crc}."""
    locals_, centrals = [], []
    offset = 0
    for p in parts:
        name = p["name"].encode()
        data = p["data"].encode() if isinstance(p["data"], str) else p["data"]
        deflate = p.get("declared") is not None
        if deflate:
            co = zlib.compressobj(6, zlib.DEFLATED, -15)
            body = co.compress(data) + co.flush()
        else:
            body = data
        size = p["declared"] if deflate else len(data)
        crc = (zlib.crc32(data) ^ (1 if p.get("bad_crc") else 0)) & 0xFFFFFFFF
        method = 8 if deflate else 0
        local = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, method, 0, 0, crc, len(body), size, len(name), 0)
        central = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, method, 0, 0, crc, len(body), size,
                              len(name), 0, 0, 0, 0, 0, offset)
        locals_ += [local, name, body]
        centrals += [central, name]
        offset += 30 + len(name) + len(body)
    cd = b"".join(centrals)
    end = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(parts), len(parts), len(cd), offset, 0)
    return b"".join(locals_) + cd + end


def book(rows: str | None = None, *, wb: str | None = None, rels: str | None = None, sst: str | None = None,
         styles: str | None = None, sheet: str | bytes | None = None, sheet_name: str = "xl/worksheets/sheet1.xml",
         extra: list[dict] | None = None, bad_sheet_crc: bool = False) -> bytes:
    parts = [
        {"name": "[Content_Types].xml",
         "data": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'},
        {"name": "xl/workbook.xml", "data": wb if wb is not None else WB},
        {"name": "xl/_rels/workbook.xml.rels", "data": rels if rels is not None else RELS},
    ]
    if styles is not None:
        parts.append({"name": "xl/styles.xml", "data": styles})
    if sst is not None:
        parts.append({"name": "xl/sharedStrings.xml", "data": sst})
    if sheet is None:
        sheet = f'<worksheet xmlns="{NS}"><sheetData>{rows if rows is not None else HDR}</sheetData></worksheet>'
    parts.append({"name": sheet_name, "data": sheet, "bad_crc": bad_sheet_crc})
    return zip_of(parts + (extra or []))


def column(n: int) -> str:
    s = ""
    while n > 0:
        s = chr(65 + (n - 1) % 26) + s
        n = (n - 1) // 26
    return s


def inline_row(r: int, values: list[str]) -> str:
    cells = "".join(f'<c r="{column(k + 1)}{r}" t="inlineStr"><is><t>{v}</t></is></c>' for k, v in enumerate(values))
    return f'<row r="{r}">{cells}</row>'
