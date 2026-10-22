<?php

/*
 * The XLSX reading (L13; Express xlsx-read.ts readWorkbook over exceljs): the cell semantics the contract gives an
 * import (strings as is, numbers as their shortest decimal text without exponent, other types → INVALID, date-styled
 * numbers → INVALID), the exceljs deviations the port keeps on the contract's side, and xl/styles.xml read the way
 * saxes reads it (a DOCTYPE skipped unprocessed: a referenced entity it declares is undefined → unsupported).
 */

use App\Infrastructure\Xlsx\FirstSheet;
use App\Infrastructure\Xlsx\XlsxReader;
use App\Infrastructure\Xlsx\XlsxStop;

const XR_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** @return array{header: mixed, rows: list<array{number: int, cells: list<mixed>}>} */
function xrRead(string $rows, ?string $sst = null, ?string $styles = null): array
{
    return XlsxReader::read(new FirstSheet(
        '<workbook xmlns="'.XR_NS.'"/>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        '<worksheet xmlns="'.XR_NS.'"><sheetData>'.$rows.'</sheetData></worksheet>',
        $sst,
        $styles,
    ));
}

/** The cells of data row 2 under a one-cell header. */
function xrRow(string $cells, ?string $sst = null, ?string $styles = null): array
{
    $r = xrRead('<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row><row r="2">'.$cells.'</row>', $sst, $styles);

    return $r['rows'][0]['cells'] ?? [];
}

/** Two cell styles: 0 general, 1 the custom date format 164 (what exceljs writes for `numFmt = 'dd.mm.yyyy'`). */
function xrDateStyles(): string
{
    return '<styleSheet xmlns="'.XR_NS.'"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd\.mm\.yyyy"/></numFmts>'
        .'<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="2"/></cellXfs></styleSheet>';
}

it('strings as is; numbers in the shortest decimal form without exponent', function () {
    expect(xrRow('<c r="A2" t="inlineStr"><is><t xml:space="preserve">  a&amp;b  </t></is></c><c r="B2"><v>1.50</v></c><c r="C2"><v>1e21</v></c><c r="D2"><v>1E-7</v></c><c r="E2"><v>-0</v></c><c r="F2"><v>30</v></c>'))
        ->toBe(['  a&b  ', '1.5', '1000000000000000000000', '0.0000001', '0', '30']);
});

it('booleans, errors and t="d" → INVALID; NaN text → INVALID', function () {
    expect(xrRow('<c r="A2" t="b"><v>1</v></c><c r="B2" t="e"><v>#N/A</v></c><c r="C2" t="d"><v>2026-01-02</v></c><c r="D2"><v>abc</v></c>'))
        ->toBe([XlsxReader::INVALID, XlsxReader::INVALID, XlsxReader::INVALID, XlsxReader::INVALID]);
});

it('a number in a date format (custom, built-in 14, or the row style) → INVALID; other formats → its number', function () {
    $s = xrDateStyles();
    expect(xrRow('<c r="A2" s="1"><v>46024</v></c><c r="B2" s="2"><v>46024</v></c><c r="C2" s="3"><v>2.5</v></c><c r="D2" s="0"><v>7</v></c>', null, $s))
        ->toBe([XlsxReader::INVALID, XlsxReader::INVALID, '2.5', '7']);
    // A cell with a falsy style index keeps its row's style (exceljs).
    $r = xrRead('<row r="1"><c r="A1"><v>1</v></c></row><row r="2" s="1"><c r="A2" s="0"><v>5</v></c><c r="B2" s="3"><v>5</v></c></row>', null, $s);
    expect($r['rows'][0]['cells'])->toBe([XlsxReader::INVALID, '5']);
});

it('formulas: the cached result typed by t; none → empty; 0 stays "0"', function () {
    expect(xrRow('<c r="A2"><f>1+1</f><v>2</v></c><c r="B2" t="str"><f>A1</f><v>txt</v></c><c r="C2" t="b"><f>TRUE()</f><v>1</v></c><c r="D2"><f>0</f><v>0</v></c><c r="E2"><f>X</f></c><c r="F2" t="inlineStr"><is><t>z</t></is></c>'))
        ->toBe(['2', 'txt', XlsxReader::INVALID, '0', '', 'z']);
});

