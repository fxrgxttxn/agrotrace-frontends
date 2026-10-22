<?php

namespace App\Infrastructure\Xlsx;

/**
 * The parts of a workbook the reading needs, after the pre-scan passed (XlsxScanner::scan): the workbook part and its
 * relationships, the first sheet, the shared strings and the styles — UTF-8 text (BOM dropped) except the styles,
 * which the scanner never reads (exceljs parses them itself).
 */
final class FirstSheet
{
    public function __construct(
        public readonly string $workbook,
        public readonly string $rels,
        public readonly string $sheet,
        public readonly ?string $sharedStrings,
        public readonly ?string $styles,
    ) {}
}
