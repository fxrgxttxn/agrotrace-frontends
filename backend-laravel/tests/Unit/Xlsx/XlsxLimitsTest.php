<?php

/*
 * P23–P28: the XLSX import reader — the port of all 81 cases of backend-express/test/xlsx-limits.test.ts. The request
 * thread checks only the ZIP directory; everything else runs in the sandbox child (resources/sandbox/xlsx-read.php)
 * behind the two bounded lanes with a deadline and a memory limit. Workbooks are built here from raw XML (stored or
 * deflated entries, declared sizes that lie). Every pathological input is read with a wall-clock bound (× TIMING_SLACK,
 * as in Express); Express's event-loop lag has no PHP counterpart (the Octane worker only waits on its lane), so the
 * request side is bounded by its memory instead.
 */

use App\Http\Problem\Problem;
use App\Infrastructure\Import\Cell;
use App\Infrastructure\Import\Sheet;
use App\Infrastructure\Import\SheetReader;
use App\Infrastructure\Sandbox\Lane;
use App\Infrastructure\Sandbox\LaneOptions;
use App\Infrastructure\Sandbox\LaneRefused;
use App\Infrastructure\Xlsx\ScanError;
use App\Infrastructure\Xlsx\XlsxScanner;
use App\Infrastructure\Xlsx\XmlScanner;
use App\Infrastructure\Xlsx\Zip;
use App\Infrastructure\Xlsx\ZipError;
use Tests\TestCase;

uses(TestCase::class);

const XL_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XL_R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XL_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XL_MIB = 1048576;
const XL_HDR = '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>';
const XL_TOO_LARGE = '415 workbook-too-large';
const XL_REFUSED = '415 UNSUPPORTED_MEDIA_TYPE';

function xlWb(): string
{
    return '<workbook xmlns="'.XL_NS.'" xmlns:r="'.XL_R_NS.'"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
}

function xlRels(): string
{
    return '<Relationships xmlns="'.XL_PKG.'"><Relationship Id="rId1" Type="'.XL_R_NS.'/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
}

function xlSlack(): float
{
    $s = getenv('TIMING_SLACK');

    return is_string($s) && is_numeric($s) ? (float) $s : 3.0;
}

/**
 * A ZIP of parts; a part with `declared` is deflated and declares that uncompressed size (a lie when it differs).
 *
 * @param  list<array{name: string, data: string, declared?: int}>  $parts
 */
function xlZip(array $parts): string
{
    $locals = '';
    $centrals = '';
    $offset = 0;
    foreach ($parts as $p) {
        $deflate = array_key_exists('declared', $p);
        $body = $deflate ? gzdeflate($p['data'], 6, ZLIB_ENCODING_RAW) : $p['data'];
        $size = $deflate ? $p['declared'] : strlen($p['data']);
        $crc = crc32($p['data']);
        $method = $deflate ? 8 : 0;
        $local = pack('VvvvvvVVVvv', 0x04034B50, 20, 0, $method, 0, 0, $crc, strlen($body), $size, strlen($p['name']), 0);
        $central = pack('VvvvvvvVVVvvvvvVV', 0x02014B50, 20, 20, 0, $method, 0, 0, $crc, strlen($body), $size, strlen($p['name']), 0, 0, 0, 0, 0, $offset);
        $locals .= $local.$p['name'].$body;
        $centrals .= $central.$p['name'];
        $offset += 30 + strlen($p['name']) + strlen($body);
    }
    $end = pack('VvvvvVVv', 0x06054B50, 0, 0, count($parts), count($parts), strlen($centrals), $offset, 0);

    return $locals.$centrals.$end;
}

/**
 * A hand-made workbook; `rows` is the `<sheetData>` content.
 *
 * @param  array{rows?: string, wb?: string, rels?: string, sst?: string, extra?: list<array{name: string, data: string, declared?: int}>}  $o
 */
