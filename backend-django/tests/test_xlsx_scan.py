"""infra.xlsx_scan — the XLSX limits and structure of importDictionary (P23–P28), the cases of
backend-express/test/xlsx-limits.test.ts: the outcome of `read_workbook` (the Lane's job) and of `read_first_sheet`
(the 415/400 problems, through a Lane)."""

import time

import pytest

from agrotrace.core.problem import AppProblem
from agrotrace.infra import xlsx_scan
from agrotrace.infra.lanes import Lane
from agrotrace.infra.xlsx_scan import TOO_LONG, ScanError, read_first_sheet, read_workbook, scan_xml
from agrotrace.infra.zip import stored_zip
from tests.xlsx_books import HDR, NS, R_NS, RELS, WB, MiB, book, column, zip_of

OK, TOO_LARGE, REFUSED, TOO_MANY = "ok", "tooLarge", "unsupported", "tooManyRows"
ALLOWED = ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]


def outcome(data: bytes) -> str:
    return read_workbook(data)[0]


def cells(r: int, n: int, attrs: str = "") -> str:
    return "".join(f'<c r="{column(i + 1)}{r}"{attrs}><v>1</v></c>' for i in range(n))


def c(ref: str) -> str:
    return f'<c r="{ref}"><v>1</v></c>'


def nop(*_a) -> None:
    return None


# ── (1) the ZIP directory and (2) the inflate checks ────────────────────────────────────────────────────────────

def test_64_entries_accepted_65_refused():
    pad = [{"name": f"x/{i}.xml", "data": "<x/>"} for i in range(61)]
    assert outcome(book(extra=pad[:60])) == OK  # 4 + 60
    assert outcome(book(extra=pad)) == TOO_LARGE


def test_declared_sizes_per_entry_and_in_all():
    assert outcome(book(extra=[{"name": "x/big.bin", "data": b"\0" * (16 * MiB + 1)}])) == TOO_LARGE
    eleven = b"\0" * (11 * MiB)
    assert outcome(book(extra=[{"name": f"x/{n}.bin", "data": eleven} for n in "abc"])) == TOO_LARGE


def test_part_caps():
    assert outcome(book(wb=f"{WB}<!--{'x' * MiB}-->")) == TOO_LARGE
    assert outcome(book(styles=f'<styleSheet xmlns="{NS}"/>{" " * MiB}')) == TOO_LARGE


def test_a_bomb_is_found_in_bounded_time_even_in_an_entry_nobody_reads():
    started = time.monotonic()
    assert outcome(book(extra=[{"name": "x/bomb.bin", "data": b"\0" * (64 * MiB), "declared": 10}])) == TOO_LARGE
    wanted = zip_of([
        {"name": "[Content_Types].xml", "data": "<Types/>"},
        {"name": "xl/workbook.xml", "data": WB},
        {"name": "xl/_rels/workbook.xml.rels", "data": RELS},
        {"name": "xl/sharedStrings.xml", "data": b" " * (64 * MiB), "declared": 1000},
        {"name": "xl/worksheets/sheet1.xml", "data": f'<worksheet xmlns="{NS}"><sheetData>{HDR}</sheetData></worksheet>'},
    ])
    assert outcome(wanted) == TOO_LARGE
    assert time.monotonic() - started < 10


def test_crc_and_short_entries_are_refused():
    assert outcome(book(bad_sheet_crc=True)) == REFUSED
    short = zip_of([
        {"name": "[Content_Types].xml", "data": "<Types/>"},
        {"name": "xl/workbook.xml", "data": WB},
        {"name": "xl/_rels/workbook.xml.rels", "data": RELS},
        {"name": "xl/worksheets/sheet1.xml",
         "data": f'<worksheet xmlns="{NS}"><sheetData>{HDR}</sheetData></worksheet>', "declared": 5000},
    ])
    assert outcome(short) == REFUSED


