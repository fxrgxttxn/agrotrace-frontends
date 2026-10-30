"""
Generated PDF documents, laid out like backend-express/src/infra/pdf.ts, in the design-system font Onest (the @fontsource
WOFF files of the image, `assets/fonts/onest`; latin and cyrillic subsets):

- the A6 QR label of a batch (createBatchQr, R43; Ruling Q1 — the contract's A6 label, not the spec's A4 3 × 8
  sheet): the QR, the public code, the product name and the origin organization — WeasyPrint (the two subsets are two
  faces of one family, Pango picks the face that has the glyph); runs in the QR Lane's child (infra/qr.py);
- the report tables of downloadReport (`report_pdf`, below) — written directly, line by line as pdfkit does there;
  runs in the report Lane's child (modules/reports/render.py).

No Django here.
"""

from __future__ import annotations

import base64
import html
from functools import cache
from pathlib import Path

INK = "#33291F"
TAGLINE = "Сканируйте, чтобы узнать происхождение партии"


@cache
def _font_faces() -> str:
    from agrotrace.core.config import ROOT

    files = Path(ROOT) / "assets" / "fonts" / "onest"
    faces = []
    for weight in (400, 600):
        for subset in ("latin", "cyrillic"):
            path = files / f"onest-{subset}-{weight}-normal.woff"
            faces.append(f"@font-face {{ font-family: 'Onest {subset}'; font-weight: {weight}; "
                         f"src: url('{path.as_uri()}') format('woff'); }}")
    return "\n".join(faces)


