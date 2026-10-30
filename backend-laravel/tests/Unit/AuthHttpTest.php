<?php

/*
 * The auth HTTP surface that needs no database: exactly one `at_refresh` Set-Cookie written as Express writes it
 * (deletion included: an empty value with Max-Age=0, never Symfony's `deleted`), `Cache-Control` exactly as set
 * (`no-store`, not `no-store, private`), and the guard order 401 → `user` limit → 403 without params.
 */

use App\Http\ExactHeaders;
use App\Http\RefreshCookie;
use App\Http\Responses;
use App\Security\Jwt;
use Illuminate\Http\Response;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

const CLEARED = 'at_refresh=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict';

it('logout without a cookie: 204 and the one deletion cookie, no Cache-Control', function () {
    $res = $this->raw('POST', '/api/v1/auth/logout');
    expect($res->getStatusCode())->toBe(204);
    expect($res->headers->all('set-cookie'))->toBe([CLEARED]);
    expect($res->headers->has('Cache-Control'))->toBeFalse();
    expect($res->headers->get('X-Backend'))->toBe('laravel');
});

it('refresh without a cookie: 401 TOKEN_EXPIRED and the deletion cookie', function () {
    $res = $this->raw('POST', '/api/v1/auth/refresh', ['Cookie' => 'other=1']);
    expect($res->getStatusCode())->toBe(401);
    expect(json_decode($res->getContent(), true)['code'])->toBe('TOKEN_EXPIRED');
    expect($res->headers->all('set-cookie'))->toBe([CLEARED]);
});

it('serializes a refresh cookie exactly and reads the first at_refresh of a Cookie header verbatim', function () {
    expect((string) RefreshCookie::set('abc_DEF-123'))
        ->toBe('at_refresh=abc_DEF-123; Max-Age=1209600; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict');
    expect((string) RefreshCookie::clear())->toBe(CLEARED);
    expect(RefreshCookie::fromHeader('a=1; at_refresh=tok%2Fen; at_refresh=second'))->toBe('tok%2Fen');
    expect(RefreshCookie::fromHeader('at_refresh='))->toBeNull();
    expect(RefreshCookie::fromHeader(null))->toBeNull();
});

it('keeps Cache-Control exactly as set', function () {
    $res = new Response('', 200, ['Cache-Control' => 'no-store']);
    expect($res->headers->get('Cache-Control'))->toBe('no-store, private'); // Symfony's own computation
    $res->headers = ExactHeaders::from($res->headers);
    expect($res->headers->get('Cache-Control'))->toBe('no-store');
    $file = Responses::make('', 304, ['Cache-Control' => 'private, max-age=0, must-revalidate']);
    expect($file->headers->get('Cache-Control'))->toBe('private, max-age=0, must-revalidate');
});

it('guards an operation: 401 without a valid token, 403 without params for a role outside x-roles', function () {
    config(['agrotrace.jwt_secret' => 'jwt_test_secret_of_at_least_32_bytes!!', 'agrotrace.rate_limit_overrides' => '{"user":100000}']);
    $anon = $this->raw('POST', '/api/v1/auth/2fa/setup', ['Content-Type' => 'application/json'], '{}');
    expect($anon->getStatusCode())->toBe(401);
    $token = Jwt::issue('11111111-1111-4111-8111-'.bin2hex(random_bytes(6)), '22222222-2222-4222-8222-222222222222', ['FARMER'], true);
    $farmer = $this->raw('POST', '/api/v1/auth/2fa/setup', ['Content-Type' => 'application/json', 'Authorization' => "Bearer {$token}"], '{}');
    expect($farmer->getStatusCode())->toBe(403);
    expect(json_decode($farmer->getContent(), true))->not->toHaveKey('params');
});
