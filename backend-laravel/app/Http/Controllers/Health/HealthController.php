<?php

namespace App\Http\Controllers\Health;

use App\Support\Json;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Log;

/**
 * getHealthLive / getHealthReady (contracts/openapi/paths/health.yaml). Ready checks PostgreSQL, Redis, RabbitMQ
 * (a passive exchange_declare of `agrotrace.laravel` on a temporary channel) and MinIO (HeadBucket) CONCURRENTLY, each
 * bounded by HEALTH_TIMEOUT_MS (2 s), as Express does (review I3): one `artisan agrotrace:probe <check>` child process
 * per check — PHP has no non-blocking PDO/AMQP — and a check still running at the deadline is killed and `fail`. Any
 * `fail` → 503 with the same body shape. The db child takes a DbSlots slot like any connection (P61).
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
        $checks = self::runConcurrently(Probes::CHECKS, $timeout);
        foreach ($checks as $name => $status) {
            if ($status === 'fail') {
                Log::warning('readiness check failed', ['check' => $name]);
            }
        }
        $ok = ! in_array('fail', $checks, true);

        return self::json(['status' => $ok ? 'ok' : 'fail', 'checks' => $checks], $ok ? 200 : 503);
    }

    /**
     * @param  list<string>  $names
     * @return array<string, 'ok'|'fail'>
     */
    public static function runConcurrently(array $names, float $timeout): array
    {
        $deadline = microtime(true) + $timeout;
        $procs = [];
        $result = [];
        foreach ($names as $name) {
            $result[$name] = 'fail';
            $p = proc_open(
                ['php', base_path('artisan'), 'agrotrace:probe', $name],
                [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
                $pipes,
                base_path(),
            );
            if (is_resource($p)) {
                $procs[$name] = $p;
            }
        }
        while ($procs !== [] && microtime(true) < $deadline) {
            foreach ($procs as $name => $p) {
                $status = proc_get_status($p);
                if (! $status['running']) {
                    $result[$name] = $status['exitcode'] === 0 ? 'ok' : 'fail';
                    proc_close($p);
                    unset($procs[$name]);
                }
            }
            if ($procs !== []) {
                usleep(5_000);
            }
        }
        foreach ($procs as $p) {
            proc_terminate($p, 9);
            proc_close($p);
        }

        return $result;
    }

    /** @param  array<string, mixed>  $body */
    private static function json(array $body, int $status): Response
    {
        return new Response(Json::encode(Json::obj($body)), $status, ['Content-Type' => 'application/json; charset=utf-8']);
    }
}