def test_a_zip_that_is_not_a_workbook():
    not_book = stored_zip([("word/document.xml", b"<w/>"), ("[Content_Types].xml", b"<T/>")])
    assert outcome(not_book) == REFUSED
    with pytest.raises(AppProblem) as e:
        xlsx_scan.check_directory(not_book)
    assert e.value.status == 415 and e.value.params == {"allowed": ALLOWED}


# ── (3) the pre-scan ────────────────────────────────────────────────────────────────────────────────────────────

def test_20000_rows_read_one_more_too_large():
    def empty(n: int) -> str:
        return "".join(f'<row r="{i + 2}"/>' for i in range(n))

    assert outcome(book(HDR + empty(19_999))) == OK
    assert outcome(book(HDR + empty(20_000))) == TOO_LARGE


def test_64_cells_read_65_or_a_cell_beyond_bl_too_large():
    assert outcome(book(f'<row r="1">{cells(1, 64)}</row>')) == OK
    assert outcome(book(f'<row r="1">{cells(1, 65)}</row>')) == TOO_LARGE
    styled = '<row r="1"><c r="A1"><v>1</v></c>' + "".join(f'<c r="{column(i + 2)}1" s="1"/>' for i in range(64))
    assert outcome(book(styled + "</row>")) == TOO_LARGE
    assert outcome(book('<row r="1"><c r="BM1"><v>1</v></c></row>')) == TOO_LARGE
    assert outcome(book('<row r="1"><c r="BL1"><v>1</v></c></row>')) == OK


def test_more_than_200000_shared_strings_or_runs():
    def si(n: int) -> str:
        return f'<sst xmlns="{NS}">' + "<si><t>x</t></si>" * n + "</sst>"

    assert outcome(book(sst=si(200_000))) == OK
    assert outcome(book(sst=si(200_001))) == TOO_LARGE
    assert outcome(book(sst=f'<sst xmlns="{NS}"><si>' + "<r><t>x</t></r>" * 200_001 + "</si></sst>")) == TOO_LARGE


def test_the_scanner_is_linear():
    started = time.monotonic()
    with pytest.raises(ScanError):
        scan_xml("<sheets>" + "<sheet" * 64_000, lambda n: True, nop)
    assert outcome(book(f'<row r="1">{"<c/>" * 4_000_000}</row>')) == REFUSED
    assert time.monotonic() - started < 3


@pytest.mark.parametrize("rows", [
    '<row r="0"><c r="A0"><v>1</v></c></row>',
    '<row r="99999999999"><c r="A99999999999"><v>1</v></c></row>',
    '<row r="2.5"><c r="A2"><v>1</v></c></row>',
    '<row r="3abc"><c r="A3"><v>1</v></c></row>',
    '<row r="+2"><c r="A2"><v>1</v></c></row>',
    '<row r="02"><c r="A2"><v>1</v></c></row>',
    f'{HDR}<row r="2">{c("A2")}</row><row r="2">{c("A2")}</row>',
    f'{HDR}<row r="3">{c("A3")}</row><row r="2">{c("A2")}</row>',
    f'{HDR}<row r="2">{c("A2")}</row>{HDR}',
    f'{HDR}<row r="2">{c("A7")}</row>',
    f'{HDR}<row r="2">{c("A")}</row>',
    f'{HDR}<row r="2">{c("B2")}{c("A2")}</row>',
    f'{HDR}<row r="2">{c("A2")}{c("A2")}</row>',
    f'{HDR}<row r="2">{c("a2")}</row>',
    f'{HDR}<row r="2">{c("$A$2")}</row>',
    '<row><c r="A1"><v>1</v></c></row>',
    '<row r="1"><c><v>1</v></c></row>',
    f'{HDR}<c r="A2"><v>1</v></c>',
])
def test_the_r_rules(rows):
    assert outcome(book(rows)) == REFUSED


