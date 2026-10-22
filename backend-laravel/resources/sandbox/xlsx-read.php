<?php

/*
 * Sandbox child of the XLSX lanes (L6, L13, P24, P25; App\Infrastructure\Sandbox\Lane): stages 2–4 of one import
 * workbook — every ZIP entry inflated and checked, the linear pre-scan, the reading — off the Octane worker, under the
 * lane's memory limit and deadline. No Laravel: only the framework-free classes it needs. Protocol: `ready\n` once
 * loaded and warm, the workbook bytes on stdin (to EOF), one JSON document on stdout — the bounded result (cells of at
 * most 1 000 characters, ≤ 8 MiB of text; null = INVALID, 1 = TOO_LONG) or `{"ok":false,"kind":…}`.
 */

declare(strict_types=1);

$app = __DIR__.'/../../app';
require $app.'/Support/JsNumber.php';
foreach (['ZipError', 'ZipIndex', 'Zip', 'ScanError', 'XlsxStop', 'FirstSheet', 'XmlScanner', 'XlsxScanner', 'SheetState', 'XlsxReader'] as $class) {
    require $app."/Infrastructure/Xlsx/{$class}.php";
}

use App\Infrastructure\Xlsx\XlsxReader;

mb_substitute_character(0xFFFD);

// Warm up libxml2 and the classes before reporting ready (the job's clock starts at `ready`).
XlsxReader::readWorkbook('');
fwrite(STDOUT, "ready\n");
fflush(STDOUT);

$input = stream_get_contents(STDIN);
$result = is_string($input) ? XlsxReader::readWorkbook($input) : ['ok' => false, 'kind' => 'unsupported'];
fwrite(STDOUT, json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
exit(0);