it('shared strings: runs concatenated, phonetic runs left out; inline rich text likewise; a missing index is empty', function () {
    $sst = '<sst xmlns="'.XR_NS.'"><si><t>plain</t></si><si><r><t>ri</t></r><r><rPr><b/></rPr><t>ch</t></r><rPh><t>phon</t></rPh></si><si/></sst>';
    expect(xrRow('<c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c><c r="D2" t="s"><v>9</v></c><c r="E2" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r></is></c>', $sst))
        ->toBe(['plain', 'rich', '', '', 'ab']);
});

// Ruling Q13 (as Django Q9): where exceljs differs, the contract/brief wins — t="d" → INVALID (exceljs: a date), a
// formula without a cached value → '' (exceljs: INVALID), phonetic `<rPh>` runs dropped from inline rich text too
// (exceljs: the phonetic text). Express differs on these three inputs (integration backlog).
it('Ruling Q13: t="d" is INVALID, an uncached formula is empty, rPh is dropped (inline and shared)', function () {
    $sst = '<sst xmlns="'.XR_NS.'"><si><t>a</t><rPh sb="0" eb="1"><t>X</t></rPh></si></sst>';
    expect(xrRow(
        '<c r="A2" t="d"><v>2026-01-02T00:00:00Z</v></c>'
        .'<c r="B2"><f>SUM(1,1)</f></c>'
        .'<c r="C2" t="str"><f>"x"</f></c>'
        .'<c r="D2" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r><rPh sb="0" eb="1"><t>X</t></rPh></is></c>'
        .'<c r="E2" t="inlineStr"><is><t>a</t><rPh sb="0" eb="1"><t>X</t></rPh></is></c>'
        .'<c r="F2" t="s"><v>0</v></c>',
        $sst,
    ))->toBe([XlsxReader::INVALID, '', '', 'ab', 'a', 'a']);
});

it('trailing empty cells are dropped; a gap is an empty cell; empty rows are skipped', function () {
    $r = xrRead('<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="B2"><v>2</v></c><c r="C2"/></row><row r="3"><c r="A3" s="0"/></row><row r="4"><c r="A4"><v>4</v></c></row>');
    expect($r['header'])->toBe(['1']);
    expect($r['rows'])->toBe([['number' => 2, 'cells' => ['', '2']], ['number' => 4, 'cells' => ['4']]]);
});

it('a header only when the first row read is row 1', function () {
    expect(xrRead('<row r="2"><c r="A2"><v>1</v></c></row>')['header'])->toBeNull();
});

it('a cell over 1 000 code points → TOO_LONG (1 000 exactly is kept)', function () {
    expect(xrRow('<c r="A2" t="inlineStr"><is><t>'.str_repeat('ж', 1000).'</t></is></c><c r="B2" t="inlineStr"><is><t>'.str_repeat('ж', 1001).'</t></is></c>'))
        ->toBe([str_repeat('ж', 1000), XlsxReader::TOO_LONG]);
});

it('styles: a DOCTYPE entity that is referenced → unsupported, wherever the reference is (as saxes)', function (string $styles) {
    expect(fn () => XlsxReader::styles($styles))->toThrow(XlsxStop::class, 'unsupported');
})->with([
    'in an attribute' => ['<!DOCTYPE s [<!ENTITY f "dd.mm.yyyy">]><styleSheet xmlns="'.XR_NS.'"><numFmts><numFmt numFmtId="164" formatCode="&f;"/></numFmts></styleSheet>'],
    'in text' => ['<!DOCTYPE s [<!ENTITY e "x">]><styleSheet xmlns="'.XR_NS.'"><x>&e;</x></styleSheet>'],
    'billion laughs' => ['<!DOCTYPE s [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><styleSheet xmlns="'.XR_NS.'"><x>&c;</x></styleSheet>'],
    'an unterminated DOCTYPE' => ['<!DOCTYPE s [<!ENTITY e "x">'],
    'not well-formed' => ['<styleSheet xmlns="'.XR_NS.'"><x></styleSheet>'],
    'a numFmt without formatCode' => ['<styleSheet xmlns="'.XR_NS.'"><numFmts><numFmt numFmtId="164"/></numFmts></styleSheet>'],
]);

