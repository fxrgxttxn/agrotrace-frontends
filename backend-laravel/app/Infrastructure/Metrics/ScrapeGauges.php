<?php

namespace App\Infrastructure\Metrics;

use App\Console\Commands\Consume;
use App\Http\Controllers\Health\Probes;
use App\Infrastructure\Db\DbSlots;
use Closure;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use PDO;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use RuntimeException;
use Throwable;

/**
 * The two gauges read at scrape time (P54, L15), appended to the exposition text by our own code (the exact `NaN`,
 * `recalls_open` with the `backend` label only):
 * - `queue_messages{queue="agrotrace.laravel.jobs"}` — the ready messages of the jobs queue: a passive queue_declare
 *   on a short-lived connection;
 * - `recalls_open` — `count(*)` of the OPEN, not deleted recalls of the shared DB.
 *
 * Each read is bounded by SCRAPE_TIMEOUT_SEC (2 s, as Express's withTimeout) for the wait AND the read; at most one
 * scrape at a time reads a gauge (an APCu lock shared by the api's threads) — a scrape that cannot get the lock in
 * time, a timeout or an error gives NaN, never the last good value presented as current. So scrapes hold at most one
 * DB_SLOTS slot, only for the count (P61: given back before the broker is asked).
 */
final class ScrapeGauges
{
    public const SCRAPE_TIMEOUT_SEC = 2.0;

    public const QUEUE = Consume::QUEUE;

    private const LOCK_PREFIX = 'agrotrace_metrics_read:';

    /** A lock its holder never released (a killed thread) lapses after this many seconds. */
    private const LOCK_TTL_SEC = 5;

    /** @var Closure(float): (int|float) */
    private readonly Closure $queueRead;

    /** @var Closure(float): (int|float) */
    private readonly Closure $recallsRead;

    /**
     * @param  null|Closure(float): (int|float)  $queueRead  the ready count within the given seconds (tests: a fake)
     * @param  null|Closure(float): (int|float)  $recallsRead  the OPEN recalls within the given seconds
     */
    public function __construct(
        ?Closure $queueRead = null,
        ?Closure $recallsRead = null,
        private readonly float $timeoutSec = self::SCRAPE_TIMEOUT_SEC,
    ) {
        $this->queueRead = $queueRead ?? self::queueReady(...);
        $this->recallsRead = $recallsRead ?? self::recallsOpen(...);
    }

    public function render(): string
    {
        $queue = $this->read('queue_messages', $this->queueRead);
        $recalls = $this->read('recalls_open', $this->recallsRead);
        $backend = HttpMetrics::BACKEND;

        return "# HELP queue_messages Messages ready in the jobs queue of the backend (RabbitMQ), read at scrape time\n"
            ."# TYPE queue_messages gauge\n"
            .'queue_messages{queue="'.self::QUEUE.'",backend="'.$backend.'"} '.self::number($queue)."\n"
            ."# HELP recalls_open Recalls in status OPEN (not deleted), read at scrape time\n"
            ."# TYPE recalls_open gauge\n"
            .'recalls_open{backend="'.$backend.'"} '.self::number($recalls)."\n";
    }

    /** @param  Closure(float): (int|float)  $fn */
    private function read(string $gauge, Closure $fn): float
    {
        $deadline = microtime(true) + $this->timeoutSec;
        $lock = self::LOCK_PREFIX.$gauge;
        while (! apcu_add($lock, 1, self::LOCK_TTL_SEC)) {
            if (microtime(true) >= $deadline) {
                Log::warning('metrics: previous read still in flight', ['gauge' => $gauge]);

                return NAN;
            }
            usleep(10_000);
        }
        try {
            $value = (float) $fn(max(0.01, $deadline - microtime(true)));
            if (microtime(true) > $deadline) {
                Log::warning('metrics: read timed out', ['gauge' => $gauge]);

                return NAN;
            }

            return $value;
        } catch (Throwable $e) {
            Log::warning('metrics: read failed', ['gauge' => $gauge, 'err' => $e->getMessage()]);

            return NAN;
        } finally {
            apcu_delete($lock);
        }
    }

    /** Prometheus text: an integer count as written, an unknown value as `NaN`. */
    private static function number(float $v): string
    {
        if (is_nan($v)) {
            return 'NaN';
        }

        return floor($v) === $v && abs($v) < 1e15 ? (string) (int) $v : (string) $v;
    }

    private static function queueReady(float $timeout): int
    {
        $url = parse_url((string) config('agrotrace.rabbitmq_url')) ?: [];
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
            $declared = $channel->queue_declare(self::QUEUE, true);
            $channel->close();
            if (! is_array($declared) || ! is_int($declared[1] ?? null)) {
                throw new RuntimeException('rabbitmq: no message count for '.self::QUEUE);
            }

            return $declared[1];
        } finally {
            $conn->close();
        }
    }

    /**
     * One count on a connection of its own (the pattern of the readiness check, Probes::db): a DB_SLOTS slot, a
     * statement_timeout of the remaining budget; the slot is given back at once.
     */
    private static function recallsOpen(float $timeout): int
    {
        $deadline = microtime(true) + $timeout;
        /** @var array<string, mixed> $config */
        $config = DB::connection()->getConfig();
        Probes::pgAnswers((string) $config['host'], (int) ($config['port'] ?? 5432), $timeout);
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
            $n = $pdo->query("SELECT count(*) FROM recalls WHERE status = 'OPEN' AND deleted_at IS NULL")->fetchColumn();
            $pdo = null;

            return (int) $n;
        } finally {
            if ($ownSlot) {
                $slots->release();
            }
        }
    }
}
