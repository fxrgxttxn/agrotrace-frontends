<?php

/*
 * File types by signature and the raster pipeline (FR-FILE-02/04): WebP 96/480 on the longer side, never enlarged;
 * a forged signature or a format other than the signature's → 415; more than 40 megapixels in the header → 415
 * without decoding; EXIF orientation applied.
 */

use App\Http\Problem\Problem;
use App\Infrastructure\Images\Images;

function gdImage(int $w, int $h, string $format): string
{
    $img = imagecreatetruecolor($w, $h);
    imagefill($img, 0, 0, imagecolorallocate($img, 120, 170, 80));
    ob_start();
    match ($format) {
        'png' => imagepng($img),
        'jpeg' => imagejpeg($img),
        'webp' => imagewebp($img),
    };

    return (string) ob_get_clean();
}

function webpDims(string $b): array
{
    $info = getimagesizefromstring($b);

    return [$info['mime'], $info[0], $info[1]];
}

it('sniffs JPEG, PNG, WebP, PDF and SVG by content only', function () {
    expect(Images::sniff(gdImage(4, 4, 'jpeg')))->toBe('image/jpeg');
    expect(Images::sniff(gdImage(4, 4, 'png')))->toBe('image/png');
    expect(Images::sniff(gdImage(4, 4, 'webp')))->toBe('image/webp');
    expect(Images::sniff("%PDF-1.7\n"))->toBe('application/pdf');
    expect(Images::sniff("\u{FEFF}<?xml version=\"1.0\"?>\n<!-- c -->\n<!DOCTYPE svg>\n<svg xmlns=\"x\"/>"))->toBe('image/svg+xml');
    expect(Images::sniff('<svgx/>'))->toBeNull();
    expect(Images::sniff('<html><svg/></html>'))->toBeNull();
    expect(Images::sniff('just text'))->toBeNull();
    expect(Images::sniff("<svg \0"))->toBeNull();
    expect(Images::sniff(''))->toBeNull();
});

it('makes WebP 96 and 480 on the longer side and never enlarges', function () {
    $big = Images::variants(gdImage(1000, 500, 'png'), 'image/png');
    expect(webpDims($big[480]['bytes']))->toBe(['image/webp', 480, 240]);
    expect(webpDims($big[96]['bytes']))->toBe(['image/webp', 96, 48]);
    expect($big[480]['sha256'])->toBe(hash('sha256', $big[480]['bytes']));
    expect($big[96]['size'])->toBe(strlen($big[96]['bytes']));
    $small = Images::variants(gdImage(50, 80, 'jpeg'), 'image/jpeg');
    expect(webpDims($small[480]['bytes']))->toBe(['image/webp', 50, 80]);
    expect(webpDims($small[96]['bytes']))->toBe(['image/webp', 50, 80]);
});

it('refuses a forged signature and a format other than the signature named', function () {
    expect(fn () => Images::variants("\x89PNG\r\n\x1a\nnot an image", 'image/png'))->toThrow(Problem::class);
    expect(fn () => Images::variants(gdImage(10, 10, 'jpeg'), 'image/png'))
        ->toThrow(fn (Problem $p) => expect([$p->status, $p->params])->toBe([415, ['allowed' => Images::RASTER]]));
});

it('refuses more than 40 megapixels from the header alone', function () {
    // A PNG signature and an IHDR of 10 000 × 5 000 (50 Mpx) with a valid CRC — no image data at all.
    $ihdr = 'IHDR'.pack('NNCCCCC', 10000, 5000, 8, 2, 0, 0, 0);
    $png = "\x89PNG\r\n\x1a\n".pack('N', 13).$ihdr.pack('N', crc32($ihdr));
    $started = microtime(true);
    expect(fn () => Images::variants($png, 'image/png'))->toThrow(Problem::class);
    expect(microtime(true) - $started)->toBeLessThan(0.1);
});

it('applies the EXIF orientation of a JPEG (6: rotate 90° clockwise)', function () {
    $jpeg = gdImage(40, 20, 'jpeg');
    // APP1 Exif, big-endian TIFF, IFD0 with one entry: Orientation (0x0112) SHORT 1 = 6.
    $tiff = 'MM'.pack('n', 42).pack('N', 8).pack('n', 1).pack('nnN', 0x0112, 3, 1).pack('nn', 6, 0).pack('N', 0);
    $app1 = "\xFF\xE1".pack('n', 2 + 6 + strlen($tiff))."Exif\0\0".$tiff;
    $oriented = substr($jpeg, 0, 2).$app1.substr($jpeg, 2);
    expect(Images::exifOrientation($oriented))->toBe(6);
    expect(webpDims(Images::variants($oriented, 'image/jpeg')[480]['bytes']))->toBe(['image/webp', 20, 40]);
    expect(Images::exifOrientation($jpeg))->toBe(1);
});