def test_on_one_element_a_malformed_reference_beats_a_limit():
    assert outcome(book(f'{HDR}<row r="2">{c("$BM2")}</row>')) == REFUSED
    assert outcome(book(f'{HDR}<row r="2">{c("BM2")}</row>')) == TOO_LARGE


def test_a_prefixed_spreadsheetml_row_is_refused_other_namespaces_are_ignored():
    prefixed = book(sheet=f'<x:worksheet xmlns:x="{NS}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c>'
                          '</x:row></x:sheetData></x:worksheet>')
    assert outcome(prefixed) == REFUSED
    inner = book(sheet=f'<worksheet xmlns="{NS}" xmlns:x="{NS}"><sheetData>{HDR}<x:row r="2"/></sheetData>'
                       '</worksheet>')
    assert outcome(inner) == REFUSED
    x14 = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
    xm = "http://schemas.microsoft.com/office/excel/2006/main"
    ext = (f'<extLst><ext uri="{{CCE6A557}}" xmlns:x14="{x14}"><x14:dataValidations count="1" xmlns:xm="{xm}">'
           '<x14:dataValidation type="list"><x14:formula1><xm:f>Lists!$A$1:$A$2</xm:f></x14:formula1>'
           '<xm:sqref>B2:B100</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>')
    assert outcome(book(sheet=f'<worksheet xmlns="{NS}"><sheetData>{HDR}</sheetData>{ext}</worksheet>')) == OK
    assert outcome(book(sheet=f'<worksheet xmlns="{NS}" xmlns:x="{NS}"><sheetData>{HDR}</sheetData></worksheet>')) == OK


def test_namespaces():
    assert outcome(book(sheet=f"<worksheet><sheetData>{HDR}</sheetData></worksheet>")) == REFUSED
    strict = "http://purl.oclc.org/ooxml/spreadsheetml/main"
    assert outcome(book(sheet=f'<worksheet xmlns="{strict}"><sheetData>{HDR}</sheetData></worksheet>')) == REFUSED
    evil = f'<worksheet xmlns="{NS}"><sheetData><row r="1" xmlns="urn:evil">{c("A1")}</row></sheetData></worksheet>'
    assert outcome(book(sheet=evil)) == REFUSED
    assert outcome(book(wb=WB.replace(f' xmlns="{NS}"', ""))) == REFUSED
    assert outcome(book(sst="<sst><si><t>x</t></si></sst>")) == REFUSED


def test_utf16_and_other_encodings_are_refused():
    text = f'<worksheet xmlns="{NS}"><sheetData>{HDR}</sheetData></worksheet>'
    assert outcome(book(sheet=b"\xff\xfe" + text.encode("utf-16-le"))) == REFUSED
    assert outcome(book(sheet=text.encode("utf-16-le"))) == REFUSED
    assert outcome(book(sheet=f'<?xml version="1.0" encoding="UTF-16"?>{text}')) == REFUSED
    assert outcome(book(sheet=f'<?xml version="1.0" encoding="UTF8"?>{text}')) == REFUSED
    assert outcome(book(sheet=f'\ufeff<?xml version="1.0" encoding="utf-8"?>{text}')) == OK


def test_the_first_sheet_per_opc():
    def rel(kind: str, target: str) -> str:
        return (f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                f'<Relationship Id="rId1" Type="{R_NS}/{kind}" Target="{target}"/></Relationships>')

    assert outcome(book(rels=rel("worksheet", "/xl/worksheets/sheet1.xml"))) == OK
    assert outcome(book(rels=rel("worksheet", "../xl/worksheets/sheet1.xml"))) == OK
    assert outcome(book(rels=rel("worksheet", "data/first.xml"), sheet_name="xl/data/first.xml")) == OK
    assert outcome(book(rels=rel("chartsheet", "worksheets/sheet1.xml"))) == REFUSED  # a chart sheet first
    assert outcome(book(rels=rel("worksheet", "../../outside.xml"))) == REFUSED
    external = rel("worksheet", "http://x/s.xml").replace("/>", ' TargetMode="External"/>')
    assert outcome(book(rels=external)) == REFUSED


