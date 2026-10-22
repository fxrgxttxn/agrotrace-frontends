<?php

namespace App\Infrastructure\Images;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use GdImage;

/**
 * Uploaded file types and the image pipeline (FR-FILE-02/04, spec 8.6; Express infra/images.ts):
 * - the type comes from the content only (magic bytes): JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP
 *   `RIFF????WEBP`, PDF `%PDF-`, SVG — UTF-8 text without NUL whose first element (after a BOM, XML declaration,
 *   comments, doctype) is `<svg`;
 * - raster images become WebP variants of 96 and 480 px on the longer side (GD): EXIF orientation applied, never
 *   enlarged, quality 80; each with its own sha256 and size (`files.variants`, R34);
 * - the header's dimensions are checked before decoding (more than 40 megapixels → 415: no decompression bomb), and
 *   the decoded format must be the one the signature named (a forged signature → 415 `{allowed}`).
 */
final class Images
{
    public const RASTER = ['image/jpeg', 'image/png', 'image/webp'];

    public const VARIANTS = [96, 480];

    private const MAX_PIXELS = 40_000_000;

    private const GD_TYPE = ['image/jpeg' => IMAGETYPE_JPEG, 'image/png' => IMAGETYPE_PNG, 'image/webp' => IMAGETYPE_WEBP];

    public static function sniff(string $b): ?string
    {
        if (strlen($b) >= 3 && str_starts_with($b, "\xFF\xD8\xFF")) {
            return 'image/jpeg';
        }
        if (str_starts_with($b, "\x89PNG\r\n\x1A\n")) {
            return 'image/png';
        }
        if (strlen($b) >= 12 && substr($b, 0, 4) === 'RIFF' && substr($b, 8, 4) === 'WEBP') {
            return 'image/webp';
        }
        if (str_starts_with($b, '%PDF-')) {
            return 'application/pdf';
        }

        return self::looksLikeSvg($b) ? 'image/svg+xml' : null;
    }

    /** SVG: after the prolog (BOM, `<?xml … ?>`, comments, `<!DOCTYPE …>`, white space) the root element is `svg`. */
    public static function looksLikeSvg(string $b): bool
    {
        if (str_contains($b, "\0")) {
            return false;
        }
        $s = mb_convert_encoding(substr($b, 0, 4096), 'UTF-8', 'UTF-8'); // invalid sequences → '?', as a lossy decode
        if (str_starts_with($s, "\u{FEFF}")) {
            $s = substr($s, 3);
        }
        for (; ;) {
            $t = ltrim($s, " \t\n\r\f\v");
            if ($t !== $s) {
                $s = $t;

                continue;
            }
            if (str_starts_with($s, '<?xml')) {
                $end = strpos($s, '?>');
                $gt = strpos($s, '>');
                if ($end === false || $gt === false || $gt < $end + 1) {
                    break;
                }
                $s = substr($s, $end + 2);

                continue;
            }
            if (str_starts_with($s, '<!--')) {
                $end = strpos($s, '-->', 4);
                if ($end === false) {
                    break;
                }
                $s = substr($s, $end + 3);

                continue;
            }
            if (strncasecmp($s, '<!DOCTYPE', 9) === 0) {
                $end = self::doctypeEnd($s);
                if ($end === null) {
                    break;
                }
                $s = substr($s, $end);

                continue;
            }
            break;
        }

        return str_starts_with($s, '<svg') && strlen($s) > 4 && in_array($s[4], [' ', "\t", "\n", "\r", "\f", "\v", '>', '/'], true);
    }

    /** End offset of `<!DOCTYPE …>` with an optional internal subset `[…]`, or null. */
    private static function doctypeEnd(string $s): ?int
    {
        $bracket = strpos($s, '[');
        $gt = strpos($s, '>');
        if ($gt === false) {
            return null;
        }
        if ($bracket !== false && $bracket < $gt) {
            $close = strpos($s, ']', $bracket);
            if ($close === false) {
                return null;
            }
            $gt2 = strpos($s, '>', $close);
            if ($gt2 === false || trim(substr($s, $close + 1, $gt2 - $close - 1)) !== '') {
                return null;
            }

            return $gt2 + 1;
        }

        return $gt + 1;
    }

    /**
     * WebP 96 and 480 of a raster image whose signature said $mime.
     *
     * @param  list<string>  $allowed  for the 415 `params.allowed`
     * @return array<int, array{bytes: string, sha256: string, size: int}>
     */
    public static function variants(string $bytes, string $mime, array $allowed = self::RASTER): array
    {
        $unsupported = fn () => new Problem(415, ProblemCode::UNSUPPORTED_MEDIA_TYPE, params: ['allowed' => $allowed]);
        $info = @getimagesizefromstring($bytes);
        if ($info === false || $info[2] !== (self::GD_TYPE[$mime] ?? -1) || $info[0] < 1 || $info[1] < 1) {
            throw $unsupported();
        }
        if ($info[0] * $info[1] > self::MAX_PIXELS) {
            throw $unsupported();
        }

        // The header checks above are cheap; decoding, resizing and encoding run under the container's bound (M1).
        return DecodeSlots::with(fn () => self::decodeAndEncode($bytes, $mime, $unsupported));
    }

    /**
     * @param  callable(): Problem  $unsupported
     * @return array<int, array{bytes: string, sha256: string, size: int}>
     */
    private static function decodeAndEncode(string $bytes, string $mime, callable $unsupported): array
    {
        $img = $mime === 'image/jpeg' ? self::decodeJpeg($bytes) : @imagecreatefromstring($bytes);
        if (! $img instanceof GdImage) {
            throw $unsupported();
        }
        try {
            if ($mime === 'image/jpeg') {
                $img = self::orient($img, self::exifOrientation($bytes));
            }
            if (! imageistruecolor($img)) {
                imagepalettetotruecolor($img);
            }
            $out = [];
            foreach (self::VARIANTS as $size) {
                $body = self::webp($img, $size);
                if ($body === null) {
                    throw $unsupported();
                }
                $out[$size] = ['bytes' => $body, 'sha256' => hash('sha256', $body), 'size' => strlen($body)];
            }

            return $out;
        } finally {
            imagedestroy($img);
        }
    }

