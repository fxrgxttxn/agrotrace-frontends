<?php

namespace App\Http\Idempotency;

use App\Infrastructure\Redis\Scripts;
use App\Infrastructure\Redis\SharedRedis;
use App\Support\Json;

/** IdemStore on the shared Redis (raw phpredis client: no prefix, no serializer — the keys of every backend). */
final class RedisIdemStore implements IdemStore
{
    public function claim(string $key, string $fingerprint): bool
    {
        $value = Json::encode(['fingerprint' => $fingerprint, 'state' => 'pending']);

        return SharedRedis::client()->set($key, $value, ['nx', 'ex' => self::PENDING_TTL_SEC]) === true;
    }

    public function get(string $key): ?IdemRecord
    {
        $v = SharedRedis::client()->get($key);

        return is_string($v) ? IdemRecord::fromJson($v) : null;
    }

    public function complete(string $key, string $fingerprint, int $status, mixed $body): bool
    {
        $value = Json::encode(['fingerprint' => $fingerprint, 'state' => 'done', 'status' => $status, 'body' => $body]);

        return (int) SharedRedis::client()->eval(Scripts::IDEM_COMPLETE, [$key, $fingerprint, $value], 1) === 1;
    }

    public function release(string $key, string $fingerprint): bool
    {
        return (int) SharedRedis::client()->eval(Scripts::IDEM_RELEASE, [$key, $fingerprint], 1) === 1;
    }
}
