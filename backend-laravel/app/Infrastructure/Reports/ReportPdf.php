<?php

namespace App\Infrastructure\Reports;

use App\Infrastructure\Pdf\PdfText;

/**
 * Report PDF (downloadReport, contract `Файл`; Express infra/pdf.ts `reportPdf`, the same layout): A4 landscape, the
 * design-system fonts with Cyrillic (PdfText), the heading `AgroTrace — <title>`, the period and generation lines,
 * then a section per sheet (subheading = sheet name) with the same table: equal column widths, cell text wrapped on
 * spaces and a word wider than its column broken between characters, a thin rule under every row, the header row
 * repeated on every new page. A row taller than a whole page (a 2000-character complaint) continues line by line on
 * the next pages under the repeated header (PL14, as Express and Django).
 *
 * TCPDF, not dompdf (decision of Task 13): dompdf lays a table out as an HTML document — measured 84 s and ~2 GB for
 * 2 000 rows, so the contract's 50 000 rows could never meet the 120 s deadline; TCPDF draws the lines directly
 * (ReportCanvas), as pdfkit does for Express. Framework-free: runs in the report sandbox.
 */
final class ReportPdf
{
    private const MARGIN = 28.0;

    private const SIZE = 7.0;

    /**
     * @param  array{title: string, periodLine: string, generatedLine: string, generatedAt: string, fontDir: string,
     *   sheets: iterable<array{name: string, header: list<string>, rows: iterable<list<string>>}>}  $d  rows read once, in order
     */
    public static function render(array $d): string
    {
        $heading = "AgroTrace — {$d['title']}";
        $pdf = self::canvas($d['fontDir']);
        $pdf->SetTitle($heading);
        $at = (int) strtotime($d['generatedAt']);
        $pdf->setDocCreationTimestamp($at);
        $pdf->setDocModificationTimestamp($at);
        $pdf->AddPage('L', 'A4');

        $left = self::MARGIN;
        $width = $pdf->getPageWidth() - 2 * self::MARGIN;
        $bottom = $pdf->getPageHeight() - self::MARGIN;
        $lh = self::SIZE * 1.35;
        $y = self::paragraph($pdf, $heading, 'bold', 14, $left, self::MARGIN, $width);
        $y = self::paragraph($pdf, $d['periodLine'], 'regular', 9, $left, $y + 2, $width);
        $y = self::paragraph($pdf, $d['generatedLine'], 'regular', 9, $left, $y, $width);
        $pdf->SetLineWidth(0.3);
        $pdf->SetDrawColor(0xB8, 0xAE, 0x9F);
        $newPage = function () use ($pdf, &$y): void {
            $pdf->AddPage('L', 'A4');
            $y = self::MARGIN;
        };
        foreach ($d['sheets'] as $sheet) {
            $y += 10;
            if ($y > $bottom - 60) {
                $newPage();
            }
            $y = self::paragraph($pdf, $sheet['name'], 'bold', 11, $left, $y, $width);
            $colW = $width / max(1, count($sheet['header']));
            $headerH = max(array_map(fn (string $t): int => count(self::wrap($pdf, $t, 'bold', $colW - 4)), $sheet['header'])) * $lh + 3;
            $row = function (array $cells, string $weight) use (&$row, &$y, $pdf, $sheet, $colW, $lh, $left, $width, $bottom, $newPage, $headerH): void {
                $wrapped = array_map(fn (string $t): array => self::wrap($pdf, $t, $weight, $colW - 4), $cells);
                $lines = max(array_map('count', $wrapped));
                $h = $lines * $lh + 3;
                // A row that fits on a page starts on the next one when it does not fit here; a taller one continues
                // line by line on the next pages, under the repeated header (PL14).
                if ($y + $h > $bottom && ($weight === 'bold' || $h <= $bottom - self::MARGIN - $headerH)) {
                    $newPage();
                    if ($weight !== 'bold') {
                        $row($sheet['header'], 'bold');
                    }
                }
                for ($k = 0; $k < $lines; $k++) {
                    if ($y + $lh > $bottom) {
                        $newPage();
                        $row($sheet['header'], 'bold');
                    }
                    foreach ($wrapped as $i => $cellLines) {
                        if (($cellLines[$k] ?? '') !== '') {
                            $pdf->drawRuns($cellLines[$k], $weight, self::SIZE, $left + $i * $colW, $y);
                        }
                    }
                    $y += $lh;
                }
                $y += 3;
                $pdf->Line($left, $y - 1.5, $left + $width, $y - 1.5);
            };
            $row($sheet['header'], 'bold');
            foreach ($sheet['rows'] as $cells) {
                $row($cells, 'regular');
            }
        }

        return $pdf->Output('', 'S');
    }

