<?php

namespace App\Http\Controllers\Health;

use App\Infrastructure\Db\DbSlots;
use Aws\S3\S3Client;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use PDO;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use Redis;
use RuntimeException;

/**
 * The four readiness checks of getHealthReady, in-process (Ruling Q7). Each runs with the REMAINING budget of the one
 * shared deadline as its connect/read timeout, on its own short-lived client (never the request's connections):
 * - db: a raw SSLRequest round trip first (a server that accepts TCP and never answers costs the budget, not libpq's
 *   2 s minimum connect_timeout), then a PDO connection through PgConnector (a DbSlots slot, given back right after the
 *   check) with `statement_timeout` = the remaining budget, `SELECT 1`;
 * - redis: PING on a fresh phpredis connection (connect and read timeouts);
 * - rabbitmq: a passive exchange_declare of `agrotrace.laravel` on a temporary connection;
 * - s3: HeadBucket with HTTP connect/request timeouts.
 */
final class Probes
{
    public const CHECKS = ['db', 'redis', 'rabbitmq', 's3'];

    /** @throws \Throwable when the dependency is not ready within $timeout seconds */
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
        $deadline = microtime(true) + $timeout;
        /** @var array<string, mixed> $config */
        $config = DB::connection()->getConfig();
        self::pgAnswers((string) $config['host'], (int) ($config['port'] ?? 5432), $timeout);
        $config['options'] = [PDO::ATTR_TIMEOUT => max(1, (int) ceil($deadline - microtime(true)))];
        $slots = app(DbSlots::class);
        $ownSlot = ! $slots->held();
        try {
            $slots->acquire(max(0.01, $deadline - microtime(true)));
            $pdo = app('db.connector.pgsql')->connect($config);
            $left = (int) floor(($deadline - microtime(true)) * 1000);
            if ($left <= 0) {
                throw new RuntimeException('db: no budget left after connecting');
            }
            $pdo->exec("SET statement_timeout = '{$left}ms'");
            $pdo->query('SELECT 1');
            $pdo = null;
        } finally {
            if ($ownSlot) {
                $slots->release();
            }
        }
    }

    /** The PostgreSQL server answers an SSLRequest ('S' or 'N') within the budget. */
    private static function pgAnswers(string $host, int $port, float $timeout): void
    {
        $deadline = microtime(true) + $timeout;
        $s = @stream_socket_client("tcp://{$host}:{$port}", $errno, $err, $timeout);
        if ($s === false) {
            throw new RuntimeException("db: {$err}");
        }
        try {
            fwrite($s, pack('NN', 8, 80877103));
            $left = max(0.0, $deadline - microtime(true));
            stream_set_timeout($s, (int) floor($left), (int) (fmod($left, 1) * 1e6));
            $answer = fread($s, 1);
            if ($answer !== 'S' && $answer !== 'N') {
                throw new RuntimeException('db: no answer to SSLRequest');
            }
        } finally {
            fclose($s);
        }
    }

    private static function redis(float $timeout): void
    {
        $url = parse_url((string) config('database.redis.default.url'));
        $r = new Redis;
        if (! $r->connect($url['host'] ?? 'redis', (int) ($url['port'] ?? 6379), $timeout, null, 0, $timeout)) {
            throw new RuntimeException('redis: no connection');
        }
        try {
            if (isset($url['pass'])) {
                $r->auth(isset($url['user']) ? [rawurldecode($url['user']), rawurldecode($url['pass'])] : rawurldecode($url['pass']));
            }
            $r->ping();
        } finally {
            $r->close();
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
