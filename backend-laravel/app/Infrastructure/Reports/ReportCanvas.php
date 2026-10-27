<?php

namespace App\Infrastructure\Reports;

use App\Infrastructure\Pdf\PdfText;
use TCPDF;
use TCPDF_FONTS;
use TCPDF_STATIC;

/**
 * The report PDF's page (ReportPdf): TCPDF with the two hot paths of a 50 000-row table made cheap, the layout
 * unchanged —
 * - measuring: a string's width is the sum of its characters' widths (TCPDF applies no kerning; spacing and
 *   stretching stay 0 / 100 %), so each character's width per face is read from TCPDF once and cached, and wrapping
 *   adds word widths instead of re-measuring the growing line (Express's `widthOf` per candidate line);
 * - drawing: a run is written as one `BT … Td [(…)] TJ ET` text object — what Text()/Cell() emit for a left-aligned,
 *   unbordered, unpadded cell (baseline = top + (cell height − ascent − descent) / 2 + ascent), without their per-call
 *   bidi, region and link work. The glyphs are registered for font subsetting as Cell() does
 *   (TCPDF_FONTS::UTF8StringToArray).
 * Measured (php-tools, 50 000 rows × 12 columns): 105 s through Text() and GetStringWidth() — at the edge of the 120 s
 * deadline — and 28 s with this canvas.
 *
 * It reads TCPDF's protected state (`_out`, `CurrentFont`, `FontAscent`, `FontDescent`, `TextColor`, `k`, `h`), so
 * TCPDF is pinned to the exact version it was checked against (composer.json `tecnickcom/tcpdf` 6.11.4, T13 review M3);
 * an upgrade must pass ReportRenderTest's canvas-equivalence test (text objects, colour, font subsets) first.
 */
final class ReportCanvas extends TCPDF
{
    /** @var array<string, array<string, float>> face → character → width at 1 pt */
    private array $charWidths = [];

    public function __construct()
    {
        parent::__construct('L', 'pt', 'A4', true, 'UTF-8', false);
        // No hidden "Powered by TCPDF" line (the constructor switches it on).
        $this->tcpdflink = false;
    }

    /** The width of one character in a face at $size. */
    public function charWidth(string $face, string $ch, float $size): float
    {
        if (! isset($this->charWidths[$face][$ch])) {
            $this->charWidths[$face][$ch] = $this->GetStringWidth($ch, $face, '', 1);
        }

        return $this->charWidths[$face][$ch] * $size;
    }

    /** PdfText::widthOf from the cached character widths (a space takes the script of the run before it). */
    public function measure(string $text, string $weight, float $size): float
    {
        return $this->measureWord($text, $weight, $size, false)[0];
    }

    /**
     * Width of $word and the script of its last character; a leading space takes $prevCyr.
     *
     * @return array{0: float, 1: bool}
     */
    public function measureWord(string $word, string $weight, float $size, bool $prevCyr): array
    {
        $w = 0.0;
        $cyr = $prevCyr;
        foreach (mb_str_split($word, 1, 'UTF-8') as $ch) {
            if ($ch !== ' ') {
                $cyr = PdfText::isCyr($ch);
            }
            $w += $this->charWidth(PdfText::face($weight, $cyr), $ch, $size);
        }

        return [$w, $cyr];
    }

    /** PdfText::drawLine: the runs of one line from ($x, $y) (the line's top), ink #33291F. */
    public function drawRuns(string $text, string $weight, float $size, float $x, float $y): void
    {
        foreach (PdfText::runs($text) as $r) {
            $face = PdfText::face($weight, $r['cyr']);
            if ($this->getFontFamily() !== $face || $this->getFontSizePt() != $size) {
                $this->SetFont($face, '', $size);
            }
            $this->textAt($x, $y, $r['s']);
            $x += $this->measureWord($r['s'], $weight, $size, $r['cyr'])[0];
        }
    }

    /** One run in the current font, top-left at ($x, $y) — the text object Text() would emit. */
    private function textAt(float $x, float $y, string $s): void
    {
        $unicode = TCPDF_FONTS::UTF8StringToArray($s, true, $this->CurrentFont);
        $txt = TCPDF_STATIC::_escape(TCPDF_FONTS::arrUTF8ToUTF16BE($unicode, false));
        $h = $this->getCellHeight($this->FontSize, false);
        $base = $y + ($h - $this->FontAscent - $this->FontDescent) / 2 + $this->FontAscent;
        $this->_out(sprintf('q %s BT %F %F Td [(%s)] TJ ET Q', $this->TextColor, $x * $this->k, ($this->h - $base) * $this->k, $txt));
    }
}
