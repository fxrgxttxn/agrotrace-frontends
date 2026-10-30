<?php

/*
 * Sandbox child of the report lane (downloadReport, P52, L6; App\Actions\Reports\Queue, App\Infrastructure\Sandbox\Lane):
 * renders one report off the Octane worker, under the lane's memory limit (1 GiB) and deadline. No Laravel: the
 * composer autoloader, PhpSpreadsheet (XLSX) and TCPDF (PDF) only. Protocol: `ready\n` once loaded and warm; on stdin
 * the job as JSON lines (App\Infrastructure\Reports\ReportStream: the head {format, title, periodLine, generatedLine,
 * generatedAt, fontDir}, then the sheets and their rows, read row by row as the renderer goes); on stdout `OK\n` + the
 * file bytes, or `ERR\n` + the message when rendering threw. A child that runs out of memory or time dies instead
 * (the parent answers 503 report-busy).
 */

declare(strict_types=1);

use App\Infrastructure\Reports\ReportPdf;
use App\Infrastructure\Reports\ReportStream;
use App\Infrastructure\Reports\XlsxWriter;

require __DIR__.'/../../vendor/autoload.php';

// Every double printed exactly (shortest round trip), as JavaScript prints the numbers of Express's workbook.
ini_set('precision', '-1');

/** @param  resource  $in */
function render_report($in): string
{
    $job = new ReportStream($in);
    $head = $job->head();
    if ($head['format'] === 'xlsx') {
        return XlsxWriter::write($job->sheets(), (string) $head['generatedAt']);
    }

    // Express `cellText`: String(v) — counts as integers, masses and decimals as their strings; null — empty.
    $texts = function (iterable $rows): Generator {
        foreach ($rows as $row) {
            yield array_map(fn (array $c): string => $c[1] === null ? '' : (string) $c[1], $row);
        }
    };
    $sheets = function () use ($job, $texts): Generator {
        foreach ($job->sheets() as $s) {
            yield ['name' => $s['name'], 'header' => $s['header'], 'rows' => $texts($s['rows'])];
        }
    };

    return ReportPdf::render([
        'title' => (string) $head['title'],
        'periodLine' => (string) $head['periodLine'],
        'generatedLine' => (string) $head['generatedLine'],
        'generatedAt' => (string) $head['generatedAt'],
        'fontDir' => (string) $head['fontDir'],
        'sheets' => $sheets(),
    ]);
}

// Warm up the libraries before reporting ready (the job's clock starts at `ready`).
XlsxWriter::write([['name' => 'warm-up', 'header' => ['a'], 'rows' => [[['int', 1]]]]], '1970-01-01T00:00:00.000Z');
class_exists(TCPDF::class);
sandbox_ready(); // limits.php, the Lane's prelude: `ready`, then the child's own alarm on the job's budget

try {
    $out = "OK\n".render_report(STDIN);
} catch (Throwable $e) {
    $out = "ERR\n".$e::class.': '.$e->getMessage();
}
fwrite(STDOUT, $out);
exit(0);