/** A DOCTYPE declaring entities `a0` (10 bytes) … `a{depth}` (10^(depth+1) bytes), each ten references to the one before. */
function xrLaughs(int $depth): string
{
    $d = '<!ENTITY a0 "aaaaaaaaaa">';
    for ($i = 1; $i <= $depth; $i++) {
        $d .= "<!ENTITY a{$i} \"".str_repeat('&a'.($i - 1).';', 10).'">';
    }

    return "<!DOCTYPE s [{$d}]>";
}

/** A styles part whose custom format 164 is the entity &$ref; (cellXfs: 164). */
function xrStylesRef(string $prolog, string $ref): string
{
    return $prolog.'<styleSheet xmlns="'.XR_NS.'"><numFmts><numFmt numFmtId="164" formatCode="&'.$ref.';"/></numFmts>'
        .'<cellXfs><xf numFmtId="164"/></cellXfs></styleSheet>';
}

// Review I1 (Tasks 4+5): the DOCTYPE used to be found by a substring search, so a decoy `<!DOCTYPE` inside a comment
// or a PI of the prolog (or a second DOCTYPE) left the real one — and its entities — to libxml2, which expanded them
// (with LIBXML_PARSEHUGE, without its amplification guard). saxes reads the prolog token by token: the entities stay
// undefined (or the second DOCTYPE is misplaced) → 415 {allowed} on Express.
it('styles: a DOCTYPE behind a decoy in the prolog, or a second DOCTYPE, is never processed (review I1)', function (string $styles) {
    $started = microtime(true);
    expect(fn () => XlsxReader::styles($styles))->toThrow(XlsxStop::class, 'unsupported');
    expect(microtime(true) - $started)->toBeLessThan(1.0);
})->with([
    'a decoy in a comment' => [xrStylesRef('<?xml version="1.0"?><!--<!DOCTYPE x>-->'.xrLaughs(3), 'a3')],
    'a decoy in a PI' => [xrStylesRef('<?x <!DOCTYPE y>?>'.xrLaughs(3), 'a3')],
    'a decoy comment with "] >"' => [xrStylesRef('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><!-- <!DOCTYPE ] > -->'.xrLaughs(3), 'a3')],
    'a second DOCTYPE' => [xrStylesRef('<!DOCTYPE x>'.xrLaughs(3), 'a3')],
    'a second DOCTYPE after a comment' => [xrStylesRef('<!DOCTYPE x [<!ENTITY q "1">]><!-- -->'.xrLaughs(3), 'a3')],
    'a second DOCTYPE, its entities unused' => ['<!DOCTYPE x><!DOCTYPE s [<!ENTITY u "u">]><styleSheet xmlns="'.XR_NS.'"/>'],
    'deep laughs behind a decoy' => [xrStylesRef('<!--<!DOCTYPE x>-->'.xrLaughs(9), 'a9')],
    'deep laughs in text behind a PI decoy' => ['<?p <!DOCTYPE?>'.xrLaughs(9).'<styleSheet xmlns="'.XR_NS.'"><x>&a9;</x></styleSheet>'],
    'a PI in the internal subset hiding "]>"' => [xrStylesRef('<!DOCTYPE s [<?p ]> ?><!ENTITY f "dd.mm.yyyy">]>', 'f')],
]);