@pytest.mark.parametrize("xml", [
    f'<worksheet xmlns="{NS}"><sheetData>{HDR}</sheetData><foo:bar/></worksheet>',
    f'<worksheet xmlns="{NS}"><sheetData><row r="1" foo:x="1">{c("A1")}</row></sheetData></worksheet>',
    f'<worksheet xmlns="{NS}"><sheetData><row r="1">{c("A1")}</rowX></sheetData></worksheet>',
    f'<worksheet xmlns="{NS}"><sheetData>{HDR}</sheetData>',
    f'<worksheet xmlns="{NS}"><sheetData>{HDR}</sheetData></worksheet><extra/>',
    f'<worksheet xmlns="{NS}"><sheetData><row r="1" r="1">{c("A1")}</row></sheetData></worksheet>',
    f'<worksheet xmlns="{NS}"><sheetData><row r="1" spans="1<2">{c("A1")}</row></sheetData></worksheet>',
    f'<worksheet xmlns="{NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a&#0;</t></is></c></row>'
    '</sheetData></worksheet>',
    f'<worksheet xmlns="{NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a&foo;</t></is></c></row>'
    '</sheetData></worksheet>',
    f'<worksheet xmlns="{NS}"><sheetData>{HDR}</sheetData>' + '<a:x xmlns:a="urn:a">' * 300 + "</a:x>" * 300
    + "</worksheet>",
    f'<!DOCTYPE worksheet><worksheet xmlns="{NS}"><sheetData>{HDR}</sheetData></worksheet>',
    f'<worksheet xmlns="{NS}"><sheetData>{HDR}<:row r="3"><c r="A3"><v>1</v></c></:row></sheetData></worksheet>',
    # Accepted by the scanner, not XML 1.0 (no white space between attributes): the reading stage (expat).
    f'<worksheet xmlns="{NS}"><sheetData><row r="1"><c r="A1"t="n"><v>0</v></c></row></sheetData></worksheet>',
])
def test_not_well_formed(xml):
    assert outcome(book(sheet=xml)) == REFUSED


@pytest.mark.parametrize(("label", "xml"), [
    ("text before the root", 'junk<r:root xmlns:r="urn:r"></r:root>'),
    ("text after the root", '<r:root xmlns:r="urn:r"></r:root>junk'),
    ("CDATA after the root", '<r:root xmlns:r="urn:r"></r:root><![CDATA[x]]>'),
    ("a raw control character", '<r:root xmlns:r="urn:r">\u0001</r:root>'),
    ("U+FFFF", '<r:root xmlns:r="urn:r">\uffff</r:root>'),
    ("-- inside a comment", '<r:root xmlns:r="urn:r"><!-- a -- b --></r:root>'),
    ("a comment ending in --->", '<r:root xmlns:r="urn:r"><!-- a ---></r:root>'),
    ("one expanded attribute twice",
     '<r:root xmlns:r="urn:r"><p:a xmlns:p="urn:q" xmlns:q="urn:q" p:v="1" q:v="2"/></r:root>'),
    ("xml bound elsewhere", '<r:root xmlns:r="urn:r"><r:a xmlns:xml="urn:bad"/></r:root>'),
    ("another prefix bound to the xml namespace",
     '<r:root xmlns:r="urn:r"><r:a xmlns:x="http://www.w3.org/XML/1998/namespace"/></r:root>'),
    ("xmlns as an element prefix", '<r:root xmlns:r="urn:r"><xmlns:a/></r:root>'),
    ("an empty prefix", '<r:root xmlns:r="urn:r"><:row r="3"/></r:root>'),
    ("an empty local part", '<r:root xmlns:r="urn:r"><r:/></r:root>'),
    ("two colons", '<r:root xmlns:r="urn:r"><r:a:b/></r:root>'),
    ("an attribute with an empty prefix", '<r:root xmlns:r="urn:r"><r:a :v="1"/></r:root>'),
    ("the encoding label UTF8", '<?xml version="1.0" encoding="UTF8"?><r:root xmlns:r="urn:r"></r:root>'),
])
def test_scan_xml_refusals(label, xml):
    with pytest.raises(ScanError):
        scan_xml(xml, lambda n: False, nop)


