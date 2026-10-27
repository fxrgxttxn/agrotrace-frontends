<?php

namespace App\Infrastructure\Pdf;

use TCPDF;

/**
 * Text in the design-system faces (Express infra/pdf.ts): the @fontsource subsets are split by script, so every line
 * is laid out as runs that switch between the latin and the cyrillic face of a weight. Framework-free: the report
 * sandbox (resources/sandbox/report-render.php) uses it as well as the QR label.
 */
final class PdfText
{
    /** key => [@fontsource package, file] — the keys contain none of TCPDF's style words (bold, regular, …). */
    public const FONTS = [
        'at_r_cyr' => ['onest', 'onest-cyrillic-400-normal'],
        'at_r_lat' => ['onest', 'onest-latin-400-normal'],
        'at_b_cyr' => ['onest', 'onest-cyrillic-600-normal'],
        'at_b_lat' => ['onest', 'onest-latin-600-normal'],
        'at_m_cyr' => ['jetbrains-mono', 'jetbrains-mono-cyrillic-500-normal'],
        'at_m_lat' => ['jetbrains-mono', 'jetbrains-mono-latin-500-normal'],
    ];

    private const WEIGHT = ['regular' => 'at_r', 'bold' => 'at_b', 'mono' => 'at_m'];

    /** Registers the six faces from the TCPDF font files in $dir (LabelPdf::fontDir). */
    public static function register(TCPDF $pdf, string $dir): void
    {
        foreach (array_keys(self::FONTS) as $key) {
            $pdf->AddFont($key, '', "{$dir}/{$key}.php");
        }
    }

    /** Express `isCyr`: Cyrillic (U+0400–U+04FF) and `№` take the cyrillic face. */
    public static function isCyr(string $ch): bool
    {
        $cp = mb_ord($ch, 'UTF-8');

        return ($cp >= 0x0400 && $cp <= 0x04FF) || $cp === 0x2116;
    }

    /**
     * Express `splitRuns`: a space keeps the script of the run before it.
     *
     * @return list<array{cyr: bool, s: string}>
     */
    public static function runs(string $text): array
    {
        $parts = [];
        foreach (mb_str_split($text, 1, 'UTF-8') as $ch) {
            $last = $parts === [] ? null : count($parts) - 1;
            $cyr = $ch === ' ' && $last !== null ? $parts[$last]['cyr'] : self::isCyr($ch);
            if ($last !== null && $parts[$last]['cyr'] === $cyr) {
                $parts[$last]['s'] .= $ch;
            } else {
                $parts[] = ['cyr' => $cyr, 's' => $ch];
            }
        }

        return $parts;
    }

    public static function face(string $weight, bool $cyr): string
    {
        return self::WEIGHT[$weight].($cyr ? '_cyr' : '_lat');
    }

    public static function widthOf(TCPDF $pdf, string $text, string $weight, float $size): float
    {
        $sum = 0.0;
        foreach (self::runs($text) as $r) {
            $sum += $pdf->GetStringWidth($r['s'], self::face($weight, $r['cyr']), '', $size);
        }

        return $sum;
    }

    /** Draws one line of runs from ($x, $y) (the top of the line) in ink #33291F. */
    public static function drawLine(TCPDF $pdf, string $text, string $weight, float $size, float $x, float $y): void
    {
        $pdf->SetTextColor(0x33, 0x29, 0x1F);
        foreach (self::runs($text) as $r) {
            $face = self::face($weight, $r['cyr']);
            $pdf->SetFont($face, '', $size);
            $pdf->Text($x, $y, $r['s']);
            $x += $pdf->GetStringWidth($r['s'], $face, '', $size);
        }
    }
}
