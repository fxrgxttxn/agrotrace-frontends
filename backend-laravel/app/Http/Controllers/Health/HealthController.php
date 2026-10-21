<?php

namespace App\Http\Controllers\Health;

use App\Support\Json;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * getHealthLive / getHealthReady (contracts/openapi/paths/health.yaml). Ready checks PostgreSQL, Redis, RabbitMQ and
 * MinIO in-process against ONE shared deadline of HEALTH_TIMEOUT_MS (Ruling Q7, as Django): every check gets the
 * remaining budget as its connect/read timeout (Probes), a check the deadline leaves no budget for is `fail` without
 * running, so a ready call is bounded by about HEALTH_TIMEOUT_MS whatever the concurrency. Any `fail` → 503 with the
 * same body shape.
 */
final class HealthController
{
    public function live(): Response
    {
        return self::json(['status' => 'ok'], 200);
    }

    public function ready(): Response
    {
        $timeout = max(0.1, (int) config('agrotrace.health_timeout_ms', 2000) / 1000);
        $checks = self::runWithin(Probes::CHECKS, $timeout);
        $ok = ! in_array('fail', $checks, true);

        return self::json(['status' => $ok ? 'ok' : 'fail', 'checks' => $checks], $ok ? 200 : 503);
    }

    /**
     * @param  list<string>  $names
     * @return array<string, 'ok'|'fail'>
     */
    public static function runWithin(array $names, float $timeout): array
    {
        $deadline = microtime(true) + $timeout;
        $result = [];
        foreach ($names as $name) {
            $left = $deadline - microtime(true);
            if ($left <= 0.005) {
                $result[$name] = 'fail';
                Log::warning('readiness check failed', ['check' => $name, 'error' => 'no budget left']);

                continue;
            }
            try {
                Probes::run($name, $left);
                $result[$name] = microtime(true) <= $deadline ? 'ok' : 'fail';
            } catch (Throwable $e) {
                $result[$name] = 'fail';
                Log::warning('readiness check failed', ['check' => $name, 'error' => $e->getMessage()]);
            }
        }

        return $result;
    }

    /** @param  array<string, mixed>  $body */
    private static function json(array $body, int $status): Response
    {
        return new Response(Json::encode(Json::obj($body)), $status, ['Content-Type' => 'application/json; charset=utf-8']);
    }
}