def test_scan_xml_still_accepts():
    scan_xml('<?xml version="1.0" encoding="utf-8"?>\n<r:root xmlns:r="urn:r">&#x0000000041;&#00065;</r:root>\n',
             lambda n: False, nop)
    scan_xml('<r:root xmlns:r="urn:r"><r:a xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:space="preserve"/>'
             "</r:root>", lambda n: False, nop)


def test_many_declaring_elements_stay_linear():
    decl = "".join(f' xmlns:p{k}="u:{k}"' for k in range(20_000))
    kids = '<q:e xmlns:q="u"/>' * 700_000
    started = time.monotonic()
    scan_xml(f'<r:root xmlns:r="urn:r"{decl}>{kids}</r:root>', lambda n: False, nop)
    assert time.monotonic() - started < 4.5  # Express: 1.5 s x TIMING_SLACK 3


# ── order of the stages ──────────────────────────────────────────────────────────────────────────────────────────

def test_order_of_the_checks():
    pad = [{"name": f"x/{i}.xml", "data": "<x/>"} for i in range(61)]
    assert outcome(book(extra=pad, bad_sheet_crc=True)) == TOO_LARGE  # the directory beats a bad CRC
    wide = f'<row r="1">{cells(1, 65)}</row>'
    bad = book(wide, extra=[{"name": "x/a.xml", "data": "<a/>", "bad_crc": True}])
    assert outcome(bad) == REFUSED  # a bad CRC anywhere beats a pre-scan violation
    sst_too_many = f'<sst xmlns="{NS}">' + "<si><t>x</t></si>" * 200_001 + "</sst>"
    assert outcome(book('<row r="1"><c><v>1</v></c></row>', sst=sst_too_many)) == REFUSED  # the sheet first
    assert outcome(book(wide, sst=f'<x:sst xmlns:x="{NS}"><x:si><x:t>a</x:t></x:si></x:sst>')) == TOO_LARGE
    many = "".join(f'<row r="{i + 2}"><c r="A{i + 2}"><v>1</v></c></row>' for i in range(10_001))
    assert outcome(book(many)) == TOO_MANY  # tooManyRows while reading, before the header (wrong here too)


def test_too_many_rows_comes_before_the_8_mib_total():
    long = f'<sst xmlns="{NS}"><si><t>{"x" * 900}</t></si></sst>'
    rows = "".join(f'<row r="{i + 2}"><c r="A{i + 2}" t="s"><v>0</v></c></row>' for i in range(10_001))
    assert outcome(book(HDR + rows, sst=long)) == TOO_MANY
    fewer = "".join(f'<row r="{i + 2}"><c r="A{i + 2}" t="s"><v>0</v></c></row>' for i in range(10_000))
    assert outcome(book(HDR + fewer, sst=long)) == TOO_LARGE  # 8.6 MiB of result text


def test_a_cell_over_1000_characters_never_leaves_the_child():
    result = read_workbook(book(f'{HDR}<row r="2"><c r="A2" t="inlineStr"><is><t>{"x" * 1001}</t></is></c>'
                                f'<c r="B2" t="inlineStr"><is><t>{"y" * 1000}</t></is></c></row>'))
    assert result[0] == OK
    assert result[2] == [(2, [TOO_LONG, "y" * 1000])]
    rows = "".join(f'<row r="{i + 2}"><c r="A{i + 2}" t="s"><v>0</v></c></row>' for i in range(9000))
    one = read_workbook(book(HDR + rows, sst=f'<sst xmlns="{NS}"><si><t>{"x" * MiB}</t></si></sst>'))
    assert one[0] == OK and len(one[2]) == 9000 and all(row == [TOO_LONG] for _, row in one[2])


