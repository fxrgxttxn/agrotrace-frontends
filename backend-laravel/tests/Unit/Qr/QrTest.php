<?php

/*
 * QR (R43, Ruling Q1): the PNG is exactly 1024 × 1024, black on white, a 4-module quiet zone, level M (bacon's matrix,
 * drawn with node-qrcode's pixel mapping); the PDF is one A6 page with the Onest/JetBrains Mono label; the render lane
 * is bounded (slots, waiting cap, deadline → BackendUnavailable).
 */

use App\Infrastructure\Db\BackendUnavailable;
use App\Infrastructure\Pdf\LabelPdf;
use App\Infrastructure\Pdf\Woff;
use App\Infrastructure\Qr\Qr;
use App\Infrastructure\Qr\RenderLane;
use BaconQrCode\Common\ErrorCorrectionLevel;
use BaconQrCode\Encoder\Encoder;
use Tests\TestCase;

uses(TestCase::class);

const QR_URL = 'http://react-laravel.localhost/p/AT-2026-000123';

it('the public page URL is {PUBLIC_BASE_URL}/p/{publicCode}, without a doubled slash', function () {
    expect(Qr::publicPageUrl('http://x.localhost/', 'AT-2026-000001'))->toBe('http://x.localhost/p/AT-2026-000001');
    expect(Qr::publicPageUrl('http://x.localhost/base', 'AT-2026-000001'))->toBe('http://x.localhost/base/p/AT-2026-000001');
});

it('renders a 1024 × 1024 PNG, black on white, with a 4-module quiet zone, module for module the level-M matrix', function () {
    $png = Qr::png(QR_URL);
    expect(substr($png, 0, 8))->toBe("\x89PNG\r\n\x1a\n");
    expect(unpack('N', $png, 16)[1])->toBe(1024);
    expect(unpack('N', $png, 20)[1])->toBe(1024);
    $img = imagecreatefromstring($png);
    $matrix = Encoder::encode(QR_URL, ErrorCorrectionLevel::M(), 'UTF-8', null, false)->getMatrix();
    $n = $matrix->getWidth();
    $scale = 1024 / ($n + 8);
    $colors = [];
    $px = function (int $x, int $y) use ($img, &$colors): string {
        $c = imagecolorsforindex($img, imagecolorat($img, $x, $y));
        $hex = sprintf('%02x%02x%02x', $c['red'], $c['green'], $c['blue']);
        $colors[$hex] = true;

        return $hex;
    };
    // The quiet zone is white; every module's centre has the module's colour.
    foreach ([0, 10, (int) (4 * $scale) - 1, 1023] as $edge) {
        expect($px($edge, 512))->toBe('ffffff');
        expect($px(512, $edge))->toBe('ffffff');
    }
    for ($y = 0; $y < $n; $y++) {
        for ($x = 0; $x < $n; $x++) {
            $cx = (int) floor((4 + $x + 0.5) * $scale);
            $cy = (int) floor((4 + $y + 0.5) * $scale);
            expect($px($cx, $cy))->toBe($matrix->get($x, $y) === 1 ? '000000' : 'ffffff');
        }
    }
    expect(array_keys($colors))->toEqualCanonicalizing(['000000', 'ffffff']);
    expect($matrix->get(0, 0))->toBe(1); // a finder pattern corner
});

it('unwraps the design-system WOFF fonts into sfnt fonts', function () {
    $woff = file_get_contents(base_path('../backend-express/node_modules/@fontsource/onest/files/onest-cyrillic-400-normal.woff'));
    $ttf = Woff::toSfnt($woff);
    expect(substr($ttf, 0, 4))->toBe(substr($woff, 4, 4));
    expect(unpack('n', $ttf, 4)[1])->toBe(unpack('n', $woff, 12)[1]);
    expect(fn () => Woff::toSfnt('nope'))->toThrow(RuntimeException::class);
});

it('the label is one A6 page (105 × 148 mm) with the QR and the fonts embedded', function () {
    $pdf = LabelPdf::qrLabel('AT-2026-000123', 'Говядина охлаждённая высшего сорта', 'КФХ «Петров» — Fresh Farm №1', Qr::png(QR_URL), 1790000000);
    expect(substr($pdf, 0, 5))->toBe('%PDF-');
    preg_match_all('#/Type\s*/Page\b#', $pdf, $pages);
    expect(count($pages[0]))->toBe(1);
    preg_match('#/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]#', $pdf, $box);
    expect(abs((float) $box[3] - 297.638))->toBeLessThan(1.5); // 105 mm
    expect(abs((float) $box[4] - 419.528))->toBeLessThan(1.5); // 148 mm
    expect($pdf)->toContain('/Subtype /Image');
    // Embedded TrueType faces: mono latin (the code), bold cyrillic (the product), regular cyrillic + latin (origin).
    preg_match_all('#/FontFile2#', $pdf, $files);
    expect(count($files[0]))->toBeGreaterThanOrEqual(4);
    expect($pdf)->toContain('Onest')->toContain('JetBrains');
});

it('the render lane bounds the running renders and the waiters; a full queue or a missed deadline is BackendUnavailable', function () {
    $dir = sys_get_temp_dir().'/at-qr-lane-'.bin2hex(random_bytes(3));
    // A separate process holds the only slot.
    @mkdir($dir, 0777, true);
    $proc = proc_open([PHP_BINARY, '-r', '$h = fopen($argv[1], "c"); flock($h, LOCK_EX); echo "held\n"; usleep(3000000);', "{$dir}/slot-0"],
        [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
    expect(fgets($pipes[1]))->toBe("held\n");
    $started = microtime(true);
    expect(fn () => RenderLane::with(fn () => 1, $dir, 1, 0.3))->toThrow(BackendUnavailable::class, 'no slot within');
    expect(microtime(true) - $started)->toBeGreaterThan(0.29)->toBeLessThan(0.8);
    // Every waiting slot taken → refused at once.
    $waiters = [];
    for ($i = 0; $i < RenderLane::WAITING; $i++) {
        $h = fopen("{$dir}/wait-{$i}", 'c');
        flock($h, LOCK_EX);
        $waiters[] = $h;
    }
    $started = microtime(true);
    expect(fn () => RenderLane::with(fn () => 1, $dir, 1, 5.0))->toThrow(BackendUnavailable::class, 'already waiting');
    expect(microtime(true) - $started)->toBeLessThan(0.05);
    foreach ($waiters as $h) {
        flock($h, LOCK_UN);
        fclose($h);
    }
    proc_terminate($proc, 9);
    fclose($pipes[1]);
    proc_close($proc);
    expect(RenderLane::with(fn () => 'ran', $dir, 1, 1.0))->toBe('ran');
});
