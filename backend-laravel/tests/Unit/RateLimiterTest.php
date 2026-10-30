<?php

/*
 * Rate limits (R30, P10): the shared key `rl:{scope}:{subject}:{windowStart}` with a TTL set in the same MULTI, the
 * limit inclusive, 429 RATE_LIMITED with Retry-After to the window end (≥ 1) and params {scope, limit, windowSec};
 * RATE_LIMIT_OVERRIDES replaces the limit only.
 */

use App\Http\Problem\Problem;
use App\Infrastructure\RateLimit\RateLimiter;
use App\Infrastructure\Redis\SharedRedis;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

it('counts in the shared key with a TTL and refuses the request over the limit', function () {
    config(['agrotrace.rate_limit_overrides' => null]);
    $subject = 'test-'.bin2hex(random_bytes(6)).'@agrotrace.test';
    $now = 1_800_000_123; // window 1 799 996 400 … +3600 of `forgot`
    $start = intdiv($now, 3600) * 3600;
    $key = "rl:forgot:{$subject}:{$start}";
    try {
        for ($i = 0; $i < 3; $i++) {
            RateLimiter::hit('forgot', $subject, $now);
        }
        expect(SharedRedis::client()->get($key))->toBe('3');
        $ttl = SharedRedis::client()->ttl($key);
        expect($ttl)->toBeGreaterThan(3500)->toBeLessThanOrEqual(3600);
        try {
            RateLimiter::hit('forgot', $subject, $now);
            $this->fail('the 4th hit must be refused');
        } catch (Problem $p) {
            expect($p->status)->toBe(429);
            expect($p->problemCode->value)->toBe('RATE_LIMITED');
            expect($p->params)->toBe(['scope' => 'forgot', 'limit' => 3, 'windowSec' => 3600]);
            expect($p->headers['Retry-After'])->toBe((string) ($start + 3600 - $now));
        }
    } finally {
        SharedRedis::client()->del($key);
    }
});

it('Retry-After is at least 1 at the very end of a window', function () {
    $subject = 'test-'.bin2hex(random_bytes(6));
    $now = 1_800_000_059; // last second of a 60 s window
    $key = 'rl:login-ip:'.$subject.':'.(intdiv($now, 60) * 60);
    config(['agrotrace.rate_limit_overrides' => '{"login-ip":1}']);
    try {
        RateLimiter::hit('login-ip', $subject, $now);
        expect(fn () => RateLimiter::hit('login-ip', $subject, $now))
            ->toThrow(fn (Problem $p) => expect([$p->headers['Retry-After'], $p->params['limit']])->toBe(['1', 1]));
    } finally {
        SharedRedis::client()->del($key);
    }
});

it('applies RATE_LIMIT_OVERRIDES to the named scopes only', function () {
    config(['agrotrace.rate_limit_overrides' => '{"user":100000,"login-ip":100000}']);
    expect(RateLimiter::limitOf('user'))->toBe(['scope' => 'user', 'limit' => 100000, 'windowSec' => 60]);
    expect(RateLimiter::limitOf('forgot'))->toBe(['scope' => 'forgot', 'limit' => 3, 'windowSec' => 3600]);
    config(['agrotrace.rate_limit_overrides' => null]);
    expect(RateLimiter::limitOf('user')['limit'])->toBe(100);
});