# ── through the Lane: problems, the deadline ────────────────────────────────────────────────────────────────────

def _problem(data: bytes, **kw) -> tuple[int, dict]:
    try:
        read_first_sheet(data, cancelled=lambda: False, **kw)
    except AppProblem as p:
        return p.status, p.params or p.errors
    return 200, {}


def test_problems_through_the_lane():
    sheet = read_first_sheet(book(HDR + '<row r="2"><c r="A2"><v>7</v></c></row>'), cancelled=lambda: False)
    assert sheet.header == ["1", "2"] and sheet.rows == [(2, ["7"])] and sheet.pad_short
    assert _problem(book(f'<row r="1">{cells(1, 65)}</row>')) == (415, {"allowed": ALLOWED,
                                                                         "reason": "workbook-too-large"})
    assert _problem(book('<row r="1"><c><v>1</v></c></row>')) == (415, {"allowed": ALLOWED})
    many = "".join(f'<row r="{i + 2}"><c r="A{i + 2}"><v>1</v></c></row>' for i in range(10_001))
    assert _problem(book(many)) == (400, {"file": ["validation.import.tooManyRows"]})


def test_a_job_past_its_deadline_is_too_large_and_the_next_one_runs():
    lane = Lane("xlsx-test", max_waiting=8, deadline_s=0.3, memory_mb=256)
    assert _problem(book(), lane_override=lane)[0] == 200  # warm: the start-up is not charged to a job
    rows = HDR + "".join(f'<row r="{r}">{cells(r, 64)}</row>' for r in range(2, 6000))
    started = time.monotonic()
    assert _problem(book(rows), lane_override=lane) == (415, {"allowed": ALLOWED, "reason": "workbook-too-large"})
    assert time.monotonic() - started < 3
    assert _problem(book(), lane_override=lane)[0] == 200


def test_a_large_legitimate_workbook_reads_in_bounded_time():
    rows = '<row r="1"><c r="A1"><v>1</v></c></row>' + "".join(
        f'<row r="{r}">{cells(r, 64)}</row>' for r in range(2, 5001))
    started = time.monotonic()
    result = read_workbook(book(rows))
    assert result[0] == OK and len(result[2]) == 4999 and len(result[2][0][1]) == 64
    assert time.monotonic() - started < 15


def test_large_legitimate_workbooks_fit_the_lane_memory():
    """Through the real lanes (256 MB address space per child): 5 000 × 64 cells, and 3 000 Cyrillic rows in shared
    strings (> 64 KiB) read back exactly."""
    rows = '<row r="1"><c r="A1"><v>1</v></c></row>' + "".join(
        f'<row r="{r}">{cells(r, 64)}</row>' for r in range(2, 5001))
    sheet = read_first_sheet(book(rows), cancelled=lambda: False)
    assert len(sheet.rows) == 4999 and len(sheet.rows[0][1]) == 64
    expected = [[f"К-{i}", f"Ёжиковая область №{i} — «Щёлково» {'ЖЩЫ' * (i % 7)}"] for i in range(3000)]
    strings = [v for row in expected for v in row]
    sst = f'<sst xmlns="{NS}">' + "".join(f"<si><t>{s}</t></si>" for s in strings) + "</sst>"
    body = "".join(f'<row r="{i + 2}"><c r="A{i + 2}" t="s"><v>{2 * i}</v></c><c r="B{i + 2}" t="s"><v>{2 * i + 1}</v>'
                   "</c></row>" for i in range(3000))
    head = '<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>'
    got = read_first_sheet(book(head + body, sst=sst), cancelled=lambda: False)
    assert got.header == ["code", "name"] and [r[1] for r in got.rows] == expected
