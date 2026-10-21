<?php

namespace App\Infrastructure\RateLimit;

use App\Contract\RulesRepo;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Infrastructure\Redis\SharedRedis;
use RuntimeException;

/**
 * Rate limits (R30, contracts/rules/rate-limits.json): fixed-window counters in the shared Redis, the keys of Express
 * and Django. Each hit: INCR `rl:{scope}:{subject}:{windowStartEpochSec}` and EXPIRE windowSec NX in ONE MULTI (a
 * counter never lives without a TTL); over the limit → 429 RATE_LIMITED, `Retry-After` = seconds to the window end
 * (≥ 1), `params {scope, limit, windowSec}`. P10: RATE_LIMIT_OVERRIDES replaces `limit` of the named scopes (test
 * stand only; validated at start, EnvConfig). The subject of `forgot` is the lower-cased email (the caller's job).
 */
final class RateLimiter
{
    /** @return array{scope: string, limit: int, windowSec: int} */
    public static function limitOf(string $scope, ?string $overrides = null): array
    {
        foreach (RulesRepo::json('rate-limits')['limits'] as $l) {
            if ($l['scope'] === $scope) {
                $limit = (int) $l['limit'];
                $o = self::overrides($overrides ?? config('agrotrace.rate_limit_overrides'));
                if (isset($o[$scope])) {
                    $limit = $o[$scope];
                }

                return ['scope' => $scope, 'limit' => $limit, 'windowSec' => (int) $l['windowSec']];
            }
        }
        throw new RuntimeException("rate-limits.json has no scope {$scope}");
    }

    /** Counts one request of $subject in $scope; 429 when this request is over the limit. */
    public static function hit(string $scope, string $subject, ?int $nowSec = null): void
    {
        ['limit' => $limit, 'windowSec' => $windowSec] = self::limitOf($scope);
        $now = $nowSec ?? time();
        $windowStart = intdiv($now, $windowSec) * $windowSec;
        $key = "rl:{$scope}:{$subject}:{$windowStart}";
        $r = SharedRedis::client();
        $replies = $r->multi()->incr($key)->expire($key, $windowSec, 'NX')->exec();
        if (! is_array($replies) || ! is_int($replies[0] ?? null)) {
            throw new RuntimeException('rate limit: MULTI failed');
        }
        if ($replies[0] > $limit) {
            throw new Problem(429, ProblemCode::RATE_LIMITED,
                params: ['scope' => $scope, 'limit' => $limit, 'windowSec' => $windowSec],
                headers: ['Retry-After' => (string) max(1, $windowStart + $windowSec - $now)],
            );
        }
    }

    /** @return array<string, int> */
    private static function overrides(mixed $raw): array
    {
        if (! is_string($raw) || $raw === '') {
            return [];
        }
        $v = json_decode($raw, true);

        return is_array($v) ? array_filter($v, 'is_int') : [];
    }
}