function xlBook(array $o = []): string
{
    return xlZip([
        ['name' => '[Content_Types].xml', 'data' => '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
        ['name' => 'xl/workbook.xml', 'data' => $o['wb'] ?? xlWb()],
        ['name' => 'xl/_rels/workbook.xml.rels', 'data' => $o['rels'] ?? xlRels()],
        ...(isset($o['sst']) ? [['name' => 'xl/sharedStrings.xml', 'data' => $o['sst']]] : []),
        ['name' => 'xl/worksheets/sheet1.xml', 'data' => '<worksheet xmlns="'.XL_NS.'"><sheetData>'.($o['rows'] ?? XL_HDR).'</sheetData></worksheet>'],
        ...($o['extra'] ?? []),
    ]);
}

function xlSheetOnly(string $xml, array $over = []): string
{
    return xlZip([
        ['name' => '[Content_Types].xml', 'data' => '<Types/>'],
        ['name' => 'xl/workbook.xml', 'data' => $over['wb'] ?? xlWb()],
        ['name' => 'xl/_rels/workbook.xml.rels', 'data' => $over['rels'] ?? xlRels()],
        ['name' => $over['sheetName'] ?? 'xl/worksheets/sheet1.xml', 'data' => $xml],
    ]);
}

function xlColumn(int $n): string
{
    $s = '';
    for (; $n > 0; $n = intdiv($n - 1, 26)) {
        $s = chr(65 + (($n - 1) % 26)).$s;
    }

    return $s;
}

function xlCells(int $r, int $n, string $attrs = ''): string
{
    $out = '';
    for ($i = 0; $i < $n; $i++) {
        $out .= '<c r="'.xlColumn($i + 1).$r.'"'.$attrs.'><v>1</v></c>';
    }

    return $out;
}

/** The outcome of reading $bytes: "ok" / "415 workbook-too-large" / "415 UNSUPPORTED_MEDIA_TYPE" / "400 VALIDATION". */
function xlRead(string $bytes, ?Sheet &$sheet = null): string
{
    try {
        $sheet = SheetReader::read($bytes, 2);

        return 'ok';
    } catch (Problem $p) {
        return $p->status.' '.($p->params['reason'] ?? $p->problemCode->value);
    }
}

/** Reads $bytes asserting a wall-clock bound (× TIMING_SLACK). */
function xlTimed(string $bytes, int $boundMs): string
{
    $started = microtime(true);
    $r = xlRead($bytes);
    expect((microtime(true) - $started) * 1000)->toBeLessThan($boundMs * xlSlack());

    return $r;
}

/** Both lanes have a fresh child ready to start (a child's start-up is never charged to a job). */
function xlWarm(): void
{
    xlRead(xlBook());
    xlRead(xlBook(['extra' => [['name' => 'x/pad.bin', 'data' => str_repeat("\0", 70 * 1024)]]]));
}

/** A shared-strings table of one string $s, referenced by every cell of $rows × $cols (after the header). */
function xlAmplified(string $s, int $rows, int $cols): string
{
    $body = '';
    for ($i = 0; $i < $rows; $i++) {
        $body .= '<row r="'.($i + 2).'">';
        for ($k = 0; $k < $cols; $k++) {
            $body .= '<c r="'.xlColumn($k + 1).($i + 2).'" t="s"><v>0</v></c>';
        }
        $body .= '</row>';
    }

    return xlBook(['sst' => '<sst xmlns="'.XL_NS.'"><si><t>'.$s.'</t></si></sst>', 'rows' => XL_HDR.$body]);
}

/** The ZIP with the CRC of entry $name broken (central directory and local header). */
function xlBadCrc(string $b, string $name): string
{
    for ($p = strpos($b, $name); $p !== false; $p = strpos($b, $name, $p + 1)) {
        if ($p >= 46 && unpack('V', substr($b, $p - 46, 4))[1] === 0x02014B50) {
            $b = substr_replace($b, pack('V', unpack('V', substr($b, $p - 30, 4))[1] ^ 1), $p - 30, 4);
        }
        if ($p >= 30 && unpack('V', substr($b, $p - 30, 4))[1] === 0x04034B50) {
            $b = substr_replace($b, pack('V', unpack('V', substr($b, $p - 16, 4))[1] ^ 1), $p - 16, 4);
        }
    }

    return $b;
}

function xlScanOk(string $xml): void
{
    XmlScanner::scan($xml, fn () => false, fn () => null);
}

function xlRoot(string $inner, string $attrs = ''): string
{
    return '<r:root xmlns:r="urn:r"'.$attrs.'>'.$inner.'</r:root>';
}

describe('warm-up', function () {
    it('both lanes start their children (start-up is never charged to a job)', function () {
        expect(xlTimed(xlBook(), 60000))->toBe('ok');
        expect(xlTimed(xlBook(['extra' => [['name' => 'x/pad.bin', 'data' => str_repeat("\0", 70 * 1024)]]]), 60000))->toBe('ok');
    });
});

describe('ZIP directory (request thread) and inflate checks (sandbox)', function () {
    it('64 entries accepted, 65 refused; declared > 16 MiB per entry or > 32 MiB in all refused', function () {
        $pad = fn (int $k) => array_map(fn ($i) => ['name' => "x/{$i}.xml", 'data' => '<x/>'], range(0, $k - 1));
        expect(xlTimed(xlBook(['extra' => $pad(60)]), 3000))->toBe('ok');
        expect(xlTimed(xlBook(['extra' => $pad(61)]), 3000))->toBe(XL_TOO_LARGE);
        expect(xlTimed(xlBook(['extra' => [['name' => 'x/big.bin', 'data' => str_repeat("\0", 16 * XL_MIB + 1)]]]), 3000))->toBe(XL_TOO_LARGE);
        $eleven = str_repeat("\0", 11 * XL_MIB);
        expect(xlTimed(xlBook(['extra' => array_map(fn ($n) => ['name' => "x/{$n}.bin", 'data' => $eleven], ['a', 'b', 'c'])]), 3000))->toBe(XL_TOO_LARGE);
    });

    it('part caps: the workbook part, its relationships or styles over 1 MiB → too large', function () {
        expect(xlTimed(xlBook(['wb' => xlWb().'<!--'.str_repeat('x', XL_MIB).'-->']), 3000))->toBe(XL_TOO_LARGE);
        $styles = ['name' => 'xl/styles.xml', 'data' => '<styleSheet xmlns="'.XL_NS.'"/>'.str_repeat(' ', XL_MIB)];
        expect(xlTimed(xlBook(['extra' => [$styles]]), 3000))->toBe(XL_TOO_LARGE);
    });

    it('a bomb in an entry nobody reads is found (every entry is inflate-checked), in bounded time', function () {
        $before = memory_get_usage();
        expect(xlTimed(xlBook(['extra' => [['name' => 'x/bomb.bin', 'data' => str_repeat("\0", 64 * XL_MIB), 'declared' => 10]]]), 3000))->toBe(XL_TOO_LARGE);
        $wanted = xlZip([
            ['name' => '[Content_Types].xml', 'data' => '<Types/>'],
            ['name' => 'xl/workbook.xml', 'data' => xlWb()],
            ['name' => 'xl/_rels/workbook.xml.rels', 'data' => xlRels()],
            ['name' => 'xl/sharedStrings.xml', 'data' => str_repeat(' ', 64 * XL_MIB), 'declared' => 1000],
            ['name' => 'xl/worksheets/sheet1.xml', 'data' => '<worksheet xmlns="'.XL_NS.'"><sheetData>'.XL_HDR.'</sheetData></worksheet>'],
        ]);
        expect(xlTimed($wanted, 3000))->toBe(XL_TOO_LARGE);
        expect(fn () => Zip::open(xlZip([['name' => 'a', 'data' => str_repeat("\0", XL_MIB), 'declared' => 10]])))->toThrow(ZipError::class);
        // The request side never inflates: its memory stays far below the bombs' sizes.
        expect(memory_get_usage() - $before)->toBeLessThan(64 * XL_MIB);
    });

    it('a ZIP that is not a workbook → 415 without reason', function () {
        $notBook = xlZip([['name' => 'word/document.xml', 'data' => '<w/>'], ['name' => '[Content_Types].xml', 'data' => '<T/>']]);
        expect(xlTimed($notBook, 3000))->toBe(XL_REFUSED);
    });
});

describe('pre-scan limits (cells = <c> elements per row; no cell beyond column 64)', function () {
    it('20 000 <row> elements (empty ones included) read, one more → too large', function () {
        $empty = function (int $n): string {
            $s = '';
            for ($i = 0; $i < $n; $i++) {
                $s .= '<row r="'.($i + 2).'"/>';
            }

            return $s;
        };
        expect(xlTimed(xlBook(['rows' => XL_HDR.$empty(19999)]), 5000))->toBe('ok');
        expect(xlTimed(xlBook(['rows' => XL_HDR.$empty(20000)]), 5000))->toBe(XL_TOO_LARGE);
    });

    it('64 <c> read; 65 <c> (styled empty ones count too) or a value in column 65 → too large', function () {
        expect(xlTimed(xlBook(['rows' => '<row r="1">'.xlCells(1, 64).'</row>']), 3000))->toBe('ok');
        expect(xlTimed(xlBook(['rows' => '<row r="1">'.xlCells(1, 65).'</row>']), 3000))->toBe(XL_TOO_LARGE);
        $styled = '<row r="1"><c r="A1"><v>1</v></c>';
        for ($i = 0; $i < 64; $i++) {
            $styled .= '<c r="'.xlColumn($i + 2).'1" s="1"/>';
        }
        expect(xlTimed(xlBook(['rows' => $styled.'</row>']), 3000))->toBe(XL_TOO_LARGE);
        expect(xlTimed(xlBook(['rows' => '<row r="1"><c r="BM1"><v>1</v></c></row>']), 3000))->toBe(XL_TOO_LARGE);
        expect(xlTimed(xlBook(['rows' => '<row r="1"><c r="BL1"><v>1</v></c></row>']), 3000))->toBe('ok');
    });

    it('more than 200 000 shared strings or rich-text runs → too large', function () {
        $si = fn (int $n) => '<sst xmlns="'.XL_NS.'">'.str_repeat('<si><t>x</t></si>', $n).'</sst>';
        expect(xlTimed(xlBook(['sst' => $si(200000)]), 8000))->toBe('ok');
        expect(xlTimed(xlBook(['sst' => $si(200001)]), 3000))->toBe(XL_TOO_LARGE);
        $runs = '<sst xmlns="'.XL_NS.'"><si>'.str_repeat('<r><t>x</t></r>', 200001).'</si></sst>';
        expect(xlTimed(xlBook(['sst' => $runs]), 3000))->toBe(XL_TOO_LARGE);
    });

    it('the scanner is linear: 64 000 unclosed tags or 4 M empty cells are refused in milliseconds', function () {
        $started = microtime(true);
        expect(fn () => XmlScanner::scan('<sheets>'.str_repeat('<sheet', 64000), fn () => true, fn () => null))->toThrow(ScanError::class);
        expect(fn () => XlsxScanner::prescanSheet('<row r="1">'.str_repeat('<c/>', 4000000).'</row>'))->toThrow(ScanError::class);
        expect(microtime(true) - $started)->toBeLessThan(1.0 * xlSlack());
    });
});

describe('pathological workbooks: bounded time, the exact outcome, the request side stays small', function () {
    $mb16 = 16 * XL_MIB - 400;
    it('reads the case', function (callable $build, string $expected) {
        xlWarm(); // a child's start-up is not part of any job's bound
        $bytes = $build();
        $before = memory_get_usage();
        expect(xlTimed($bytes, 12000))->toBe($expected); // the 10 s deadline + slack
        // The request side holds the (bounded) result only: far below the amplified sizes.
        expect(memory_get_peak_usage() - $before)->toBeLessThan(64 * XL_MIB + strlen($bytes));
    })->with([
        'redosWorkbook' => [fn () => xlBook(['wb' => '<workbook xmlns="'.XL_NS.'" xmlns:r="'.XL_R_NS.'"><sheets>'.str_repeat('<sheet', 64000)]), XL_REFUSED],
        'redosRels' => [fn () => xlBook(['rels' => str_repeat('<Relationship', 64000)]), XL_REFUSED],
        // `<c>` without `r` is refused at the first one (P25), whatever follows.
        'emptyCells' => [fn () => xlBook(['rows' => '<row r="1">'.str_repeat('<c/>', 4000000).'</row>']), XL_REFUSED],
        'wideRowHuge' => [fn () => xlBook(['rows' => '<row r="1">'.str_repeat('<c><v>1</v></c>', 1000000).'</row>']), XL_REFUSED],
        'wideRowWithRefs' => [fn () => xlBook(['rows' => '<row r="1">'.xlCells(1, 70).'</row>']), XL_TOO_LARGE],
        'sstRich' => [function () use ($mb16) {
            $u = '<si><r><rPr><b/><i/><u/><sz val="1"/><color rgb="FF000000"/><rFont val="A"/></rPr><t>x</t></r></si>';

            return xlBook(['sst' => '<sst xmlns="'.XL_NS.'">'.str_repeat($u, intdiv($mb16, strlen($u))).'</sst>']);
        }, 'ok'],
        'sstRuns' => [fn () => xlBook(['sst' => '<sst xmlns="'.XL_NS.'"><si>'.str_repeat('<r><t>x</t></r>', intdiv($mb16, 15)).'</si></sst>']), XL_TOO_LARGE],
        // A 15 MiB cell: its text never leaves the sandbox (P25 cap), the row reports maxLength.
        'bigCell' => [fn () => xlBook(['rows' => XL_HDR.'<row r="2"><c r="A2" t="inlineStr"><is><t>'.str_repeat('x', 15 * XL_MIB).'</t></is></c></row>']), 'ok'],
        // One 1 MiB shared string referenced by 18 000 cells: nothing of it crosses to the request side (P25).
        'sharedStringAmplified' => [fn () => xlAmplified(str_repeat('x', XL_MIB), 9000, 2), 'ok'],
        // 999-character strings (under the cell cap) × 9 000 × 64 cells: over the 8 MiB result cap.
        'resultOverEightMiB' => [fn () => xlAmplified(str_repeat('ж', 999), 9000, 64), XL_TOO_LARGE],
    ]);

    it('a 1 MiB shared string in 18 000 cells reaches the request side as "too long" markers only', function () {
        expect(xlRead(xlAmplified(str_repeat('x', XL_MIB), 9000, 2), $sheet))->toBe('ok');
        expect($sheet->rows)->toHaveCount(9000);
        expect($sheet->rows[0]['cells'])->toBe([Cell::TooLong, Cell::TooLong]);
    });
});

describe('exact text: multi-byte characters (P25)', function () {
    it('3 000 Cyrillic rows (> 64 KiB of sheet and shared strings) read back exactly', function () {
        $expected = [];
        $sst = '';
        $rows = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>';
        $strings = ['code', 'name'];
        $inline = '';
        for ($i = 0; $i < 3000; $i++) {
            $row = ["К-{$i}", "Ёжиковая область №{$i} — «Щёлково» ".str_repeat('ЖЩЫ', $i % 7)];
            $expected[] = $row;
            $k = count($strings);
            array_push($strings, ...$row);
            $r = $i + 2;
            $rows .= "<row r=\"{$r}\"><c r=\"A{$r}\" t=\"s\"><v>{$k}</v></c><c r=\"B{$r}\" t=\"s\"><v>".($k + 1).'</v></c></row>';
            $inline .= "<row r=\"{$r}\"><c r=\"A{$r}\" t=\"inlineStr\"><is><t>{$row[0]}</t></is></c><c r=\"B{$r}\" t=\"inlineStr\"><is><t>{$row[1]}</t></is></c></row>";
        }
        foreach ($strings as $s) {
            $sst .= "<si><t>{$s}</t></si>";
        }
        expect(xlRead(xlBook(['rows' => $rows, 'sst' => '<sst xmlns="'.XL_NS.'">'.$sst.'</sst>']), $sheet))->toBe('ok');
        expect($sheet->header)->toBe(['code', 'name']);
        expect(array_column($sheet->rows, 'cells'))->toBe($expected);
        // An inline-string sheet > 64 KiB (no shared strings).
        expect(xlRead(xlBook(['rows' => XL_HDR.$inline]), $again))->toBe('ok');
        expect(array_column($again->rows, 'cells'))->toBe($expected);
    });
});

describe('P25 structure rules and the order of checks', function () {
    it('missing `r` on a row or a cell, a cell outside a row, prefixed SpreadsheetML elements → 415 {allowed}', function () {
        expect(xlRead(xlBook(['rows' => '<row><c r="A1"><v>1</v></c></row>'])))->toBe(XL_REFUSED);
        expect(xlRead(xlBook(['rows' => '<row r="1"><c><v>1</v></c></row>'])))->toBe(XL_REFUSED);
        expect(xlRead(xlBook(['rows' => XL_HDR.'<c r="A2"><v>1</v></c>'])))->toBe(XL_REFUSED);
        $prefixed = '<x:worksheet xmlns:x="'.XL_NS.'"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>';
        expect(xlRead(xlSheetOnly($prefixed)))->toBe(XL_REFUSED);
    });

    it('an entry whose CRC does not match, or that inflates to less than declared → 415 {allowed}', function () {
        expect(xlRead(xlBadCrc(xlBook(), 'xl/worksheets/sheet1.xml')))->toBe(XL_REFUSED);
        $short = xlZip([
            ['name' => '[Content_Types].xml', 'data' => '<Types/>'],
            ['name' => 'xl/workbook.xml', 'data' => xlWb()],
            ['name' => 'xl/_rels/workbook.xml.rels', 'data' => xlRels()],
            ['name' => 'xl/worksheets/sheet1.xml', 'data' => '<worksheet xmlns="'.XL_NS.'"><sheetData>'.XL_HDR.'</sheetData></worksheet>', 'declared' => 5000],
        ]);
        expect(xlRead($short))->toBe(XL_REFUSED);
    });

    it('order: directory → inflate/CRC of every entry → pre-scan (sheet, then shared strings) → rows → header', function () {
        $pad = array_map(fn ($i) => ['name' => "x/{$i}.xml", 'data' => '<x/>'], range(0, 60));
        // 65 entries (directory) beat a bad CRC.
        expect(xlRead(xlBadCrc(xlBook(['extra' => $pad]), 'xl/worksheets/sheet1.xml')))->toBe(XL_TOO_LARGE);
        // A bad CRC anywhere beats a pre-scan violation of the sheet.
        $wide = '<row r="1">'.xlCells(1, 65).'</row>';
        expect(xlRead(xlBadCrc(xlBook(['rows' => $wide, 'extra' => [['name' => 'x/a.xml', 'data' => '<a/>']]]), 'x/a.xml')))->toBe(XL_REFUSED);
        // The sheet is scanned before the shared strings: a sheet violation wins either way.
        $sstTooMany = '<sst xmlns="'.XL_NS.'">'.str_repeat('<si><t>x</t></si>', 200001).'</sst>';
        expect(xlRead(xlBook(['rows' => '<row r="1"><c><v>1</v></c></row>', 'sst' => $sstTooMany])))->toBe(XL_REFUSED);
        $sstPrefixed = '<x:sst xmlns:x="'.XL_NS.'"><x:si><x:t>a</x:t></x:si></x:sst>';
        expect(xlRead(xlBook(['rows' => $wide, 'sst' => $sstPrefixed])))->toBe(XL_TOO_LARGE);
        // tooManyRows (400) comes from reading, before any header check (the header here is wrong too).
        $many = '';
        for ($i = 0; $i < 10001; $i++) {
            $many .= '<row r="'.($i + 2).'"><c r="A'.($i + 2).'"><v>1</v></c></row>';
        }
        expect(xlRead(xlBook(['rows' => $many])))->toBe('400 VALIDATION');
    });
});

describe('a large legitimate workbook fits the sandbox memory', function () {
    it('5 000 rows × 64 cells (with references) read in bounded time', function () {
        $rows = '<row r="1"><c r="A1"><v>1</v></c></row>';
        for ($r = 2; $r <= 5000; $r++) {
            $rows .= '<row r="'.$r.'">'.xlCells($r, 64).'</row>';
        }
        $bytes = xlBook(['rows' => $rows]);
        xlWarm();
        $started = microtime(true);
        expect(xlRead($bytes, $sheet))->toBe('ok');
        expect(microtime(true) - $started)->toBeLessThan(5.0 * xlSlack());
        expect($sheet->rows)->toHaveCount(4999);
        expect($sheet->rows[0]['cells'])->toHaveCount(64);
    });
});

describe('the deadline terminates the child', function () {
    it('a job past its deadline → too complex; the child is killed and the next job runs on a fresh one', function () {
        $o = new LaneOptions('xlsx-test-'.getmypid(), 8, 0.3, '256M', sys_get_temp_dir().'/agrotrace-lanes-test');
        $rows = XL_HDR;
        for ($r = 2; $r <= 9000; $r++) {
            $rows .= '<row r="'.$r.'">'.xlCells($r, 64).'</row>';
        }
        $script = base_path('resources/sandbox/xlsx-read.php');
        // Warm: the child's start-up is not charged to a job, so only the job itself is timed below.
        expect(json_decode(Lane::run($script, xlBook(), $o), true)['ok'])->toBeTrue();
        $started = microtime(true);
        expect(fn () => Lane::run($script, xlBook(['rows' => $rows]), $o))->toThrow(LaneRefused::class, 'deadline missed');
        expect(microtime(true) - $started)->toBeLessThan(1.5 * xlSlack()); // 300 ms deadline, then the child is gone
        expect(json_decode(Lane::run($script, xlBook(), $o), true)['ok'])->toBeTrue();
    });
});

describe('no temporary files', function () {
    $temps = fn () => array_flip(scandir(sys_get_temp_dir()) ?: []);

    it('an Excel-ordered two-sheet workbook: the first sheet is read, nothing is left in the temp directory', function () use ($temps) {
        xlWarm();
        $wb = '<workbook xmlns="'.XL_NS.'" xmlns:r="'.XL_R_NS.'"><sheets><sheet name="Первый" sheetId="1" r:id="rId1"/><sheet name="Второй" sheetId="2" r:id="rId2"/></sheets></workbook>';
        $rels = '<Relationships xmlns="'.XL_PKG.'"><Relationship Id="rId1" Type="'.XL_R_NS.'/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="'.XL_R_NS.'/worksheet" Target="worksheets/sheet2.xml"/></Relationships>';
        $sheet = fn (string $a, string $b, string $c, string $d) => '<worksheet xmlns="'.XL_NS.'"><sheetData><row r="1"><c r="A1" t="s"><v>'.$a.'</v></c><c r="B1" t="s"><v>'.$b.'</v></c></row>'
            .($c !== '' ? '<row r="2"><c r="A2" t="s"><v>'.$c.'</v></c><c r="B2" t="s"><v>'.$d.'</v></c></row>' : '').'</sheetData></worksheet>';
        // Excel's part order: the sheets first, shared strings and relationships last.
        $book = xlZip([
            ['name' => 'xl/worksheets/sheet1.xml', 'data' => $sheet('0', '1', '2', '3')],
            ['name' => 'xl/worksheets/sheet2.xml', 'data' => $sheet('4', '5', '', '')],
            ['name' => '[Content_Types].xml', 'data' => '<Types/>'],
            ['name' => 'xl/workbook.xml', 'data' => $wb],
            ['name' => 'xl/sharedStrings.xml', 'data' => '<sst xmlns="'.XL_NS.'"><si><t>code</t></si><si><t>name</t></si><si><t>T-1</t></si><si><t>Строка</t></si><si><t>other</t></si><si><t>sheet</t></si></sst>'],
            ['name' => 'xl/_rels/workbook.xml.rels', 'data' => $rels],
        ]);
        $before = $temps();
        expect(xlRead($book, $read))->toBe('ok');
        expect($read->header)->toBe(['code', 'name']);
        expect($read->rows)->toBe([['number' => 2, 'cells' => ['T-1', 'Строка']]]);
        expect(array_diff_key($temps(), $before))->toBe([]);
    });

    it('a workbook failing to parse: 415, nothing left in the temp directory', function () use ($temps) {
        xlWarm();
        $before = $temps();
        $broken = xlBook(['rows' => '<row r="1"><c r="A1" t="s"><v>1</v></c></row><row r="2"><c']);
        expect(xlRead($broken))->toStartWith('415');
        expect(array_diff_key($temps(), $before))->toBe([]);
    });
});

describe('P26: references, namespaces, precedence, result text', function () {
    $c = fn (string $ref) => "<c r=\"{$ref}\"><v>1</v></c>";

    it('→ 415 {allowed}: %s', function (string $rows) {
        expect(xlRead(xlBook(['rows' => $rows])))->toBe(XL_REFUSED);
    })->with([
        'row r="0"' => ['<row r="0"><c r="A0"><v>1</v></c></row>'],
        'row r beyond 1 048 576' => ['<row r="99999999999"><c r="A99999999999"><v>1</v></c></row>'],
        'row r a fraction' => ['<row r="2.5"><c r="A2"><v>1</v></c></row>'],
        'row r with letters' => ['<row r="3abc"><c r="A3"><v>1</v></c></row>'],
        'row r with a sign' => ['<row r="+2"><c r="A2"><v>1</v></c></row>'],
        'row r with a leading zero' => ['<row r="02"><c r="A2"><v>1</v></c></row>'],
        'duplicate rows' => [XL_HDR.'<row r="2">'.$c('A2').'</row><row r="2">'.$c('A2').'</row>'],
        'rows out of order' => [XL_HDR.'<row r="3">'.$c('A3').'</row><row r="2">'.$c('A2').'</row>'],
        'a second header row after data' => [XL_HDR.'<row r="2">'.$c('A2').'</row>'.XL_HDR],
        'a cell of another row' => [XL_HDR.'<row r="2">'.$c('A7').'</row>'],
        'a cell reference without a row' => [XL_HDR.'<row r="2">'.$c('A').'</row>'],
        'decreasing cells' => [XL_HDR.'<row r="2">'.$c('B2').$c('A2').'</row>'],
        'duplicate cells' => [XL_HDR.'<row r="2">'.$c('A2').$c('A2').'</row>'],
        'a lower-case reference' => [XL_HDR.'<row r="2">'.$c('a2').'</row>'],
        'a $ reference' => [XL_HDR.'<row r="2">'.$c('$A$2').'</row>'],
    ]);

    it('namespaces: none, the Strict one, a foreign default namespace inside, or a non-SpreadsheetML workbook → 415', function () use ($c) {
        expect(xlRead(xlSheetOnly('<worksheet><sheetData>'.XL_HDR.'</sheetData></worksheet>')))->toBe(XL_REFUSED);
        expect(xlRead(xlSheetOnly('<worksheet xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"><sheetData>'.XL_HDR.'</sheetData></worksheet>')))->toBe(XL_REFUSED);
        $evil = '<worksheet xmlns="'.XL_NS.'"><sheetData><row r="1" xmlns="urn:evil">'.$c('A1').'</row></sheetData></worksheet>';
        expect(xlRead(xlSheetOnly($evil)))->toBe(XL_REFUSED);
        expect(xlRead(xlBook(['wb' => str_replace(' xmlns="'.XL_NS.'"', '', xlWb())])))->toBe(XL_REFUSED);
        expect(xlRead(xlBook(['sst' => '<sst><si><t>x</t></si></sst>'])))->toBe(XL_REFUSED);
        // Extra prefixed namespaces (as Excel writes them) are fine.
        $excel = '<worksheet xmlns="'.XL_NS.'" xmlns:r="'.XL_R_NS.'" xmlns:mc="urn:mc" mc:Ignorable="x14ac"><sheetData>'.XL_HDR.'</sheetData></worksheet>';
        expect(xlRead(xlSheetOnly($excel)))->toBe('ok');
    });

    it('on one element a malformed reference wins over a limit: $BM2 → {allowed}, BM2 → too large', function () use ($c) {
        expect(xlRead(xlBook(['rows' => XL_HDR.'<row r="2">'.$c('$BM2').'</row>'])))->toBe(XL_REFUSED);
        expect(xlRead(xlBook(['rows' => XL_HDR.'<row r="2">'.$c('BM2').'</row>'])))->toBe(XL_TOO_LARGE);
    });

    it('tooManyRows is decided while reading, before the 8 MiB result total', function () {
        // 10 001 data rows, each with 900 characters: over 8 MiB long before row 10 001 — still 400 tooManyRows.
        $long = '<sst xmlns="'.XL_NS.'"><si><t>'.str_repeat('x', 900).'</t></si></sst>';
        $rows = function (int $n): string {
            $s = '';
            for ($i = 0; $i < $n; $i++) {
                $s .= '<row r="'.($i + 2).'"><c r="A'.($i + 2).'" t="s"><v>0</v></c></row>';
            }

            return $s;
        };
        expect(xlRead(xlBook(['sst' => $long, 'rows' => XL_HDR.$rows(10001)])))->toBe('400 VALIDATION');
        // 10 000 such rows: 8.6 MiB of result text → too large.
        expect(xlRead(xlBook(['sst' => $long, 'rows' => XL_HDR.$rows(10000)])))->toBe(XL_TOO_LARGE);
    });
});

describe('P27: namespace-aware, well-formed XML; the first sheet per OPC', function () {
    $sheetXml = fn (string $inner, string $rootAttrs = 'xmlns="'.XL_NS.'"') => "<worksheet {$rootAttrs}><sheetData>".XL_HDR."</sheetData>{$inner}</worksheet>";
    $x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
    $xm = 'http://schemas.microsoft.com/office/excel/2006/main';

    it('elements of other namespaces are ignored: x14 data validation (xm:f) and data bars in extLst → ok', function () use ($sheetXml, $x14, $xm) {
        $ext = '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="'.$x14.'"><x14:dataValidations count="1" xmlns:xm="'.$xm.'"><x14:dataValidation type="list"><x14:formula1><xm:f>Lists!$A$1:$A$2</xm:f></x14:formula1><xm:sqref>B2:B100</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>';
        expect(xlRead(xlSheetOnly($sheetXml($ext))))->toBe('ok');
        $bar = '<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="'.$x14.'"><x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="'.$xm.'"><x14:cfRule type="dataBar"><x14:dataBar><x14:cfvo type="num"><xm:f>0</xm:f></x14:cfvo><x14:cfvo type="num"><xm:f>100</xm:f></x14:cfvo></x14:dataBar></x14:cfRule><xm:sqref>A2:A10</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst>';
        expect(xlRead(xlSheetOnly($sheetXml($bar))))->toBe('ok');
    });

    it('a prefixed element of the SpreadsheetML main or Strict namespace → 415 {allowed}', function () use ($sheetXml) {
        expect(xlRead(xlSheetOnly($sheetXml('<x:extLst/>', 'xmlns="'.XL_NS.'" xmlns:x="'.XL_NS.'"'))))->toBe(XL_REFUSED);
        expect(xlRead(xlSheetOnly($sheetXml('<s:extLst/>', 'xmlns="'.XL_NS.'" xmlns:s="http://purl.oclc.org/ooxml/spreadsheetml/main"'))))->toBe(XL_REFUSED);
        // Declaring the prefix without using it is fine.
        expect(xlRead(xlSheetOnly($sheetXml('', 'xmlns="'.XL_NS.'" xmlns:x="'.XL_NS.'"'))))->toBe('ok');
    });

    it('→ 415 {allowed}: %s', function (string $xml) {
        expect(xlRead(xlSheetOnly($xml)))->toBe(XL_REFUSED);
    })->with([
        'an unbound element prefix' => ['<worksheet xmlns="'.XL_NS.'"><sheetData>'.XL_HDR.'</sheetData><foo:bar/></worksheet>'],
        'an unbound attribute prefix' => ['<worksheet xmlns="'.XL_NS.'"><sheetData><row r="1" foo:x="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'],
        'a mismatched end tag' => ['<worksheet xmlns="'.XL_NS.'"><sheetData><row r="1"><c r="A1"><v>1</v></c></rowX></sheetData></worksheet>'],
        'a missing </worksheet>' => ['<worksheet xmlns="'.XL_NS.'"><sheetData>'.XL_HDR.'</sheetData>'],
        'a second root element' => ['<worksheet xmlns="'.XL_NS.'"><sheetData>'.XL_HDR.'</sheetData></worksheet><extra/>'],
        'a duplicate attribute' => ['<worksheet xmlns="'.XL_NS.'"><sheetData><row r="1" r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'],
        '< in an attribute value' => ['<worksheet xmlns="'.XL_NS.'"><sheetData><row r="1" spans="1<2"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'],
        '&#0; in text' => ['<worksheet xmlns="'.XL_NS.'"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a&#0;</t></is></c></row></sheetData></worksheet>'],
        'an undefined entity in text' => ['<worksheet xmlns="'.XL_NS.'"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a&foo;</t></is></c></row></sheetData></worksheet>'],
        'an XML declaration naming UTF-16' => ['<?xml version="1.0" encoding="UTF-16"?><worksheet xmlns="'.XL_NS.'"><sheetData>'.XL_HDR.'</sheetData></worksheet>'],
        'nesting deeper than 256' => ['<worksheet xmlns="'.XL_NS.'"><sheetData>'.XL_HDR.'</sheetData>'.str_repeat('<a:x xmlns:a="urn:a">', 300).str_repeat('</a:x>', 300).'</worksheet>'],
    ]);

    it('UTF-16 content (with or without a BOM) → 415 {allowed}', function () use ($sheetXml) {
        $le = (string) mb_convert_encoding($sheetXml(''), 'UTF-16LE', 'UTF-8');
        expect(xlRead(xlSheetOnly("\xFF\xFE".$le)))->toBe(XL_REFUSED);
        expect(xlRead(xlSheetOnly($le)))->toBe(XL_REFUSED);
    });

    it('only the unprefixed `r` counts, whatever the attribute order', function () {
        $rows = '<row x14ac:r="9" r="1" xmlns:x14ac="urn:a"><c r="A1" x14ac:r="Z9"><v>1</v></c></row>';
        expect(xlRead(xlSheetOnly('<worksheet xmlns="'.XL_NS.'"><sheetData>'.$rows.'</sheetData></worksheet>')))->toBe('ok');
        $onlyPrefixed = '<row x14ac:r="1" xmlns:x14ac="urn:a"><c r="A1"><v>1</v></c></row>';
        expect(xlRead(xlSheetOnly('<worksheet xmlns="'.XL_NS.'"><sheetData>'.$onlyPrefixed.'</sheetData></worksheet>')))->toBe(XL_REFUSED);
    });

    it('the first <sheet> whatever its type; targets resolved per OPC; a non-worksheet target → 415 {allowed}', function () use ($sheetXml) {
        $rel = fn (string $type, string $target) => '<Relationships xmlns="'.XL_PKG.'"><Relationship Id="rId1" Type="'.XL_R_NS.'/'.$type.'" Target="'.$target.'"/></Relationships>';
        expect(xlRead(xlSheetOnly($sheetXml(''), ['rels' => $rel('worksheet', '/xl/worksheets/sheet1.xml')])))->toBe('ok');
        expect(xlRead(xlSheetOnly($sheetXml(''), ['rels' => $rel('worksheet', '../xl/worksheets/sheet1.xml')])))->toBe('ok');
        expect(xlRead(xlSheetOnly($sheetXml(''), ['rels' => $rel('worksheet', 'data/first.xml'), 'sheetName' => 'xl/data/first.xml'])))->toBe('ok');
        expect(xlRead(xlSheetOnly($sheetXml(''), ['rels' => $rel('chartsheet', 'worksheets/sheet1.xml')])))->toBe(XL_REFUSED);
        expect(xlRead(xlSheetOnly($sheetXml(''), ['rels' => $rel('worksheet', '../../outside.xml')])))->toBe(XL_REFUSED);
    });
});

describe('P28: stricter well-formedness, linear scope handling', function () {
    it('→ malformed: %s', function (string $xml) {
        expect(fn () => xlScanOk($xml))->toThrow(ScanError::class, 'malformed');
    })->with([
        'text before the root' => ['junk'.xlRoot('')],
        'text after the root' => [xlRoot('').'junk'],
        'CDATA after the root' => [xlRoot('').'<![CDATA[x]]>'],
        'a raw control character' => [xlRoot("\u{0001}")],
        'U+FFFF' => [xlRoot("\u{FFFF}")],
        '-- inside a comment' => [xlRoot('<!-- a -- b -->')],
        'a comment ending in --->' => [xlRoot('<!-- a --->')],
        'one expanded attribute name twice' => [xlRoot('<p:a xmlns:p="urn:q" xmlns:q="urn:q" p:v="1" q:v="2"/>')],
        'xml bound elsewhere' => [xlRoot('<r:a xmlns:xml="urn:bad"/>')],
        'another prefix bound to the xml namespace' => [xlRoot('<r:a xmlns:x="http://www.w3.org/XML/1998/namespace"/>')],
        'xmlns as an element prefix' => [xlRoot('<xmlns:a/>')],
        'an empty prefix' => [xlRoot('<:row r="3"/>')],
        'an empty local part' => [xlRoot('<r:/>')],
        'two colons' => [xlRoot('<r:a:b/>')],
        'an attribute with an empty prefix' => [xlRoot('<r:a :v="1"/>')],
        'the encoding label UTF8' => ['<?xml version="1.0" encoding="UTF8"?>'.xlRoot('')],
    ]);

    it('still accepted: char references with leading zeros, xml bound to its own namespace, whitespace outside the root', function () {
        xlScanOk("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n".xlRoot('&#x0000000041;&#00065;')."\n");
        xlScanOk(xlRoot('<r:a xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:space="preserve"/>'));
        expect(true)->toBeTrue();
    });

    it('many declaring elements under many root bindings stay linear (no copy of the scope per element)', function () {
        $decl = '';
        for ($k = 0; $k < 20000; $k++) {
            $decl .= " xmlns:p{$k}=\"u:{$k}\"";
        }
        $kids = str_repeat('<q:e xmlns:q="u"/>', 700000);
        $started = microtime(true);
        xlScanOk('<r:root xmlns:r="urn:r"'.$decl.'>'.$kids.'</r:root>');
        expect(microtime(true) - $started)->toBeLessThan(1.5 * xlSlack());
    });

    it('an empty-prefix row in a sheet → 415 {allowed} (it was silently dropped by the reader before)', function () {
        expect(xlRead(xlBook(['rows' => XL_HDR.'<:row r="3"><c r="A3"><v>1</v></c></:row>'])))->toBe(XL_REFUSED);
    });
});