def _label_html(public_code: str, product_name: str, origin_name: str, png: bytes) -> str:
    qr = base64.b64encode(png).decode("ascii")
    e = html.escape
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>QR {e(public_code)}</title>
<meta name="author" content="AgroTrace"><meta name="generator" content="AgroTrace django">
<style>
{_font_faces()}
@page {{ size: A6 portrait; margin: 0; }}
html, body {{ margin: 0; padding: 0; }}
body {{ font-family: 'Onest latin', 'Onest cyrillic'; color: {INK}; text-align: center; }}
.qr {{ display: block; width: 220pt; height: 220pt; margin: 24pt auto 8pt; }}
.box {{ margin: 0 28pt; }}
.code {{ font-size: 16pt; font-weight: 600; line-height: 1.35; letter-spacing: 0.5pt; }}
.product {{ font-size: 12pt; font-weight: 600; line-height: 1.35; margin-top: 4pt; }}
.origin {{ font-size: 9pt; line-height: 1.35; margin-top: 2pt; }}
.tagline {{ font-size: 8pt; line-height: 1.35; margin-top: 8pt; }}
</style></head>
<body><img class="qr" src="data:image/png;base64,{qr}" alt="">
<div class="box"><div class="code">{e(public_code)}</div><div class="product">{e(product_name)}</div>
<div class="origin">{e(origin_name)}</div><div class="tagline">{TAGLINE}</div></div></body></html>"""


def qr_label_pdf(*, public_code: str, product_name: str, origin_name: str, png: bytes, created_at_iso: str) -> bytes:
    """One A6 page (105 × 148 mm): QR, public code, product, origin organization."""
    import logging

    from weasyprint import HTML

    logging.getLogger("weasyprint").setLevel(logging.ERROR)
    logging.getLogger("fontTools").setLevel(logging.ERROR)
    doc = HTML(string=_label_html(public_code, product_name, origin_name, png)).render()
    doc.metadata.created = created_at_iso
    doc.metadata.modified = created_at_iso
    return doc.write_pdf()


# ── report tables (downloadReport) ──────────────────────────────────────────────────────────────────────────────────
#
# The report PDF is laid out by hand, line by line, as backend-express/src/infra/pdf.ts does with pdfkit: WeasyPrint
# lays out a 2 000-row table in ~16 s and 750 MB, so the contract's 50 000 rows (REPORT_MAX_ROWS) could never fit the
# report Lane's 120 s and 1 GiB. Here the page content is written directly (PDF 1.4: one Type0/CIDFontType2 font per
# face, Identity-H, glyph ids kept by the subset, a ToUnicode CMap so the text can be extracted and searched).
# Faces: Onest 400 and 600, the latin and cyrillic subsets of @fontsource as two faces each (`*-lat`, `*-cyr`): every
# line is split into runs exactly as pdf.ts `splitRuns` does (a space keeps the face of the run before it), widths are
# the glyph advances plus the font's pair kerning (GPOS `kern`, as fontkit applies it) within one run.

A4_LANDSCAPE = (841.89, 595.28)
MARGIN = 28
TABLE_SIZE = 7
LINE = 1.35
RULE = "0.7216 0.6824 0.6235"  # #B8AE9F
INK_RGB = "0.2 0.1608 0.1216"  # #33291F
_FACES = {"regular": 400, "bold": 600}


def _is_cyr(c: str) -> bool:
    return "Ѐ" <= c <= "ӿ" or c == "№"


def split_runs(text: str) -> list[tuple[bool, str]]:
    """pdf.ts `splitRuns`: runs of (cyrillic?, text); a space continues the run before it."""
    parts: list[list] = []
    for c in text:
        last = parts[-1] if parts else None
        cyr = last[0] if (c == " " and last) else _is_cyr(c)
        if last and last[0] == cyr:
            last[1] += c
        else:
            parts.append([cyr, c])
    return [(p[0], p[1]) for p in parts]


class _Face:
    """Metrics of one font file (read once per process)."""

    def __init__(self, path: Path):
        from fontTools.ttLib import TTFont

        self.path = path
        f = TTFont(str(path))
        self.upm = f["head"].unitsPerEm
        order = {name: i for i, name in enumerate(f.getGlyphOrder())}
        hmtx = f["hmtx"].metrics
        self.adv_by_gid = {order[name]: hmtx[name][0] for name in order}
        self.gid = {cp: order[name] for cp, name in f.getBestCmap().items()}
        self.ascent = f["hhea"].ascent
        self.descent = f["hhea"].descent
        self.cap_height = getattr(f["OS/2"], "sCapHeight", self.ascent)
        head = f["head"]
        self.bbox = (head.xMin, head.yMin, head.xMax, head.yMax)
        self.ps_name = f["name"].getDebugName(6) or "Onest"
        self._lookups: list[list[tuple]] = []
        self._kern_cache: dict[tuple[int, int], int] = {}
        if "GPOS" in f:
            gpos = f["GPOS"].table
            wanted = [i for fr in gpos.FeatureList.FeatureRecord if fr.FeatureTag == "kern"
                      for i in fr.Feature.LookupListIndex]
            for i in dict.fromkeys(wanted):
                lookup = gpos.LookupList.Lookup[i]
                if lookup.LookupType == 2:
                    self._lookups.append([self._pair_table(st, order) for st in lookup.SubTable])
        f.close()

    @staticmethod
    def _pair_table(st, order: dict[str, int]) -> tuple:
        cov = {order[g]: k for k, g in enumerate(st.Coverage.glyphs)}
        if st.Format == 1:
            sets = [{order[r.SecondGlyph]: (getattr(r.Value1, "XAdvance", 0) or 0) if r.Value1 is not None else 0
                     for r in ps.PairValueRecord} for ps in st.PairSet]
            return (1, cov, sets)
        c1 = {order[g]: c for g, c in st.ClassDef1.classDefs.items()}
        c2 = {order[g]: c for g, c in st.ClassDef2.classDefs.items()}
        matrix = [[(getattr(r.Value1, "XAdvance", 0) or 0) if r.Value1 is not None else 0 for r in rec.Class2Record]
                  for rec in st.Class1Record]
        return (2, cov, (c1, c2, matrix))

    def kern(self, a: int, b: int) -> int:
        """The pair adjustment of glyphs a, b (font units): each kern lookup in order, its first matching subtable."""
        key = (a, b)
        hit = self._kern_cache.get(key)
        if hit is not None:
            return hit
        total = 0
        for subtables in self._lookups:
            for fmt, cov, data in subtables:
                k = cov.get(a)
                if k is None:
                    continue
                if fmt == 1:
                    v = data[k].get(b)
                    if v is None:
                        continue
                    total += v
                    break
                c1, c2, matrix = data
                i, j = c1.get(a, 0), c2.get(b, 0)
                if i < len(matrix) and j < len(matrix[i]):
                    total += matrix[i][j]
                break
        self._kern_cache[key] = total
        return total

    def glyphs(self, s: str) -> list[int]:
        return [self.gid.get(ord(c), 0) for c in s]

    def units(self, s: str) -> int:
        """Width of `s` in font units: advances plus pair kerning."""
        gs = self.glyphs(s)
        w = sum(self.adv_by_gid.get(g, 0) for g in gs)
        for a, b in zip(gs, gs[1:], strict=False):
            w += self.kern(a, b)
        return w


@cache
def _faces() -> dict[str, _Face]:
    from agrotrace.core.config import ROOT

    files = Path(ROOT) / "assets" / "fonts" / "onest"
    return {f"{weight}-{subset[:3]}": _Face(files / f"onest-{subset}-{w}-normal.woff")
            for weight, w in _FACES.items() for subset in ("latin", "cyrillic")}


def _num(v: float) -> str:
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _utf16(c: str) -> list[int]:
    b = c.encode("utf-16-be", "surrogatepass")
    return [int.from_bytes(b[i:i + 2], "big") for i in range(0, len(b), 2)]


def _pdf_text(s: str) -> str:
    """A PDF text string: UTF-16BE with a BOM, as hex."""
    return "<FEFF" + "".join(f"{u:04X}" for c in s for u in _utf16(c)) + ">"


class _Writer:
    """Pages of drawing operators and the fonts they use; `finish()` assembles the file."""

    def __init__(self, size: tuple[float, float]):
        self.w, self.h = size
        self.faces = _faces()
        self.used: dict[str, dict[int, str]] = {k: {} for k in self.faces}  # face → gid → text (ToUnicode)
        self.pages: list[bytes] = []
        self.ops: list[str] = []
        self._widths: dict[tuple[str, str, float], float] = {}

    def width(self, text: str, weight: str, size: float) -> float:
        key = (text, weight, size)
        hit = self._widths.get(key)
        if hit is not None:
            return hit
        total = 0.0
        for cyr, s in split_runs(text):
            face = self.faces[f"{weight}-{'cyr' if cyr else 'lat'}"]
            total += face.units(s) * size / face.upm
        if len(self._widths) > 200_000:
            self._widths.clear()
        self._widths[key] = total
        return total

    def text(self, text: str, weight: str, size: float, x: float, y: float) -> None:
        """Draws one line with its top at `y` (pdfkit's text origin: the baseline is `ascender` below)."""
        for cyr, s in split_runs(text):
            key = f"{weight}-{'cyr' if cyr else 'lat'}"
            face = self.faces[key]
            gs = face.glyphs(s)
            used = self.used[key]
            parts: list[str] = []
            run: list[str] = []
            for i, (g, c) in enumerate(zip(gs, s, strict=True)):
                if g:  # a character the face lacks is .notdef (gid 0), which maps to U+0000 (_font)
                    used.setdefault(g, c)
                k = face.kern(gs[i - 1], g) if i else 0
                if k:
                    parts.append(f"<{''.join(run)}>")
                    parts.append(_num(-k * 1000 / face.upm))
                    run = []
                run.append(f"{g:04X}")
            parts.append(f"<{''.join(run)}>")
            base = self.h - y - face.ascent * size / face.upm
            self.ops.append(f"BT /{key.replace('-', '_')} {_num(size)} Tf 1 0 0 1 {_num(x)} {_num(base)} Tm "
                            f"[{' '.join(parts)}] TJ ET")
            x += face.units(s) * size / face.upm

    def rule(self, x1: float, x2: float, y: float) -> None:
        yy = _num(self.h - y)
        self.ops.append(f"{RULE} RG 0.3 w {_num(x1)} {yy} m {_num(x2)} {yy} l S")

    def new_page(self) -> None:
        import zlib

        body = "\n".join(self.ops)
        self.pages.append(zlib.compress(f"q {INK_RGB} rg\n{body}\nQ".encode("latin-1")))
        self.ops = []

    def _font(self, add, stream, key: str, used: dict[int, str]) -> int:
        """Embeds the subset of face `key` with the glyphs `used`: the Type0 font object."""
        import hashlib
        import io as _io
        import zlib

        from fontTools import subset
        from fontTools.ttLib import TTFont

        face = self.faces[key]
        gids = sorted({0, *used})
        font = TTFont(str(face.path))
        font.flavor = None
        opts = subset.Options()
        opts.retain_gids = True
        opts.notdef_outline = True
        opts.layout_features = []
        opts.name_IDs = []
        opts.drop_tables += ["GPOS", "GSUB", "GDEF", "STAT"]
        sub = subset.Subsetter(opts)
        sub.populate(gids=gids)
        sub.subset(font)
        buf = _io.BytesIO()
        font.save(buf)
        font.close()
        ttf = buf.getvalue()
        digest = hashlib.sha1(f"{key}{gids}".encode(), usedforsecurity=False).digest()
        name = "".join(chr(65 + b % 26) for b in digest[:6]) + "+" + face.ps_name
        scale = 1000 / face.upm
        file_ref = stream(zlib.compress(ttf), f" /Length1 {len(ttf)}")
        bbox = " ".join(_num(v * scale) for v in face.bbox)
        desc = add(f"<< /Type /FontDescriptor /FontName /{name} /Flags 32 /FontBBox [{bbox}] /ItalicAngle 0 "
                   f"/Ascent {_num(face.ascent * scale)} /Descent {_num(face.descent * scale)} "
                   f"/CapHeight {_num(face.cap_height * scale)} /StemV 80 /FontFile2 {file_ref} 0 R >>")
        widths = " ".join(f"{g} [{_num(face.adv_by_gid.get(g, 0) * scale)}]" for g in gids)
        cid = add(f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{name} /CIDSystemInfo << /Registry (Adobe) "
                  f"/Ordering (Identity) /Supplement 0 >> /FontDescriptor {desc} 0 R /W [{widths}] "
                  "/CIDToGIDMap /Identity >>")
        # pdfkit (EmbeddedFont: `unicode = [[0]]`): .notdef, the glyph of every character the face lacks, maps to
        # U+0000 — never to the first missing character it happened to draw.
        mapped = {**used, 0: "\x00"}
        entries = [f"<{g:04X}> <{''.join(f'{u:04X}' for u in _utf16(c))}>" for g, c in sorted(mapped.items())]
        cmap = ["/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) "
                "/Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def "
                "1 begincodespacerange <0000> <FFFF> endcodespacerange"]
        for i in range(0, len(entries), 100):
            chunk = entries[i:i + 100]
            cmap.append(f"{len(chunk)} beginbfchar\n" + "\n".join(chunk) + "\nendbfchar")
        cmap.append("endcmap CMapName currentdict /CMap defineresource pop end end")
        to_unicode = stream(zlib.compress("\n".join(cmap).encode("latin-1")))
        return add(f"<< /Type /Font /Subtype /Type0 /BaseFont /{name} /Encoding /Identity-H "
                   f"/DescendantFonts [{cid} 0 R] /ToUnicode {to_unicode} 0 R >>")

    def finish(self, info: dict[str, str], created_at_iso: str) -> bytes:
        import hashlib

        self.new_page()
        objs: list[bytes] = [b""]  # object numbers are 1-based

        def add(body: bytes | str) -> int:
            objs.append(body.encode("latin-1") if isinstance(body, str) else body)
            return len(objs) - 1

        def stream(data: bytes, extra: str = "") -> int:
            return add(f"<< /Length {len(data)} /Filter /FlateDecode{extra} >>\nstream\n".encode() + data
                       + b"\nendstream")

        fonts = {key: self._font(add, stream, key, used) for key, used in self.used.items() if used}
        resources = add("<< /Font << " + " ".join(f"/{k.replace('-', '_')} {v} 0 R" for k, v in fonts.items())
                        + " >> /ProcSet [/PDF /Text] >>")
        pages_ref = add(b"null")
        kids = []
        for content in self.pages:
            c = stream(content)
            kids.append(add(f"<< /Type /Page /Parent {pages_ref} 0 R /MediaBox [0 0 {_num(self.w)} {_num(self.h)}] "
                            f"/Resources {resources} 0 R /Contents {c} 0 R >>"))
        objs[pages_ref] = (f"<< /Type /Pages /Count {len(kids)} /Kids [{' '.join(f'{k} 0 R' for k in kids)}] >>"
                           ).encode()
        catalog = add(f"<< /Type /Catalog /Pages {pages_ref} 0 R >>")
        d = created_at_iso
        stamp = f"D:{d[:4]}{d[5:7]}{d[8:10]}{d[11:13]}{d[14:16]}{d[17:19]}Z"
        info_ref = add("<< " + " ".join(f"/{k} {_pdf_text(v)}" for k, v in info.items())
                       + f" /CreationDate ({stamp}) /ModDate ({stamp}) >>")
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for n, body in enumerate(objs[1:], start=1):
            offsets.append(len(out))
            out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {len(objs)}\n0000000000 65535 f \n".encode()
        out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
        fid = hashlib.md5(bytes(out[:4096]) + d.encode(), usedforsecurity=False).hexdigest()
        out += (f"trailer\n<< /Size {len(objs)} /Root {catalog} 0 R /Info {info_ref} 0 R /ID [<{fid}> <{fid}>] >>\n"
                f"startxref\n{xref}\n%%EOF\n").encode()
        return bytes(out)


def _paragraph(doc: _Writer, text: str, weight: str, size: float, x: float, y: float, width: float) -> float:
    """pdf.ts `paragraph` (left aligned): words wrapped on spaces; returns the y below the last line."""
    lines: list[str] = []
    line = ""
    for word in text.split(" "):
        nxt = f"{line} {word}" if line else word
        if line and doc.width(nxt, weight, size) > width:
            lines.append(line)
            line = word
        else:
            line = nxt
    if line:
        lines.append(line)
    for ln in lines:
        doc.text(ln, weight, size, x, y)
        y += size * LINE
    return y


def wrap(doc: _Writer, text: str, weight: str, size: float, width: float) -> list[str]:
    """pdf.ts `wrap`: lines of `text` within `width` — wrapped on spaces, a word wider than the column is broken
    between characters, a newline starts a new line."""
    if "\n" not in text and not text.startswith(" ") and doc.width(text, weight, size) <= width:
        return [text]  # the common case: what the loop below gives for it
    lines: list[str] = []
    line = ""
    for paragraph_text in text.split("\n"):
        for word in paragraph_text.split(" "):
            nxt = f"{line} {word}" if line else word
            if doc.width(nxt, weight, size) <= width:
                line = nxt
                continue
            if line:
                lines.append(line)
            chunk = ""
            for ch in word:
                if chunk and doc.width(chunk + ch, weight, size) > width:
                    lines.append(chunk)
                    chunk = ""
                chunk += ch
            line = chunk
        lines.append(line)
        line = ""
    return lines or [""]


def report_pdf(*, title: str, period_line: str, generated_line: str, generated_at_iso: str,
               sheets: list[tuple[str, list[str], list[list[str]]]]) -> bytes:
    """Report PDF (contract `Файл`), pdf.ts `reportPdf`: A4 landscape, Onest (Cyrillic), the heading
    `AgroTrace — <title>`, the period and generation lines, then a section per sheet (subheading = sheet name) with
    the same table; the header row repeats on every new page. `sheets`: (name, header, rows of cell texts)."""
    heading = f"AgroTrace — {title}"
    doc = _Writer(A4_LANDSCAPE)
    left = MARGIN
    width = doc.w - 2 * left
    bottom = doc.h - MARGIN
    size = TABLE_SIZE
    lh = size * LINE
    y = _paragraph(doc, heading, "bold", 14, left, MARGIN, width)
    y = _paragraph(doc, period_line, "regular", 9, left, y + 2, width)
    y = _paragraph(doc, generated_line, "regular", 9, left, y, width)

    for name, header, rows in sheets:
        y += 10
        if y > bottom - 60:
            doc.new_page()
            y = MARGIN
        y = _paragraph(doc, name, "bold", 11, left, y, width)
        col_w = width / len(header)

        def row(cells: list[str], weight: str, header=header, col_w=col_w) -> None:
            nonlocal y
            wrapped = [wrap(doc, t, weight, size, col_w - 4) for t in cells]
            h = max(len(ls) for ls in wrapped) * lh + 3
            if y + h > bottom:
                doc.new_page()
                y = MARGIN
                if weight != "bold":
                    row(header, "bold")
            for i, ls in enumerate(wrapped):
                for k, ln in enumerate(ls):
                    if ln:
                        doc.text(ln, weight, size, left + i * col_w, y + k * lh)
            y += h
            doc.rule(left, left + width, y - 1.5)

        row(header, "bold")
        for cells in rows:
            row(cells, "regular")
    return doc.finish({"Title": heading, "Author": "AgroTrace", "Creator": "AgroTrace",
                       "Producer": "AgroTrace django"}, generated_at_iso)
