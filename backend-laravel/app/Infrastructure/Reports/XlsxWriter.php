<?php

namespace App\Infrastructure\Reports;

use PhpOffice\PhpSpreadsheet\Cell\DataType;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Style\Style;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;
use RuntimeException;
use ZipArchive;

/**
 * Report workbooks (downloadReport, contract `Файл`; Express infra/xlsx.ts with exceljs) written with PhpSpreadsheet:
 * one worksheet per sheet in order, named as given; row 1 — the column headers in bold; data from row 2. Cells: text —
 * a string cell; int — a number with format `0`; mass — a number with format `0.000`; dec2 — a number with format
 * `0.00`; null — no cell. Column widths as Express: min(60, max(8, longest + 2)) over the header and the first 200
 * rows (lengths in UTF-16 code units, as JavaScript's `String.length`). Workbook creator `AgroTrace`, created and
 * modified at the snapshot's instant.
 *
 * Numbers are the value Express stores (`Number("12.300")` → 12.3): an integral decimal is written as an integer, any
 * other as the double nearest to it — the conversion a spreadsheet cell needs, made here and nowhere else. The child
 * runs with `precision=-1`, so PhpSpreadsheet prints every double exactly (shortest round trip). Line breaks: "\r\n"
 * and "\r" become "\n" (PhpSpreadsheet's DataType::checkString) — what a reader of Express's file sees as well (XML
 * end-of-line normalization of exceljs's raw "\r"). Read back with exceljs, a workbook of this writer and one of
 * Express's agree cell for cell (values, number formats, bold, widths), except where exceljs itself mangles text: a
 * control character (Express's reader drops it, here it is kept as `_xHHHH_`), a literal `_x000D_` (Express's reader
 * decodes it) and an empty string (Express writes an empty string cell, here no cell — both read as empty).
 * Framework-free: runs in the report sandbox.
 */
final class XlsxWriter
{
    private const FORMATS = ['int' => '0', 'mass' => '0.000', 'dec2' => '0.00'];

    private const WIDTH_ROWS = 200;

    private const DEFAULT_WIDTH = 9;

    /**
     * The sheets and their rows may be generators (ReportStream): each row is read once, in order.
     *
     * @param  iterable<array{name: string, header: list<string>, rows: iterable<list<array{0: string, 1: string|int|null}>>}>  $sheets
     * @param  string  $createdAt  the snapshot's instant (`YYYY-MM-DDTHH:MM:SS.mmmZ`)
     */
    public static function write(iterable $sheets, string $createdAt): string
    {
        $wb = new Spreadsheet;
        $wb->removeSheetByIndex(0);
        $at = (int) strtotime($createdAt);
        $wb->getProperties()->setCreator('AgroTrace')->setLastModifiedBy('AgroTrace')->setCreated($at)->setModified($at);
        $bold = new Style;
        $bold->getFont()->setBold(true);
        $wb->addCellXf($bold);
        $xf = [];
        foreach (self::FORMATS as $type => $code) {
            $style = new Style;
            $style->getNumberFormat()->setFormatCode($code);
            $wb->addCellXf($style);
            $xf[$type] = $style->getIndex();
        }
        foreach ($sheets as $s) {
            $ws = new Worksheet($wb, $s['name']);
            $wb->addSheet($ws);
            foreach ($s['header'] as $i => $title) {
                $cell = $ws->getCell([$i + 1, 1]);
                $cell->setValueExplicit($title, DataType::TYPE_STRING);
                $cell->setXfIndex($bold->getIndex());
            }
            $longest = array_map(self::jsLength(...), $s['header']);
            $r = 0;
            foreach ($s['rows'] as $cells) {
                if ($r < self::WIDTH_ROWS) {
                    $longest = self::longest($longest, $cells);
                }
                $r++;
                foreach ($cells as $i => [$type, $v]) {
                    if ($v === null) {
                        continue;
                    }
                    $cell = $ws->getCell([$i + 1, $r + 1]);
                    if ($type === 'text') {
                        $cell->setValueExplicit((string) $v, DataType::TYPE_STRING);
                    } else {
                        $cell->setValueExplicit(self::number($v), DataType::TYPE_NUMERIC);
                        $cell->setXfIndex($xf[$type]);
                    }
                }
            }
            foreach (self::columnWidths($longest) as $i => $w) {
                // exceljs writes no <col> for a column of its default width 9 (Column.isCustomWidth): neither here.
                if ($w !== self::DEFAULT_WIDTH) {
                    $ws->getColumnDimensionByColumn($i + 1)->setWidth($w);
                }
            }
        }
        $wb->setActiveSheetIndex(0);
        $writer = new Xlsx($wb);
        $writer->setPreCalculateFormulas(false);
        $file = tempnam(sys_get_temp_dir(), 'report');
        if ($file === false) {
            throw new RuntimeException('no temporary file for the workbook');
        }
        try {
            $writer->save($file);
            $wb->disconnectWorksheets();
            self::plainFonts($file);

            return (string) file_get_contents($file);
        } finally {
            @unlink($file);
        }
    }

