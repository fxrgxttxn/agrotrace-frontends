<?php

namespace App\Infrastructure\Qr;

use BaconQrCode\Common\ErrorCorrectionLevel;
use BaconQrCode\Encoder\Encoder;
use GdImage;
use RuntimeException;

/**
 * QR code PNG of a batch (createBatchQr, R43; Express infra/qr.ts, the seed's `qrPng`): the public page URL
 * `{PUBLIC_BASE_URL}/p/{publicCode}` at error correction level M, exactly 1024 × 1024 px, black on white, a 4-module
 * quiet zone. The matrix is bacon/bacon-qr-code's; it is drawn as node-qrcode draws it (`qrToImageData`): the
 * fractional scale 1024 / (modules + 8), pixel (i, j) takes module floor((i − 4·scale) / scale) — so the module edges
 * fall on the same pixels as Express's.
 */
final class Qr
{
    public const SIZE_PX = 1024;

    public const MARGIN_MODULES = 4;

    /** `{PUBLIC_BASE_URL}/p/{publicCode}` (QrLinks.publicUrl; the base may carry a path, never a trailing `/`, R50). */
    public static function publicPageUrl(string $publicBaseUrl, string $publicCode): string
    {
        return rtrim($publicBaseUrl, '/')."/p/{$publicCode}";
    }

    public static function png(string $url): string
    {
        $matrix = Encoder::encode($url, ErrorCorrectionLevel::M(), 'UTF-8', null, false)->getMatrix();
        $modules = $matrix->getWidth();
        $scale = self::SIZE_PX / ($modules + 2 * self::MARGIN_MODULES);
        $margin = self::MARGIN_MODULES * $scale;
        // The pixel span of every module: [first, last] of the pixels that map to it.
        $span = [];
        for ($px = 0; $px < self::SIZE_PX; $px++) {
            if ($px < $margin || $px >= self::SIZE_PX - $margin) {
                continue;
            }
            $m = (int) floor(($px - $margin) / $scale);
            if ($m >= $modules) {
                continue;
            }
            $span[$m] ??= [$px, $px];
            $span[$m][1] = $px;
        }
        $img = imagecreate(self::SIZE_PX, self::SIZE_PX);
        if (! $img instanceof GdImage) {
            throw new RuntimeException('GD cannot allocate the QR image');
        }
        imagecolorallocate($img, 255, 255, 255);
        $black = (int) imagecolorallocate($img, 0, 0, 0);
        for ($y = 0; $y < $modules; $y++) {
            for ($x = 0; $x < $modules; $x++) {
                if ($matrix->get($x, $y) === 1 && isset($span[$x], $span[$y])) {
                    imagefilledrectangle($img, $span[$x][0], $span[$y][0], $span[$x][1], $span[$y][1], $black);
                }
            }
        }
        // GD closes a stream it is given, so the PNG is taken from an output buffer (as Images does with WebP).
        ob_start();
        try {
            imagepng($img, null, 9);
        } finally {
            $png = (string) ob_get_clean();
        }
        if (imagesx($img) !== self::SIZE_PX || imagesy($img) !== self::SIZE_PX) {
            throw new RuntimeException('the QR image is not 1024 × 1024');
        }

        return $png;
    }
}
