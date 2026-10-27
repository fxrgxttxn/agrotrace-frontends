<?php

/*
 * Report rendering in the sandbox child (resources/sandbox/report-render.php through the report lane): the XLSX read
 * back — sheets in order, the bold header row, string cells for texts, numeric cells with formats `0` / `0.000` /
 * `0.00` (also in a «Поле | Значение» sheet), empty cells for null, "\r" line breaks as "\n", masses as the exact
 * double; the PDF — a `%PDF-` file over several pages; long words broken between characters.
 */

use App\Actions\Reports\Queue;
use App\Infrastructure\Pdf\LabelPdf;
use App\Infrastructure\Pdf\PdfText;
use App\Infrastructure\Reports\ReportCanvas;
use App\Infrastructure\Reports\ReportPdf;
use App\Infrastructure\Reports\XlsxWriter;
use App\Infrastructure\Sandbox\LaneOptions;
use PhpOffice\PhpSpreadsheet\IOFactory;
use Tests\TestCase;

uses(TestCase::class);

function renderLane(): LaneOptions
{
    return new LaneOptions('report-test-'.getmypid().'-'.bin2hex(random_bytes(3)), Queue::WAITING, 60.0, Queue::MEMORY, sys_get_temp_dir().'/agrotrace-lanes-test');
}

