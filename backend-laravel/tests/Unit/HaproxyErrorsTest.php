<?php

/*
 * docker/haproxy-errors/*.http (review M1): HAProxy's own answers (FrankenPHP down or restarting, timeouts) are
 * complete HTTP responses that are contract problems — status line = body status, type = /problems/<kebab(code)>, a
 * code of the contract, the exact Content-Length, X-Backend.
 */

use App\Http\Problem\ProblemCode;

it('holds a contract problem for every error status HAProxy can produce', function (int $code) {
    $file = dirname(__DIR__, 2)."/docker/haproxy-errors/{$code}.http";
    $raw = file_get_contents($file);
    [$head, $body] = explode("\r\n\r\n", $raw, 2);
    $lines = explode("\r\n", $head);
    expect($lines[0])->toStartWith("HTTP/1.1 {$code} ");
    $headers = [];
    foreach (array_slice($lines, 1) as $l) {
        [$k, $v] = array_map('trim', explode(':', $l, 2));
        $headers[strtolower($k)] = $v;
    }
    expect($headers['content-type'])->toBe('application/problem+json; charset=utf-8');
    expect($headers['x-backend'])->toBe('laravel');
    expect((int) $headers['content-length'])->toBe(strlen($body));
    $p = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    expect($p['status'])->toBe($code);
    expect(ProblemCode::from($p['code'])->type())->toBe($p['type']);
    expect($p['title'])->toBe(ProblemCode::from($p['code'])->title());
})->with([400, 408, 500, 502, 503, 504]);
