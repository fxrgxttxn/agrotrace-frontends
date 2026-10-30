<?php

/*
 * File types by signature and the raster pipeline (FR-FILE-02/04): WebP 96/480 on the longer side, never enlarged;
 * a forged signature or a format other than the signature's → 415; more than 40 megapixels in the header → 415
 * without decoding; EXIF orientation applied.
 */

use App\Http\Problem\Problem;
use App\Infrastructure\Images\DecodeSlots;
use App\Infrastructure\Images\Images;
use Tests\TestCase;

uses(TestCase::class);

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

/** A 40×20 JPEG of four quadrants (TL red, TR green, BL blue, BR white) with EXIF orientation $o. */
function quadrantJpeg(int $o): string
{
    $img = imagecreatetruecolor(40, 20);
    imagefilledrectangle($img, 0, 0, 19, 9, imagecolorallocate($img, 255, 0, 0));
    imagefilledrectangle($img, 20, 0, 39, 9, imagecolorallocate($img, 0, 255, 0));
    imagefilledrectangle($img, 0, 10, 19, 19, imagecolorallocate($img, 0, 0, 255));
    imagefilledrectangle($img, 20, 10, 39, 19, imagecolorallocate($img, 255, 255, 255));
    ob_start();
    imagejpeg($img, null, 95);
    $jpeg = (string) ob_get_clean();
    $tiff = 'MM'.pack('n', 42).pack('N', 8).pack('n', 1).pack('nnN', 0x0112, 3, 1).pack('nn', $o, 0).pack('N', 0);
    $app1 = "\xFF\xE1".pack('n', 2 + 6 + strlen($tiff))."Exif\0\0".$tiff;

    return substr($jpeg, 0, 2).$app1.substr($jpeg, 2);
}

/** "WxH TL TR BL BR" of a WebP, each corner named R/G/B/W by its dominant channels (2 px in from the edge). */
function corners(string $webp): string
{
    $img = imagecreatefromstring($webp);
    $w = imagesx($img);
    $h = imagesy($img);
    $name = function (int $x, int $y) use ($img): string {
        $c = imagecolorat($img, $x, $y);
        [$r, $g] = [($c >> 16) & 0xFF, ($c >> 8) & 0xFF];

        return $r > 128 ? ($g > 128 ? 'W' : 'R') : ($g > 128 ? 'G' : 'B');
    };

    return "{$w}x{$h} ".$name(2, 2).$name($w - 3, 2).$name(2, $h - 3).$name($w - 3, $h - 3);
}

// Expected corners taken once from sharp's `.rotate()` (the Express pipeline) on these same JPEGs (fix round 1, I1).
dataset('exif orientations', [
    [1, '40x20 RGBW'], [2, '40x20 GRWB'], [3, '40x20 WBGR'], [4, '40x20 BWRG'],
    [5, '20x40 RBGW'], [6, '20x40 BRWG'], [7, '20x40 WGBR'], [8, '20x40 GWRB'],
]);

it('orients every EXIF value 1–8 exactly as sharp does', function (int $o, string $expected) {
    expect(corners(Images::variants(quadrantJpeg($o), 'image/jpeg')[480]['bytes']))->toBe($expected);
})->with('exif orientations');

it('decodes under the container-wide slot bound (M1): the slot is held during the work and freed after', function () {
    $dir = sys_get_temp_dir().'/agrotrace-decode-test-'.getmypid();
    config(['agrotrace.images.decode_slots' => 1, 'agrotrace.images.decode_slots_dir' => $dir]);
    $probe = function () use ($dir): bool {
        $h = fopen("{$dir}/slot-0", 'c');
        $free = flock($h, LOCK_EX | LOCK_NB);
        $free && flock($h, LOCK_UN);
        fclose($h);

        return $free;
    };
    expect(DecodeSlots::with(fn () => $probe()))->toBeFalse();
    expect($probe())->toBeTrue();
    expect(fn () => DecodeSlots::with(fn () => throw new RuntimeException('x')))->toThrow(RuntimeException::class);
    expect($probe())->toBeTrue();
    expect(webpDims(Images::variants(gdImage(10, 10, 'png'), 'image/png')[96]['bytes']))->toBe(['image/webp', 10, 10]);
});

it('reads a damaged JPEG as sharp failOn error does: truncated or no EOI → 415, corrupt data → accepted (M6)', function () {
    $img = imagecreatetruecolor(300, 200);
    for ($i = 0; $i < 300; $i += 7) {
        imagefilledrectangle($img, $i, 0, $i + 3, 199, imagecolorallocate($img, $i % 255, 80, 200));
    }
    ob_start();
    imagejpeg($img, null, 90);
    $jpeg = (string) ob_get_clean();
    $refused = fn (string $b) => expect(fn () => Images::variants($b, 'image/jpeg'))
        ->toThrow(fn (Problem $p) => expect($p->status)->toBe(415));
    $refused(substr($jpeg, 0, intdiv(strlen($jpeg), 2)));
    $refused(substr($jpeg, 0, -2));
    $garbled = $jpeg;
    for ($k = 400; $k < 600; $k++) {
        $garbled[$k] = "\x00";
    }
    expect(webpDims(Images::variants($garbled, 'image/jpeg')[480]['bytes']))->toBe(['image/webp', 300, 200]);
});
