<?php

/*
 * The running api-laravel container through its HAProxy front (docker/haproxy-api.cfg) — what Pest's in-process
 * kernel cannot reach. Run against the stand:
 *   docker compose run --rm --no-deps -e STACK_API=api-laravel:8000 php-tools vendor/bin/pest tests/Stack
 * Skipped without STACK_API. Covers review I2 (malformed %-escapes answered as Express), I4 (413 at once, connection
 * closed), M1 (HAProxy's own errors as problem+json) and M2 (no Server / Cache-Control).
 */

beforeEach(function () {
    if (! getenv('STACK_API')) {
        $this->markTestSkipped('STACK_API (host:port of api-laravel) is not set');
    }
});

/**
 * One raw HTTP/1.1 exchange; returns [status, headers (lower-case), body, closedByServer, seconds].
 *
 * @return array{0: int, 1: array<string, string>, 2: string, 3: bool, 4: float}
 */
function exchange(string $head, string $body = '', float $wait = 5.0): array
{
    $t = microtime(true);
    $s = stream_socket_client('tcp://'.getenv('STACK_API'), $errno, $err, 3.0);
    expect($s)->not->toBeFalse($err);
    stream_set_timeout($s, (int) ceil($wait));
    fwrite($s, $head."\r\n\r\n".$body);
    $raw = '';
    $headEnd = false;
    $length = null;
    while (! feof($s) && microtime(true) - $t < $wait) {
        $chunk = fread($s, 65536);
        if ($chunk === false || ($chunk === '' && stream_get_meta_data($s)['timed_out'])) {
            break;
        }
        $raw .= $chunk;
        if ($headEnd === false && ($p = strpos($raw, "\r\n\r\n")) !== false) {
            $headEnd = $p;
            if (preg_match('/\r\ncontent-length:\s*(\d+)/i', substr($raw, 0, $p), $m)) {
                $length = (int) $m[1];
            }
        }
        if ($headEnd !== false && $length !== null && strlen($raw) >= $headEnd + 4 + $length) {
            break;
        }
    }
    $seconds = microtime(true) - $t;
    // After a full response: is the connection closed by the server?
    stream_set_timeout($s, 1);
    $more = fread($s, 1);
    $closed = feof($s) || ($more === '' && ! stream_get_meta_data($s)['timed_out']);
    fclose($s);
    expect($headEnd)->not->toBeFalse("no response head: {$raw}");
    $lines = explode("\r\n", substr($raw, 0, $headEnd));
    $status = (int) explode(' ', array_shift($lines))[1];
    $headers = [];
    foreach ($lines as $l) {
        [$k, $v] = array_map('trim', explode(':', $l, 2));
        $headers[strtolower($k)] = $v;
    }

    return [$status, $headers, substr($raw, $headEnd + 4), $closed, $seconds];
}

it('answers a malformed %-escape like Express: 405 + Allow for an undeclared method, else 404 (I2)', function () {
    foreach (['POST', 'OPTIONS'] as $m) {
        [$st, $h, $b] = exchange("{$m} /api/v1/batches/%zz HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close");
        expect($st)->toBe(405);
        expect($h['allow'])->toBe('GET');
        expect($h['x-backend'])->toBe('laravel');
        expect(json_decode($b, true)['code'])->toBe('METHOD_NOT_ALLOWED');
    }
    foreach (['GET /api/v1/batches/%zz', 'GET /api/v1/docs/%E0%A4%A', 'POST /api/v1/no/%zz', 'GET /api/v1/batches/%zz/documents'] as $line) {
        [$st, $h, $b] = exchange("{$line} HTTP/1.1\r\nHost: x\r\nX-Request-Id: probe-1\r\nContent-Length: 0\r\nConnection: close");
        expect($st)->toBe(404, $line);
        expect($h['x-request-id'])->toBe('probe-1');
        expect(json_decode($b, true)['code'])->toBe('NOT_FOUND');
    }
});

it('ignores a client-sent X-Agrotrace-Raw-Path', function () {
    [$st] = exchange("GET /api/v1/nope HTTP/1.1\r\nHost: x\r\nX-Agrotrace-Raw-Path: /api/v1/health/live\r\nConnection: close");
    expect($st)->toBe(404);
});

it('refuses a declared JSON body over 12 MiB at once, before the body, and closes the connection (I4)', function () {
    [$st, $h, $b, $closed, $sec] = exchange(
        "POST /api/v1/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 13000000\r\nX-Request-Id: big-1",
        '{"email":',
    );
    expect($st)->toBe(413);
    expect(json_decode($b, true))->toMatchArray(['code' => 'FILE_TOO_LARGE', 'params' => ['maxBytes' => 12582912]]);
    expect($h['x-backend'])->toBe('laravel');
    expect($h['x-request-id'])->toBe('big-1');
    expect(strtolower($h['connection'] ?? ''))->toBe('close');
    expect($closed)->toBeTrue();
    expect($sec)->toBeLessThan(2.0);
});

it('closes the connection after the application\'s own 413 (a chunked JSON body over the limit) (I4)', function () {
    $chunk = str_repeat('a', 1 << 20);
    $body = '';
    for ($i = 0; $i < 13; $i++) {
        $body .= dechex(strlen($chunk))."\r\n{$chunk}\r\n";
    }
    $body .= "0\r\n\r\n";
    [$st, $h, , $closed] = exchange(
        "POST /api/v1/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked",
        $body,
        20.0,
    );
    expect($st)->toBe(413);
    expect(strtolower($h['connection'] ?? ''))->toBe('close');
    expect($closed)->toBeTrue();
});

it('does not apply the JSON limit to other bodies (I5)', function () {
    [$st] = exchange("POST /api/v1/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 13000000", 'x', 2.0);
    expect($st)->not->toBe(413);
})->skip('the operation has no route yet (404 only after the body is read); covered in-process by JsonBodyTest');

it('answers what HAProxy cannot parse as a problem with X-Backend (M1)', function () {
    [$st, $h] = exchange("GET /api/v1/health/live\xFF HTTP/1.1\r\nHost: x");
    expect($st)->toBe(400);
    expect($h['content-type'])->toStartWith('application/problem+json');
})->skip('HAProxy 2.6 answers request-parsing errors of its H1 mux with its built-in page, ignoring errorfile; the errorfiles cover 502/503/504 (HaproxyErrorsTest)');

it('sends neither Server nor a default Cache-Control (M2)', function () {
    [$st, $h] = exchange("GET /api/v1/health/live HTTP/1.1\r\nHost: x\r\nConnection: close");
    expect($st)->toBe(200);
    expect($h)->not->toHaveKey('server');
    expect($h)->not->toHaveKey('cache-control');
});