    /**
     * A JPEG as sharp `failOn: 'error'` reads it (review M6, compared through both APIs): a truncated file (libjpeg
     * "Premature end of JPEG file", also a missing EOI) is refused, while other recoverable libjpeg warnings (corrupt
     * data, extraneous bytes) are accepted. imagecreatefromstring ignores gd.jpeg_ignore_warning, so the strict pass
     * reads a temporary file with imagecreatefromjpeg.
     */
    private static function decodeJpeg(string $bytes): GdImage|false
    {
        $path = tempnam(sys_get_temp_dir(), 'jpeg');
        if ($path === false || file_put_contents($path, $bytes) !== strlen($bytes)) {
            return @imagecreatefromstring($bytes);
        }
        $messages = [];
        $previous = ini_set('gd.jpeg_ignore_warning', '0');
        set_error_handler(function (int $no, string $message) use (&$messages): bool {
            $messages[] = $message;

            return true;
        });
        try {
            $img = imagecreatefromjpeg($path);
        } finally {
            restore_error_handler();
            ini_set('gd.jpeg_ignore_warning', $previous === false ? '1' : $previous);
            @unlink($path);
        }
        if ($img instanceof GdImage) {
            return $img;
        }
        foreach ($messages as $m) {
            if (str_contains($m, 'Premature end of JPEG file')) {
                return false;
            }
        }

        return @imagecreatefromstring($bytes);
    }

    /** Fit inside size×size, never enlarged (sharp `fit: inside, withoutEnlargement`), WebP q80 with alpha kept. */
    private static function webp(GdImage $src, int $size): ?string
    {
        $w = imagesx($src);
        $h = imagesy($src);
        $scale = min(1.0, $size / max($w, $h));
        $nw = max(1, (int) round($w * $scale));
        $nh = max(1, (int) round($h * $scale));
        $dst = imagecreatetruecolor($nw, $nh);
        if ($dst === false) {
            return null;
        }
        try {
            imagealphablending($dst, false);
            imagesavealpha($dst, true);
            imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
            if ($nw === $w && $nh === $h) {
                imagecopy($dst, $src, 0, 0, 0, 0, $w, $h);
            } else {
                imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $w, $h);
            }
            ob_start();
            $ok = imagewebp($dst, null, 80);
            $body = (string) ob_get_clean();

            return $ok && $body !== '' ? $body : null;
        } finally {
            imagedestroy($dst);
        }
    }

    /** EXIF orientation 1–8 of a JPEG (APP1 `Exif`, tag 0x0112), 1 when absent — no ext-exif needed. */
    public static function exifOrientation(string $jpeg): int
    {
        $n = strlen($jpeg);
        $i = 2;
        while ($i + 4 <= $n && $jpeg[$i] === "\xFF") {
            $marker = ord($jpeg[$i + 1]);
            if ($marker === 0xD9 || $marker === 0xDA) {
                break;
            }
            $len = unpack('n', substr($jpeg, $i + 2, 2))[1];
            if ($marker === 0xE1 && substr($jpeg, $i + 4, 6) === "Exif\0\0") {
                return self::tiffOrientation(substr($jpeg, $i + 10, $len - 8));
            }
            $i += 2 + $len;
        }

        return 1;
    }

    private static function tiffOrientation(string $t): int
    {
        if (strlen($t) < 8) {
            return 1;
        }
        $le = substr($t, 0, 2) === 'II';
        $u16 = fn (int $o) => $o + 2 <= strlen($t) ? unpack($le ? 'v' : 'n', substr($t, $o, 2))[1] : 0;
        $u32 = fn (int $o) => $o + 4 <= strlen($t) ? unpack($le ? 'V' : 'N', substr($t, $o, 4))[1] : 0;
        $ifd = $u32(4);
        $count = $u16($ifd);
        for ($k = 0; $k < $count && $k < 512; $k++) {
            $e = $ifd + 2 + 12 * $k;
            if ($u16($e) === 0x0112) {
                $v = $u16($e + 8);

                return $v >= 1 && $v <= 8 ? $v : 1;
            }
        }

        return 1;
    }

    /** Applies an EXIF orientation (sharp's `.rotate()` without arguments). */
    private static function orient(GdImage $img, int $o): GdImage
    {
        if ($o === 1) {
            return $img;
        }
        $rotated = match ($o) {
            3 => imagerotate($img, 180, 0),
            6 => imagerotate($img, -90, 0),
            8 => imagerotate($img, 90, 0),
            default => $img,
        };
        if ($rotated instanceof GdImage && $rotated !== $img) {
            imagedestroy($img);
            $img = $rotated;
        }
        if ($o === 2 || $o === 5 || $o === 7) {
            imageflip($img, IMG_FLIP_HORIZONTAL);
        } elseif ($o === 4) {
            imageflip($img, IMG_FLIP_VERTICAL);
        }
        // 5 (transpose) = mirror, then 90° counter-clockwise; 7 (transverse) = mirror, then 90° clockwise — GD's
        // imagerotate turns counter-clockwise for a positive angle (pinned against sharp in ImagesTest).
        if ($o === 5 || $o === 7) {
            $r = imagerotate($img, $o === 5 ? 90 : -90, 0);
            if ($r instanceof GdImage) {
                imagedestroy($img);
                $img = $r;
            }
        }

        return $img;
    }
}
