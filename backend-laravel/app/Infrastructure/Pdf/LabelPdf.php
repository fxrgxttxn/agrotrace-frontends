<?php

namespace App\Infrastructure\Pdf;

use RuntimeException;
use TCPDF;
use TCPDF_FONTS;

/**
 * The A6 QR label of a batch (createBatchQr, R43, Ruling Q1 — the contract's A6 label, not the spec's A4 3×8; Express
 * infra/pdf.ts `qrLabelPdf`, the same layout): the QR, `publicCode` (JetBrains Mono 16 pt), the product name (Onest
 * 600, 12 pt), the origin organization (Onest 400, 9 pt) and the tagline (8 pt), centred, wrapped on spaces, ink
 * #33291F. The fonts are the design-system @fontsource WOFF files Express embeds; their subsets are split by script,
 * so every line is laid out as runs that switch between the latin and the cyrillic face (Express `splitRuns`).
 *
 * TCPDF reads TrueType: each WOFF is unwrapped (Woff) and converted to TCPDF's font files once per container, under a
 * flock, into `agrotrace.pdf.font_cache` (the image builds them at `docker build`; php-tools on first use).
 */
final class LabelPdf
{
    public const TAGLINE = 'Сканируйте, чтобы узнать происхождение партии';

    public static function qrLabel(string $publicCode, string $productName, string $originName, string $png, int $createdAt): string
    {
        $dir = self::fontDir();
        $pdf = new class('P', 'pt', 'A6', true, 'UTF-8', false) extends TCPDF
        {
            /** No hidden "Powered by TCPDF" line on the label (the constructor switches it on). */
            public function withoutTcpdfLink(): void
            {
                $this->tcpdflink = false;
            }
        };
        $pdf->withoutTcpdfLink();
        $pdf->setPrintHeader(false);
        $pdf->setPrintFooter(false);
        $pdf->SetMargins(28, 28, 28);
        $pdf->SetAutoPageBreak(false);
        $pdf->setCellPaddings(0, 0, 0, 0);
        $pdf->setFontSubsetting(true);
        $pdf->SetCreator('AgroTrace');
        $pdf->SetAuthor('AgroTrace');
        $pdf->SetTitle("QR {$publicCode}");
        $pdf->setDocCreationTimestamp($createdAt);
        $pdf->setDocModificationTimestamp($createdAt);
        PdfText::register($pdf, $dir);
        $pdf->AddPage();
        $w = $pdf->getPageWidth();
        $width = $w - 56;
        $pdf->Image('@'.$png, ($w - 220) / 2, 24, 220, 220, 'PNG');
        $y = self::paragraph($pdf, $publicCode, 'mono', 16, 28, 252, $width);
        $y = self::paragraph($pdf, $productName, 'bold', 12, 28, $y + 4, $width);
        $y = self::paragraph($pdf, $originName, 'regular', 9, 28, $y + 2, $width);
        self::paragraph($pdf, self::TAGLINE, 'regular', 8, 28, $y + 8, $width);

        return $pdf->Output('', 'S');
    }

    /** Draws $text centred in a box starting at ($x, $y); returns the y below the last line (Express `paragraph`). */
    private static function paragraph(TCPDF $pdf, string $text, string $weight, float $size, float $x, float $y, float $width): float
    {
        $lines = [];
        $line = '';
        foreach (explode(' ', $text) as $word) {
            $next = $line !== '' ? "{$line} {$word}" : $word;
            if ($line !== '' && PdfText::widthOf($pdf, $next, $weight, $size) > $width) {
                $lines[] = $line;
                $line = $word;
            } else {
                $line = $next;
            }
        }
        if ($line !== '') {
            $lines[] = $line;
        }
        $pdf->SetTextColor(0x33, 0x29, 0x1F);
        foreach ($lines as $l) {
            $cx = $x + ($width - PdfText::widthOf($pdf, $l, $weight, $size)) / 2;
            foreach (PdfText::runs($l) as $r) {
                $face = PdfText::face($weight, $r['cyr']);
                $pdf->SetFont($face, '', $size);
                $pdf->Text($cx, $y, $r['s']);
                $cx += $pdf->GetStringWidth($r['s'], $face, '', $size);
            }
            $y += $size * 1.35;
        }

        return $y;
    }

    /** The directory of the TCPDF font files, built once (flock'ed: every Octane thread may get here first). */
    public static function fontDir(): string
    {
        $dir = rtrim((string) config('agrotrace.pdf.font_cache', sys_get_temp_dir().'/agrotrace-fonts'), '/');
        if (self::built($dir)) {
            return $dir;
        }
        if (! is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $lock = fopen("{$dir}/.lock", 'c');
        if ($lock === false) {
            throw new RuntimeException("cannot open {$dir}/.lock");
        }
        try {
            flock($lock, LOCK_EX);
            foreach (PdfText::FONTS as $key => [$pkg, $file]) {
                if (is_file("{$dir}/{$key}.php")) {
                    continue;
                }
                $woff = @file_get_contents(self::sourceDir()."/{$pkg}/files/{$file}.woff");
                if ($woff === false) {
                    throw new RuntimeException("font {$pkg}/{$file}.woff not found under ".self::sourceDir());
                }
                $ttf = "{$dir}/{$key}.ttf";
                file_put_contents($ttf, Woff::toSfnt($woff));
                // The cyrillic subsets have no "x", which TCPDF reads for the x-height metric only (a warning,
                // nothing the label uses): silenced for this build-time conversion.
                if (@TCPDF_FONTS::addTTFfont($ttf, 'TrueTypeUnicode', '', 32, "{$dir}/") !== $key) {
                    throw new RuntimeException("TCPDF could not convert {$file}");
                }
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }

        return $dir;
    }

    private static function built(string $dir): bool
    {
        foreach (array_keys(PdfText::FONTS) as $key) {
            if (! is_file("{$dir}/{$key}.php")) {
                return false;
            }
        }

        return true;
    }

    /** The @fontsource packages: the image's copy, else the repository's (backend-express/node_modules). */
    private static function sourceDir(): string
    {
        $configured = config('agrotrace.pdf.fonts_dir');
        if (is_string($configured) && $configured !== '') {
            return rtrim($configured, '/');
        }
        $image = resource_path('fonts');

        return is_dir($image) ? $image : base_path('../backend-express/node_modules/@fontsource');
    }
}