    /** A blank report document: the faces registered, no header/footer, no automatic page breaks, ink #33291F. */
    public static function canvas(string $fontDir): ReportCanvas
    {
        $pdf = new ReportCanvas;
        $pdf->setPrintHeader(false);
        $pdf->setPrintFooter(false);
        $pdf->SetMargins(self::MARGIN, self::MARGIN, self::MARGIN);
        $pdf->SetAutoPageBreak(false);
        $pdf->setCellPaddings(0, 0, 0, 0);
        $pdf->setFontSubsetting(true);
        $pdf->SetCreator('AgroTrace');
        $pdf->SetAuthor('AgroTrace');
        $pdf->SetTextColor(0x33, 0x29, 0x1F);
        PdfText::register($pdf, $fontDir);

        return $pdf;
    }

    /**
     * Lines of $text within $width (Express `wrap`): paragraphs split on "\n", wrapped on spaces (the line grows by a
     * space and the word, widths added — a space takes the script of the character before it); a word wider than the
     * column is broken between characters.
     *
     * @return list<string>
     */
    public static function wrap(ReportCanvas $pdf, string $text, string $weight, float $width): array
    {
        $size = self::SIZE;
        $lines = [];
        foreach (explode("\n", $text) as $paragraph) {
            $line = '';
            $lineW = 0.0;
            $lineCyr = false;
            foreach (explode(' ', $paragraph) as $word) {
                [$wordW, $wordCyr] = $pdf->measureWord($word, $weight, $size, false);
                if ($line !== '') {
                    $next = "{$line} {$word}";
                    $nextW = $lineW + $pdf->charWidth(PdfText::face($weight, $lineCyr), ' ', $size) + $wordW;
                    $nextCyr = $word === '' ? $lineCyr : $wordCyr;
                } else {
                    [$next, $nextW, $nextCyr] = [$word, $wordW, $wordCyr];
                }
                if ($nextW <= $width) {
                    [$line, $lineW, $lineCyr] = [$next, $nextW, $nextCyr];

                    continue;
                }
                if ($line !== '') {
                    $lines[] = $line;
                }
                [$line, $lineW, $lineCyr] = ['', 0.0, false];
                foreach (mb_str_split($word, 1, 'UTF-8') as $ch) {
                    $cyr = PdfText::isCyr($ch);
                    $w = $pdf->charWidth(PdfText::face($weight, $cyr), $ch, $size);
                    if ($line !== '' && $lineW + $w > $width) {
                        $lines[] = $line;
                        [$line, $lineW] = ['', 0.0];
                    }
                    $line .= $ch;
                    $lineW += $w;
                    $lineCyr = $cyr;
                }
            }
            $lines[] = $line;
        }

        return $lines;
    }

    /** Draws $text left-aligned in a box from ($x, $y), wrapped on spaces; returns the y below the last line. */
    private static function paragraph(ReportCanvas $pdf, string $text, string $weight, float $size, float $x, float $y, float $width): float
    {
        $lines = [];
        $line = '';
        foreach (explode(' ', $text) as $word) {
            $next = $line !== '' ? "{$line} {$word}" : $word;
            if ($line !== '' && $pdf->measure($next, $weight, $size) > $width) {
                $lines[] = $line;
                $line = $word;
            } else {
                $line = $next;
            }
        }
        if ($line !== '') {
            $lines[] = $line;
        }
        foreach ($lines as $l) {
            $pdf->drawRuns($l, $weight, $size, $x, $y);
            $y += $size * 1.35;
        }

        return $y;
    }
}