it('styles: libxml2 never processes a DOCTYPE the prolog scan does not reach', function (string $styles) {
    expect(fn () => XlsxReader::styles($styles))->toThrow(XlsxStop::class, 'unsupported');
})->with([
    'after the root' => ['<styleSheet xmlns="'.XR_NS.'"/><!DOCTYPE s [<!ENTITY e "x">]>'],
    'after text' => ['x<!DOCTYPE s [<!ENTITY e "x">]><styleSheet xmlns="'.XR_NS.'">&e;</styleSheet>'],
    'after another declaration' => ['<!ELEMENT x ANY><!DOCTYPE s [<!ENTITY e "x">]><styleSheet xmlns="'.XR_NS.'">&e;</styleSheet>'],
]);

it('the other parts (read with LIBXML_PARSEHUGE) refuse any DOCTYPE, even behind a decoy', function (string $decoy) {
    $part = $decoy.xrLaughs(9).'<worksheet xmlns="'.XR_NS.'"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&a9;</t></is></c></row></sheetData></worksheet>';
    $started = microtime(true);
    expect(fn () => XlsxReader::sheet($part, [], []))->toThrow(XlsxStop::class, 'unsupported');
    expect(fn () => XlsxReader::sharedStrings($part))->toThrow(XlsxStop::class, 'unsupported');
    expect(fn () => XlsxReader::wellFormed($part))->toThrow(XlsxStop::class, 'unsupported');
    expect(microtime(true) - $started)->toBeLessThan(1.0);
})->with([
    'none' => [''],
    'a comment' => ['<!--<!DOCTYPE x>-->'],
    'a PI' => ['<?p <!DOCTYPE?>'],
    'a first DOCTYPE' => ['<!DOCTYPE x>'],
]);

it('styles: an unused, built-in-only, SYSTEM or parameter-entity DOCTYPE reads as without it', function (string $doctype) {
    $styles = $doctype.'<styleSheet xmlns="'.XR_NS.'"><numFmts><numFmt numFmtId="164" formatCode="a&amp;b"/></numFmts><cellXfs><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    expect(XlsxReader::styles($styles))->toBe(['a&b', 'mm-dd-yy']);
})->with([
    'none' => [''],
    'unused entity' => ['<!DOCTYPE s [<!ENTITY u "unused"><!-- ] > --><!ATTLIST x y CDATA "]">]>'],
    'SYSTEM' => ['<!DOCTYPE s SYSTEM "http://example.invalid/s.dtd">'],
    'parameter entity' => ['<!DOCTYPE s [<!ENTITY % p "<!ENTITY q \'v\'>"> %p;]>'],
    // saxes's DOCTYPE states: quotes, comments and PIs in the internal subset do not end it (review I1).
    'a PI in the subset hiding "]>"' => ['<!DOCTYPE s [<?p ]> ?><!ENTITY u "x">]>'],
    'a quoted "]>" in the subset' => ['<!DOCTYPE s [<!ENTITY u "]>">]>'],
    'a quoted ">" before the subset' => ['<!DOCTYPE s PUBLIC "-//a>b//EN" "x.dtd" [<!ENTITY u "x">]>'],
    'BOM, declaration, comments and PIs around it' => ["\u{FEFF}<?xml version=\"1.0\"?>\n<!-- c --><?p x?>\n<!DOCTYPE s [<!ENTITY u \"x\">]>\n<!-- d --><?q?>\n"],
]);

it('styles: invalid UTF-8 is replaced, as exceljs decodes the part', function () {
    expect(XlsxReader::styles('<styleSheet xmlns="'.XR_NS."\"><x>\xC3\x28</x><cellXfs><xf numFmtId=\"2\"/></cellXfs></styleSheet>"))->toBe(['0.00']);
});

it('isDateFmt: quoted and bracketed parts do not count', function () {
    expect(XlsxReader::isDateFormat('dd.mm.yyyy'))->toBeTrue();
    expect(XlsxReader::isDateFormat('[Red]0.00'))->toBeFalse();
    expect(XlsxReader::isDateFormat('0.00 "days"'))->toBeFalse();
    expect(XlsxReader::isDateFormat('[h]:mm'))->toBeTrue();
    expect(XlsxReader::isDateFormat('General'))->toBeFalse();
    expect(XlsxReader::isDateFormat(null))->toBeFalse();
});
