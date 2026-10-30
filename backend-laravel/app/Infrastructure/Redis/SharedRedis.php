<?php

namespace App\Infrastructure\Redis;

use Redis;

/**
 * The raw phpredis client of the default connection (config/database.php: no prefix, no serializer — the shared keys
 * of the contract, R82/SP7, byte for byte). Commands Laravel's wrapper does not expose as such (MULTI with replies,
 * GETDEL, EVAL with keys, SET … NX EX) go through it.
 */
final class SharedRedis
{
    public static function client(): Redis
    {
        /** @var Redis $client */
        $client = app('redis')->connection()->client();

        return $client;
    }
}
