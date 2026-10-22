"""infra.xlsx_scan cell values (exceljs semantics, the cases of backend-express xlsx-*.test.ts and tests/api
dictionaries.test.ts; decision 6 of Express Tasks 4–5): strings as is, numbers as their shortest decimal text, other
types Invalid (`validation.pattern` in any column), trailing empty cells dropped, gaps by `r` empty."""

from agrotrace.infra.xlsx_scan import INVALID, TOO_LONG, is_date_format, read_workbook
from tests.xlsx_books import NS, book

STYLES = (f'<styleSheet xmlns="{NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy"/>'
          '</numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/>'
          '<xf numFmtId="2"/></cellXfs></styleSheet>')


def rows_of(rows: str, **kw):
    result = read_workbook(book('<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>' + rows, **kw))
    assert result[0] == "ok", result
    return result[2]


def one(cell: str, **kw):
    """The cells of row 2 holding `cell` (column A)."""
    got = rows_of(f'<row r="2">{cell}</row>', **kw)
    return got[0][1] if got else []


def test_shared_and_inline_strings_are_their_text():
    sst = f'<sst xmlns="{NS}"><si><t>Пшеница</t></si><si><t xml:space="preserve"> a b </t></si></sst>'
    assert one('<c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c>', sst=sst) == ["Пшеница", " a b "]
    assert one('<c r="A2" t="inlineStr"><is><t>Ячмень</t></is></c>') == ["Ячмень"]
    assert one('<c r="A2" t="str"><v>text</v></c>') == ["text"]


def test_rich_text_is_its_runs_concatenated_without_phonetic_runs():
    sst = (f'<sst xmlns="{NS}"><si><r><rPr><b/></rPr><t>Мор</t></r><r><t>ковь</t></r>'
           '<rPh sb="0" eb="1"><t>ignored</t></rPh></si></sst>')
    assert one('<c r="A2" t="s"><v>0</v></c>', sst=sst) == ["Морковь"]
    assert one('<c r="A2" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r></is></c>') == ["ab"]


def test_text_is_decoded_and_line_ends_normalized():
    assert one('<c r="A2" t="inlineStr"><is><t>a&amp;b &#x41;&lt;</t></is></c>') == ["a&b A<"]
    assert one('<c r="A2" t="inlineStr"><is><t>x\r\ny\rz</t></is></c>') == ["x\ny\nz"]
    assert one('<c r="A2" t="inlineStr"><is><t><![CDATA[<raw>]]></t></is></c>') == ["<raw>"]


def test_numbers_are_their_shortest_decimal_text():
    assert one('<c r="A2" t="n"><v>5</v></c><c r="B2"><v>1.50</v></c><c r="C2"><v>0.1</v></c>'
               '<c r="D2"><v>1E-7</v></c><c r="E2"><v>3650</v></c>') == ["5", "1.5", "0.1", "0.0000001", "3650"]
    assert one('<c r="A2"><v>abc</v></c>') == [INVALID]  # NaN


def test_a_formula_is_its_cached_result_and_empty_without_one():
    assert one('<c r="A2"><f>1+1</f><v>2</v></c>') == ["2"]
    assert one('<c r="A2"><f>1-1</f><v>0</v></c>') == ["0"]
    assert one('<c r="A2" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>') == ["ab"]
    assert one('<c r="A2"><f>A1</f></c><c r="B2"><v>1</v></c>') == ["", "1"]
    assert one('<c r="A2" t="e"><f>1/0</f><v>#DIV/0!</v></c>') == [INVALID]
    assert one('<c r="A2" t="b"><f>TRUE()</f><v>1</v></c>') == [INVALID]


def test_booleans_errors_dates_and_date_formatted_numbers_are_invalid():
    assert one('<c r="A2" t="b"><v>1</v></c>') == [INVALID]
    assert one('<c r="A2" t="e"><v>#N/A</v></c>') == [INVALID]
    assert one('<c r="A2" t="d"><v>2026-01-02T00:00:00Z</v></c>') == [INVALID]
    # numFmtId 14 (built-in mm-dd-yy) and a custom dd.mm.yyyy (exceljs writes Dates so).
    assert one('<c r="A2" s="1"><v>46024</v></c><c r="B2" s="2"><v>46024</v></c><c r="C2" s="3"><v>2.5</v></c>',
               styles=STYLES) == [INVALID, INVALID, "2.5"]
    # A cell without its own style takes the row's; s="0" is no style of its own.
    assert one_row('<row r="2" s="1"><c r="A2"><v>46024</v></c><c r="B2" s="0"><v>1</v></c>'
                   '<c r="C2" s="3"><v>3</v></c></row>', styles=STYLES) == [INVALID, INVALID, "3"]


def one_row(row: str, **kw):
    got = rows_of(row, **kw)
    return got[0][1]


def test_is_date_format():
    assert is_date_format("dd.mm.yyyy") and is_date_format("mm-dd-yy") and is_date_format("h:mm")
    assert not is_date_format("General") and not is_date_format("0.00") and not is_date_format('"d"0')
    assert not is_date_format("[Red]0.00") and not is_date_format(None)


def test_trailing_empty_cells_are_dropped_gaps_are_empty_short_rows_stay_short():
    assert one('<c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2" s="1"/><c r="C2" t="inlineStr"><is><t/></is>'
               "</c>") == ["a"]
    assert one('<c r="C2"><v>3</v></c>') == ["", "", "3"]
    assert one('<c r="A2" t="b"><v>0</v></c><c r="B2" s="1"/>') == [INVALID]


def test_rows_keep_their_sheet_numbers_and_empty_rows_are_skipped():
    got = rows_of('<row r="2"/><row r="3"><c r="A3" s="1"/></row><row r="5"><c r="A5"><v>5</v></c></row>')
    assert got == [(5, ["5"])]


def test_the_header_is_row_1_only():
    assert read_workbook(book('<row r="2"><c r="A2"><v>1</v></c></row>'))[1] is None
    head = read_workbook(book('<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c>'
                              '<c r="B1" t="inlineStr"><is><t>name</t></is></c></row>'))
    assert head[1] == ["code", "name"] and head[2] == []


def test_out_of_range_shared_string_is_empty():
    sst = f'<sst xmlns="{NS}"><si><t>only</t></si></sst>'
    assert one('<c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>0</v></c>', sst=sst) == ["", "only"]


def test_a_long_cell_is_too_long_marker():
    assert one(f'<c r="A2" t="inlineStr"><is><t>{"ж" * 1001}</t></is></c>') == [TOO_LONG]
    assert one(f'<c r="A2" t="inlineStr"><is><t>{"ж" * 1000}</t></is></c>') == ["ж" * 1000]
