<?php

namespace App\Http\Controllers\Health;

use App\Infrastructure\Db\DbSlots;
use App\Support\Json;
use Aws\S3\S3Client;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Redis;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use Throwable;

/**
 * getHealthLive / getHealthReady (contracts/openapi/paths/health.yaml). Ready checks PostgreSQL, Redis, RabbitMQ
 * (a passive exchange_declare of `agrotrace.laravel` on a temporary channel) and MinIO (HeadBucket), each bounded by
 * HEALTH_TIMEOUT_MS (2 s); any `fail` → 503 with the same body shape.
 */
final class HealthController
{
    public function live(): Response
    {
        return self::json(['status' => 'ok'], 200);
    }

    public function ready(DbSlots $slots): Response
    {
        $timeout = max(0.1, (int) config('agrotrace.health_timeout_ms', 2000) / 1000);
        $checks = [
            'db' => self::probe('db', function () use ($slots, $timeout) {
                $slots->acquire($timeout);
                DB::select('SELECT 1');
            }),
            'redis' => self::probe('redis', fn () => Redis::connection()->ping()),
            'rabbitmq' => self::probe('rabbitmq', fn () => self::rabbit($timeout)),
            's3' => self::probe('s3', fn () => self::s3($timeout)),
        ];
        $ok = ! in_array('fail', $checks, true);

        return self::json(['status' => $ok ? 'ok' : 'fail', 'checks' => $checks], $ok ? 200 : 503);
    }

    /** @param  array<string, mixed>  $body */
    private static function json(array $body, int $status): Response
    {
        return new Response(Json::encode(Json::obj($body)), $status, ['Content-Type' => 'application/json; charset=utf-8']);
    }

    private static function probe(string $name, callable $check): string
    {
        try {
            $check();

            return 'ok';
        } catch (Throwable $e) {
            Log::warning('readiness check failed', ['check' => $name, 'error' => $e->getMessage()]);

            return 'fail';
        }
    }

    private static function rabbit(float $timeout): void
    {
        $url = parse_url((string) config('agrotrace.rabbitmq_url'));
        $vhost = isset($url['path']) && $url['path'] !== '/' && $url['path'] !== '' ? rawurldecode(substr($url['path'], 1)) : '/';
        $conn = new AMQPStreamConnection(
            $url['host'] ?? 'rabbitmq',
            $url['port'] ?? 5672,
            rawurldecode($url['user'] ?? 'guest'),
            rawurldecode($url['pass'] ?? 'guest'),
            $vhost,
            connection_timeout: $timeout,
            read_write_timeout: $timeout,
        );
        try {
            $channel = $conn->channel();
            $channel->exchange_declare((string) config('agrotrace.exchange'), 'topic', true);
            $channel->close();
        } finally {
            $conn->close();
        }
    }

    private static function s3(float $timeout): void
    {
        $s3 = new S3Client([
            'version' => 'latest',
            'region' => config('agrotrace.s3.region'),
            'endpoint' => config('agrotrace.s3.endpoint'),
            'use_path_style_endpoint' => true,
            'credentials' => ['key' => config('agrotrace.s3.key'), 'secret' => config('agrotrace.s3.secret')],
            // P4: MinIO and the AWS SDK's default checksums.
            'request_checksum_calculation' => 'when_required',
            'response_checksum_validation' => 'when_required',
            'retries' => 0,
            'http' => ['connect_timeout' => $timeout, 'timeout' => $timeout],
        ]);
        $s3->headBucket(['Bucket' => config('agrotrace.s3.bucket')]);
    }
}