/** @param  list<array<string, mixed>>  $sheets */
function renderJob(string $format, array $sheets): string
{
    $ticket = Queue::admit(renderLane());
    try {
        return $ticket->render(json_encode([
            'format' => $format,
            'title' => 'Реестр партий',
            'periodLine' => 'Период: 2026-03-01 — 2026-03-30 (UTC)',
            'generatedLine' => 'Сформирован: 2026-03-31 10:15 UTC',
            'generatedAt' => '2026-03-31T10:15:42.123Z',
            'fontDir' => $format === 'pdf' ? LabelPdf::fontDir() : null,
            'sheets' => $sheets,
        ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
    } finally {
        $ticket->release();
    }
}

function sampleSheets(): array
{
    return [
        [
            'name' => 'Партии',
            'header' => ['Код партии', 'Масса, кг', 'Партий', 'Длительность, ч', 'Держатель'],
            'rows' => [
                [['text', 'AT-2026-000001'], ['mass', '12.300'], ['int', 5], ['dec2', '1.50'], ['text', null]],
                [['text', "строка\r\nвторая\rтретья"], ['mass', '12.000'], ['int', 0], ['dec2', null], ['text', ' пробелы ']],
                [['text', '=1+1'], ['mass', '123456789012.345'], ['int', null], ['dec2', '333333333333333.33'], ['text', '']],
            ],
        ],
        [
            'name' => 'Организация',
            'header' => ['Поле', 'Значение'],
            'rows' => [
                [['text', 'Название'], ['text', 'КФХ «Заря»']],
                [['text', 'Рейтинг доверия'], ['int', 87]],
                [['text', 'Рейтинг доверия'], ['int', null]],
            ],
        ],
    ];
}

it('XLSX: sheets in order, the bold header, string and numeric cells with their formats, null as no cell', function () {
    $bytes = renderJob('xlsx', sampleSheets());
    expect(substr($bytes, 0, 4))->toBe("PK\x03\x04");
    $file = tempnam(sys_get_temp_dir(), 'report').'.xlsx';
    file_put_contents($file, $bytes);
    try {
        $wb = IOFactory::createReader('Xlsx')->load($file);
        expect($wb->getSheetNames())->toBe(['Партии', 'Организация']);
        $ws = $wb->getSheet(0);
        foreach (['A', 'B', 'C', 'D', 'E'] as $col) {
            expect($ws->getStyle("{$col}1")->getFont()->getBold())->toBeTrue();
            expect($ws->getCell("{$col}1")->getDataType())->toBe('s');
        }
        expect($ws->getCell('A1')->getValue())->toBe('Код партии');
        expect($ws->getStyle('A2')->getFont()->getBold())->toBeFalse();
        // Texts: strings ("\r\n" and "\r" as "\n", spaces kept, a formula-like text stays text).
        expect($ws->getCell('A2')->getDataType())->toBe('s');
        expect($ws->getCell('A3')->getValue())->toBe("строка\nвторая\nтретья");
        expect($ws->getCell('E3')->getValue())->toBe(' пробелы ');
        expect($ws->getCell('A4')->getDataType())->toBe('s');
        expect($ws->getCell('A4')->getValue())->toBe('=1+1');
        // Numbers with their formats.
        expect($ws->getCell('B2')->getDataType())->toBe('n');
        expect($ws->getCell('B2')->getValue())->toBe(12.3);
        expect($ws->getStyle('B2')->getNumberFormat()->getFormatCode())->toBe('0.000');
        expect($ws->getCell('B3')->getValue())->toEqual(12);
        expect($ws->getCell('B4')->getValue())->toBe((float) '123456789012.345');
        expect($ws->getCell('C2')->getValue())->toEqual(5);
        expect($ws->getStyle('C2')->getNumberFormat()->getFormatCode())->toBe('0');
        expect($ws->getCell('C3')->getValue())->toEqual(0);
        expect($ws->getCell('D2')->getValue())->toBe(1.5);
        expect($ws->getStyle('D2')->getNumberFormat()->getFormatCode())->toBe('0.00');
        expect($ws->getCell('D4')->getValue())->toBe((float) '333333333333333.33');
        // null: no value.
        foreach (['E2', 'D3', 'C4'] as $ref) {
            expect($ws->getCell($ref)->getValue())->toBeNull();
        }
        expect($ws->getHighestRow())->toBe(4);
        // «Поле | Значение»: the counts are numbers.
        $org = $wb->getSheet(1);
        expect($org->getCell('B2')->getDataType())->toBe('s');
        expect($org->getCell('B3')->getDataType())->toBe('n');
        expect($org->getCell('B3')->getValue())->toEqual(87);
        expect($org->getStyle('B3')->getNumberFormat()->getFormatCode())->toBe('0');
        expect($org->getCell('B4')->getValue())->toBeNull();
        // Express's widths: min(60, max(8, longest + 2)).
        expect($ws->getColumnDimension('A')->getWidth())->toEqual(23.0); // "строка\r\nвторая\rтретья" as sent: 21 + 2
        expect($org->getColumnDimension('A')->getWidth())->toEqual(17.0);
        expect($wb->getProperties()->getCreator())->toBe('AgroTrace');
        // Fonts carry no off-valued <b/i/strike val="0"/>: exceljs (Express's reader) would take them for "on".
        $zip = new ZipArchive;
        expect($zip->open($file))->toBeTrue();
        $styles = (string) $zip->getFromName('xl/styles.xml');
        $zip->close();
        expect($styles)->toContain('<b val="1"/>');
        expect($styles)->not->toContain('<b val="0"/>')->not->toContain('<i val="0"/>')->not->toContain('<strike val="0"/>');
        expect($ws->getStyle('B2')->getFont()->getBold())->toBeFalse();
    } finally {
        @unlink($file);
    }
});

it('XLSX: a column of exceljs\'s default width 9 gets no width of its own, as in Express', function () {
    $file = tempnam(sys_get_temp_dir(), 'report').'.xlsx';
    file_put_contents($file, XlsxWriter::write([['name' => 'Партии', 'header' => ['Глубина', 'Направление'], 'rows' => [[['int', 0], ['text', 'SOURCE']]]]], '2026-03-31T10:15:42.123Z'));
    try {
        $ws = IOFactory::createReader('Xlsx')->load($file)->getSheet(0);
        expect($ws->getColumnDimension('A')->getWidth())->toEqual(-1.0);
        expect($ws->getColumnDimension('B')->getWidth())->toEqual(13.0);
    } finally {
        @unlink($file);
    }
});

it('XLSX numbers: integral decimals as integers, the rest as the nearest double', function () {
    expect(XlsxWriter::number(5))->toBe(5);
    expect(XlsxWriter::number('12.000'))->toBe(12);
    expect(XlsxWriter::number('0.000'))->toBe(0);
    expect(XlsxWriter::number('12.300'))->toBe(12.3);
    expect(XlsxWriter::number('0.001'))->toBe(0.001);
    expect(XlsxWriter::widths(['ab'], [[['text', str_repeat('x', 100)]]]))->toBe([60]);
    expect(XlsxWriter::widths(['ab'], [[['int', 5]]]))->toBe([8]);
    expect(XlsxWriter::widths(['😀😀😀😀😀😀😀'], []))->toBe([16]); // UTF-16 code units
});

it('PDF: A4 landscape over several pages', function () {
    $rows = [];
    for ($i = 0; $i < 300; $i++) {
        $rows[] = [['text', "AT-2026-{$i}"], ['mass', '1.000'], ['int', $i], ['dec2', null], ['text', 'Держатель «Заря» №'.$i]];
    }
    $sheets = sampleSheets();
    $sheets[0]['rows'] = [...$sheets[0]['rows'], ...$rows];
    $bytes = renderJob('pdf', $sheets);
    expect(substr($bytes, 0, 5))->toBe('%PDF-');
    expect(preg_match_all('/\/Type\s*\/Page[^s]/', $bytes))->toBeGreaterThan(3);
    expect($bytes)->toContain('/MediaBox [0.000000 0.000000 841.890000 595.276000]');
});

it('PDF canvas: cached widths equal TCPDF\'s, a run is the text object Text() writes', function () {
    $pdf = ReportPdf::canvas(LabelPdf::fontDir());
    $pdf->AddPage('L', 'A4');
    foreach (['', 'AT-2026-000001', 'КФХ «Заря» Иванов', ' ведущий пробел', 'Mixed Смесь 12.5 №7', 'ё Ё ẞ 😀'] as $s) {
        foreach (['regular', 'bold'] as $weight) {
            expect($pdf->measure($s, $weight, 7.0))->toEqualWithDelta(PdfText::widthOf($pdf, $s, $weight, 7.0), 1e-9);
        }
    }
    // The same line through TCPDF's Text() (PdfText::drawLine) and through the canvas: the same text objects.
    $objects = function (callable $draw): array {
        $pdf = ReportPdf::canvas(LabelPdf::fontDir());
        $pdf->setCompression(false);
        $pdf->AddPage('L', 'A4');
        $draw($pdf);
        preg_match_all('/BT ([\d.]+ [\d.]+) Td \[\((.*?)\)\] TJ ET/s', $pdf->Output('', 'S'), $m, PREG_SET_ORDER);

        return array_map(fn (array $x) => [$x[1], $x[2]], $m);
    };
    $line = 'Партия AT-2026-000001 «Заря» №5';
    $viaText = $objects(fn (ReportCanvas $p) => PdfText::drawLine($p, $line, 'regular', 7.0, 40.5, 100.25));
    $viaCanvas = $objects(fn (ReportCanvas $p) => $p->drawRuns($line, 'regular', 7.0, 40.5, 100.25));
    expect($viaText)->toHaveCount(count(PdfText::runs($line)));
    expect($viaCanvas)->toBe($viaText);
});

it('PDF wrapping: on spaces, and a word wider than the column between characters', function () {
    $pdf = ReportPdf::canvas(LabelPdf::fontDir());
    $lines = ReportPdf::wrap($pdf, 'короткое '.str_repeat('Ш', 40)."\nвторой абзац", 'regular', 60.0);
    expect($lines[0])->toBe('короткое');
    expect(count($lines))->toBeGreaterThan(3);
    expect(implode('', array_slice($lines, 1, -1)))->toBe(str_repeat('Ш', 40));
    expect(end($lines))->toBe('второй абзац');
    expect(ReportPdf::wrap($pdf, '', 'regular', 60.0))->toBe(['']);
});
