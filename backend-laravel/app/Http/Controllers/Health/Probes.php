<?php

namespace App\Http\Controllers\Health;

use App\Infrastructure\Db\DbSlots;
use Aws\S3\S3Client;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;
use InvalidArgumentException;
use PDO;
use PhpAmqpLib\Connection\AMQPStreamConnection;

/**
 * The four readiness checks of getHealthReady, each bounded by its timeout on its own (connect, read and statement
 * timeouts) — run one per child process by `artisan agrotrace:probe <check>` so that HealthController can run them
 * concurrently and stop any of them at HEALTH_TIMEOUT_MS (review I3, Express routes.ts: Promise.race per check).
 */
final class Probes
{
    public const CHECKS = ['db', 'redis', 'rabbitmq', 's3'];

    /** @throws \Throwable when the dependency is not ready */
    public static function run(string $check, float $timeout): void
    {
        match ($check) {
            'db' => self::db($timeout),
            'redis' => self::redis($timeout),
            'rabbitmq' => self::rabbit($timeout),
            's3' => self::s3($timeout),
            default => throw new InvalidArgumentException("unknown readiness check {$check}"),
        };
    }

    private static function db(float $timeout): void
    {
        app(DbSlots::class)->acquire($timeout);
        config(['database.connections.pgsql.options' => [PDO::ATTR_TIMEOUT => max(1, (int) ceil($timeout))]]);
        DB::purge('pgsql');
        DB::statement(sprintf("SET statement_timeout = '%dms'", (int) ($timeout * 1000)));
        DB::select('SELECT 1');
    }

    private static function redis(float $timeout): void
    {
        config([
            'database.redis.default.timeout' => $timeout,
            'database.redis.default.read_timeout' => $timeout,
        ]);
        Redis::purge('default');
        Redis::connection()->ping();
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
            // Passive: the exchange must exist (definitions.json); a temporary channel, closed right away.
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
