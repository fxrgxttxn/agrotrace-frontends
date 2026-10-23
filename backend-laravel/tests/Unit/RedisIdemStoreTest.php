<?php

/*
 * RedisIdemStore on the shared Redis (R48): claim is SET NX EX 60 of the pending mark; the Lua compare-and-set /
 * compare-and-delete settle only the caller's own pending record (TTL 86400 on done) — never a foreign fingerprint, a
 * finished record or a malformed value.
 */

use App\Http\Idempotency\RedisIdemStore;
use App\Infrastructure\Redis\SharedRedis;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

beforeEach(function () {
    $this->key = 'idem:at-laravel-test:'.bin2hex(random_bytes(6));
    $this->store = new RedisIdemStore;
});

afterEach(function () {
    SharedRedis::client()->del($this->key);
});

it('claims once with a 60 s pending mark; completes its own pending record for 86400 s', function () {
    expect($this->store->claim($this->key, 'fp'))->toBeTrue();
    expect($this->store->claim($this->key, 'fp'))->toBeFalse();
    expect(SharedRedis::client()->get($this->key))->toBe('{"fingerprint":"fp","state":"pending"}');
    expect(SharedRedis::client()->ttl($this->key))->toBeGreaterThan(55)->toBeLessThanOrEqual(60);
    expect($this->store->complete($this->key, 'other', 201, null))->toBeFalse();
    expect($this->store->complete($this->key, 'fp', 201, (object) ['id' => 'x', 'm' => new stdClass]))->toBeTrue();
    expect(SharedRedis::client()->get($this->key))->toBe('{"fingerprint":"fp","state":"done","status":201,"body":{"id":"x","m":{}}}');
    expect(SharedRedis::client()->ttl($this->key))->toBeGreaterThan(86000);
    $r = $this->store->get($this->key);
    expect([$r->fingerprint, $r->state, $r->status, $r->body->id])->toBe(['fp', 'done', 201, 'x']);
    // A done record is neither completed again nor released.
    expect($this->store->complete($this->key, 'fp', 200, null))->toBeFalse();
    expect($this->store->release($this->key, 'fp'))->toBeFalse();
    expect(SharedRedis::client()->exists($this->key))->toBe(1);
});

it('releases only its own pending record; a foreign or malformed value is left alone', function () {
    $this->store->claim($this->key, 'fp');
    expect($this->store->release($this->key, 'other'))->toBeFalse();
    expect($this->store->release($this->key, 'fp'))->toBeTrue();
    expect(SharedRedis::client()->exists($this->key))->toBe(0);
    SharedRedis::client()->set($this->key, 'not json', ['ex' => 30]);
    expect($this->store->get($this->key))->toBeNull();
    expect($this->store->release($this->key, 'fp'))->toBeFalse();
    expect($this->store->complete($this->key, 'fp', 200, null))->toBeFalse();
    expect(SharedRedis::client()->get($this->key))->toBe('not json');
});