    /**
     * PhpSpreadsheet writes every font with `<b val="0"/>`, `<i val="0"/>` and `<strike val="0"/>`; exceljs (Express's
     * library, and the reader of tests/api) takes the bare presence of those elements for "on", so every data cell with
     * a number format would read back bold, italic and struck through. The off-valued elements are dropped — what the
     * attribute means anyway — so the header row alone is bold for every reader.
     */
    private static function plainFonts(string $file): void
    {
        $zip = new ZipArchive;
        if ($zip->open($file) !== true) {
            throw new RuntimeException('cannot reopen the workbook');
        }
        try {
            $styles = $zip->getFromName('xl/styles.xml');
            if ($styles === false) {
                throw new RuntimeException('the workbook has no styles part');
            }
            $zip->addFromString('xl/styles.xml', str_replace(['<b val="0"/>', '<i val="0"/>', '<strike val="0"/>'], '', $styles));
        } finally {
            $zip->close();
        }
    }

    /** A count as is; a decimal string as the number JavaScript's Number() gives (an integer when integral). */
    public static function number(int|string $v): int|float
    {
        if (is_int($v)) {
            return $v;
        }
        if (preg_match('/^(-?\d{1,15})(?:\.0*)?$/D', $v, $m) === 1) {
            return (int) $m[1];
        }

        return (float) $v;
    }

    /**
     * Express's column widths.
     *
     * @param  list<string>  $header
     * @param  list<list<array{0: string, 1: string|int|null}>>  $rows
     * @return list<int>
     */
    public static function widths(array $header, array $rows): array
    {
        $longest = array_map(self::jsLength(...), $header);
        foreach (array_slice($rows, 0, self::WIDTH_ROWS) as $row) {
            $longest = self::longest($longest, $row);
        }

        return self::columnWidths($longest);
    }

    /**
     * @param  list<int>  $longest  per column, the longest text so far
     * @param  list<array{0: string, 1: string|int|null}>  $row
     * @return list<int>
     */
    private static function longest(array $longest, array $row): array
    {
        foreach ($longest as $i => $n) {
            $longest[$i] = max($n, self::jsLength((string) ($row[$i][1] ?? '')));
        }

        return $longest;
    }

    /**
     * @param  list<int>  $longest
     * @return list<int>
     */
    private static function columnWidths(array $longest): array
    {
        return array_map(fn (int $n): int => min(60, max(8, $n + 2)), $longest);
    }

    /** JavaScript's String.length: UTF-16 code units. */
    private static function jsLength(string $s): int
    {
        return intdiv(strlen((string) mb_convert_encoding($s, 'UTF-16LE', 'UTF-8')), 2);
    }
}
