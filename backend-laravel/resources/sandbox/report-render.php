<?php

/*
 * Sandbox child of the report lane (downloadReport, P52, L6; App\Actions\Reports\Queue, App\Infrastructure\Sandbox\Lane):
 * renders one report off the Octane worker, under the lane's memory limit (1 GiB) and deadline. No Laravel: the
 * composer autoloader, PhpSpreadsheet (XLSX) and TCPDF (PDF) only. Protocol: `ready\n` once loaded and warm, the job
 * JSON on stdin (to EOF) — {format, title, periodLine, generatedLine, generatedAt, fontDir, sheets} (App\Actions\Reports
 * \ReportsActions) — then on stdout `OK\n` + the file bytes, or `ERR\n` + the message when rendering threw. A child that
 * runs out of memory or time dies instead (the parent answers 503 report-busy).
 */

declare(strict_types=1);

use App\Infrastructure\Reports\ReportPdf;
use App\Infrastructure\Reports\XlsxWriter;

require __DIR__.'/../../vendor/autoload.php';

// Every double printed exactly (shortest round trip), as JavaScript prints the numbers of Express's workbook.
ini_set('precision', '-1');

/**
 * @param  array{format: string, title: string, periodLine: string, generatedLine: string, generatedAt: string, fontDir: ?string,
 *   sheets: list<array{name: string, header: list<string>, rows: list<list<array{0: string, 1: string|int|null}>>}>}  $job
 */
function render_report(array $job): string
{
    if ($job['format'] === 'xlsx') {
        return XlsxWriter::write($job['sheets'], $job['generatedAt']);
    }

    return ReportPdf::render([
        'title' => $job['title'],
        'periodLine' => $job['periodLine'],
        'generatedLine' => $job['generatedLine'],
        'generatedAt' => $job['generatedAt'],
        'fontDir' => (string) $job['fontDir'],
        // Express `cellText`: String(v) — counts as integers, masses and decimals as their strings; null — empty.
        'sheets' => array_map(fn (array $s): array => [
            'name' => $s['name'],
            'header' => $s['header'],
            'rows' => array_map(fn (array $row): array => array_map(fn (array $c): string => $c[1] === null ? '' : (string) $c[1], $row), $s['rows']),
        ], $job['sheets']),
    ]);
}

// Warm up the libraries before reporting ready (the job's clock starts at `ready`).
XlsxWriter::write([['name' => 'warm-up', 'header' => ['a'], 'rows' => [[['int', 1]]]]], '1970-01-01T00:00:00.000Z');
class_exists(TCPDF::class);
sandbox_ready(); // limits.php, the Lane's prelude: `ready`, then the child's own alarm on the job's budget

$input = stream_get_contents(STDIN);
try {
    $job = json_decode((string) $input, true, 64, JSON_THROW_ON_ERROR);
    $out = "OK\n".render_report($job);
} catch (Throwable $e) {
    $out = "ERR\n".$e::class.': '.$e->getMessage();
}
fwrite(STDOUT, $out);
exit(0);
