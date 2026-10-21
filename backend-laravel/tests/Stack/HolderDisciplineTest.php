<?php

/*
 * P61 holder discipline under load, against the running api-laravel (dev DB, demo users of the seed): 40 parallel
 * heavy avatar uploads by ONE user (decoding, two WebP variants, MinIO puts — all done with no DB slot held) while
 * other users keep calling cheap DB-backed operations (getMe, getMyChannels, listOrganizations). None of the others
 * may get a 503 BACKEND_UNAVAILABLE (DB_SLOTS = 11 « 40), and their latency stays bounded. The numbers are printed.
 * The uploader (koltso.head) has no seeded avatar; it is deleted again at the end.
 */

beforeEach(function () {
    if (! getenv('STACK_API')) {
        $this->markTestSkipped('STACK_API (host:port of api-laravel) is not set');
    }
});

function stackUrl(string $path): string
{
    return 'http://'.getenv('STACK_API').'/api/v1'.$path;
}

function stackLogin(string $email): string
{
    $ch = curl_init(stackUrl('/auth/login'));
    curl_setopt_array($ch, [
        CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ['content-type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['email' => $email, 'password' => 'agrotrace-demo']),
    ]);
    $body = json_decode((string) curl_exec($ch), true);
    expect(curl_getinfo($ch, CURLINFO_RESPONSE_CODE))->toBe(200);

    return $body['accessToken'];
}

/** A ~1.9 MB JPEG of noise (expensive to decode and resize, under the 2 MiB limit). */
function heavyJpeg(): string
{
    $img = imagecreatetruecolor(1400, 1400);
    for ($y = 0; $y < 1400; $y += 2) {
        for ($x = 0; $x < 1400; $x += 2) {
            imagefilledrectangle($img, $x, $y, $x + 1, $y + 1, random_int(0, 0xFFFFFF));
        }
    }
    for ($q = 95; $q > 10; $q -= 5) {
        ob_start();
        imagejpeg($img, null, $q);
        $jpeg = (string) ob_get_clean();
        if (strlen($jpeg) <= 2 * 1024 * 1024) {
            return $jpeg;
        }
    }

    return $jpeg;
}

it('40 parallel heavy uploads of one user leave other users fast and never 503', function () {
    $uploader = stackLogin('koltso.head@agrotrace.test');
    $others = array_map('stackLogin', ['molkombinat.technolog@agrotrace.test', 'vetlab.analyst@agrotrace.test', 'support@agrotrace.test']);
    $jpeg = heavyJpeg();
    $boundary = 'probe'.bin2hex(random_bytes(8));
    $body = "--{$boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"heavy.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n{$jpeg}\r\n--{$boundary}--\r\n";

    // 40 uploads in flight at every moment, 90 in all (a new one starts whenever one finishes) — under the uploader's
    // `user` limit of 100 per minute, from the start of a fresh window.
    $left = 60 - time() % 60;
    if ($left < 20) {
        sleep($left + 1);
    }
    $mh = curl_multi_init();
    $uploads = [];
    $launch = function () use ($mh, &$uploads, $body, $uploader, $boundary): void {
        $ch = curl_init(stackUrl('/me/avatar'));
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => 'PUT', CURLOPT_RETURNTRANSFER => true, CURLOPT_POSTFIELDS => $body, CURLOPT_TIMEOUT => 120,
            CURLOPT_HTTPHEADER => ["authorization: Bearer {$uploader}", "content-type: multipart/form-data; boundary={$boundary}"],
        ]);
        curl_multi_add_handle($mh, $ch);
        $uploads[] = $ch;
    };
    for ($i = 0; $i < 40; $i++) {
        $launch();
    }
    $paths = ['/me', '/me/channels', '/organizations?size=5'];
    $probes = [];
    $started = microtime(true);
    $next = $started + 0.05;
    $k = 0;
    // The other users' requests run on a second multi handle, one at a time, so the uploads keep streaming while a
    // probe waits (a blocking curl_exec here would stall the upload bodies and measure the client, not the server).
    $pm = curl_multi_init();
    $probe = null;
    do {
        curl_multi_exec($mh, $running);
        while (($done = curl_multi_info_read($mh)) !== false) {
            if (count($uploads) < 90) {
                $launch();
                $running++;
            }
        }
        if ($probe === null && microtime(true) >= $next && $running > 0) {
            $ch = curl_init(stackUrl($paths[$k % 3]));
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
                CURLOPT_HTTPHEADER => ['authorization: Bearer '.$others[$k % 3]]]);
            curl_multi_add_handle($pm, $ch);
            $probe = [$ch, microtime(true)];
            $k++;
        }
        if ($probe !== null) {
            curl_multi_exec($pm, $probeRunning);
            if ($probeRunning === 0) {
                $probes[] = [curl_getinfo($probe[0], CURLINFO_RESPONSE_CODE), microtime(true) - $probe[1]];
                curl_multi_remove_handle($pm, $probe[0]);
                $probe = null;
                $next = microtime(true) + 0.01;
            }
        }
        curl_multi_select($mh, 0.005);
    } while ($running > 0 || $probe !== null);
    curl_multi_close($pm);
    $wall = microtime(true) - $started;
    $uploadStatus = array_count_values(array_map(fn ($ch) => curl_getinfo($ch, CURLINFO_RESPONSE_CODE), $uploads));
    $uploadTimes = array_map(fn ($ch) => curl_getinfo($ch, CURLINFO_TOTAL_TIME), $uploads);
    curl_multi_close($mh);

    // Clean up: the uploader had no avatar before.
    $del = curl_init(stackUrl('/me/avatar'));
    curl_setopt_array($del, [CURLOPT_CUSTOMREQUEST => 'DELETE', CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ["authorization: Bearer {$uploader}"]]);
    curl_exec($del);

    $latencies = array_column($probes, 1);
    sort($latencies);
    $p = fn (float $q) => $latencies[(int) min(count($latencies) - 1, floor($q * count($latencies)))];
    fwrite(STDERR, sprintf(
        "\n[P61 probe] jpeg %d B; 90 uploads, 40 in flight: %s in %.2f s (each %.2f–%.2f s); others: %d requests, statuses %s, p50 %.0f ms, p95 %.0f ms, max %.0f ms\n",
        strlen($jpeg), json_encode($uploadStatus), $wall, min($uploadTimes), max($uploadTimes), count($probes),
        json_encode(array_count_values(array_column($probes, 0))), $p(0.5) * 1000, $p(0.95) * 1000, max($latencies) * 1000,
    ));
    expect(count($probes))->toBeGreaterThan(5);
    expect(array_unique(array_column($probes, 0)))->toBe([200]); // no 503 for anybody else
    expect($uploadStatus)->toBe([200 => 90]);
    expect(max($latencies))->toBeLessThan(3.0);
});
