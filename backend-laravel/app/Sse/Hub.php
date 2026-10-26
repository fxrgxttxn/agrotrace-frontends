<?php

namespace App\Sse;

use Closure;
use Illuminate\Support\Facades\Log;
use PDO;
use Throwable;

/**
 * The SSE hub of api-laravel (`artisan agrotrace:sse-hub`, L3; Express sse/hub.ts `connect`): the container's ONE
 * PostgreSQL LISTEN session, fanned out to the streams through Redis.
 *
 * - its own PDO connection (no pool, no DbSlots slot — the budget's «sse-hub 1»), TCP keepalive and a 10 s
 *   tcp_user_timeout, application_name `agrotrace-laravel-sse-hub`; the only statement it ever runs is
 *   `LISTEN notifications`, again every 30 s as the liveness probe (so `pg_stat_activity.query` always shows it, P48);
 * - every NOTIFY payload of user U goes unchanged to `agrotrace:laravel:sse:user:{U}`, in commit order;
 * - a lost session (a failed probe, an error, a connection that reads EOF — pgsqlGetNotify then answers at once
 *   without a notification, so that is probed at once) is reconnected with back-off 0.5 s doubling to 10 s; once
 *   LISTEN runs again the generation `agrotrace:laravel:sse:gen` is incremented, `…:lostAt` set to the moment of the
 *   loss and `{type: "resync", gen, lostAt}` published on `agrotrace:laravel:sse:control` — atomically (RESYNC) — so
 *   every stream catches up what the lost NOTIFYs carried. The first session of a process announces itself the same
 *   way (lostAt = its start): what an earlier hub process missed before it died is caught up too. A resync Redis did
 *   not take is retried every loop.
 */
final class Hub
{
    public const PROBE_SEC = 30.0;

    public const POLL_MS = 1000;

    public const APPLICATION_NAME = 'agrotrace-laravel-sse-hub';

    public const RESYNC = "local g = redis.call('INCR', KEYS[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('PUBLISH', KEYS[3], cjson.encode({type = 'resync', gen = g, lostAt = ARGV[1]}))
return g";

    private bool $stopping = false;

    private ?PDO $pdo = null;

    private int $attempt = 0;

    private ?string $lostAt = null;

    private ?string $pendingResync = null;

    private float $lastProbe = 0.0;

    /**
     * @param  Closure(): PDO  $connect  a new session (LISTEN not yet issued)
     * @param  Closure(string, string): void  $publish  channel, message
     * @param  Closure(string): int  $resync  lostAt → the new generation
     */
    public function __construct(
        private readonly Closure $connect,
        private readonly Closure $publish,
        private readonly Closure $resync,
        private readonly float $probeSec = self::PROBE_SEC,
        private readonly int $pollMs = self::POLL_MS,
    ) {
        $this->lostAt = self::isoNow(); // the process start: see the class comment
    }

    public function stop(): void
    {
        $this->stopping = true;
    }

    public function run(): void
    {
        while (! $this->stopping) {
            $this->tick();
        }
        $this->pdo = null;
    }

    /** One step: (re)connect, or wait ≤ POLL_MS for a notification, forward it, probe when due. */
    public function tick(): void
    {
        if ($this->pendingResync !== null) {
            $this->announce($this->pendingResync);
        }
        if ($this->pdo === null) {
            $this->reconnect();

            return;
        }
        try {
            $t = microtime(true);
            /** @var array<string, mixed>|false $n false: nothing within the wait (or a dead connection — probed below) */
            $n = $this->pdo->pgsqlGetNotify(PDO::FETCH_ASSOC, $this->pollMs);
            if ($n !== false) {
                $this->forward((string) ($n['payload'] ?? ''));

                return;
            }
            $quick = microtime(true) - $t < $this->pollMs / 2000;
            if ($quick || microtime(true) - $this->lastProbe >= $this->probeSec) {
                $this->pdo->exec('LISTEN notifications');
                $this->lastProbe = microtime(true);
                if ($quick) {
                    usleep(50_000); // a probe that passed: an early wake-up by other traffic, not a loss
                }
            }
        } catch (Throwable $e) {
            $this->lose($e);
        }
    }

    private function reconnect(): void
    {
        try {
            $pdo = ($this->connect)();
            $pdo->exec('LISTEN notifications');
        } catch (Throwable $e) {
            if ($this->attempt === 0) {
                Log::warning('sse listen unavailable; retrying', ['err' => $e->getMessage()]);
            }
            $this->backoff();

            return;
        }
        $this->pdo = $pdo;
        $this->attempt = 0;
        $this->lastProbe = microtime(true);
        if ($this->lostAt !== null) {
            $this->announce($this->lostAt);
            $this->lostAt = null;
        }
    }

    private function lose(Throwable $e): void
    {
        $this->pdo = null;
        $this->lostAt ??= self::isoNow();
        if (! $this->stopping) {
            Log::warning('sse listen session lost; reconnecting', ['err' => $e->getMessage()]);
            $this->backoff();
        }
    }

    private function backoff(): void
    {
        $delay = min(0.5 * 2 ** $this->attempt, 10.0);
        $this->attempt++;
        $until = microtime(true) + $delay;
        while (! $this->stopping && microtime(true) < $until) {
            usleep(100_000);
        }
    }

    private function announce(string $lostAt): void
    {
        try {
            $gen = ($this->resync)($lostAt);
            $this->pendingResync = null;
            Log::info('sse resync announced', ['gen' => $gen, 'lostAt' => $lostAt]);
        } catch (Throwable $e) {
            $this->pendingResync = $lostAt;
            Log::warning('sse resync not announced; retrying', ['err' => $e->getMessage()]);
        }
    }

    private function forward(string $payload): void
    {
        $m = json_decode($payload);
        $userId = is_object($m) ? ($m->user_id ?? null) : null;
        if (! is_string($userId)) {
            return;
        }
        try {
            ($this->publish)(Stream::USER_CHANNEL.$userId, $payload);
        } catch (Throwable $e) {
            // The streams lose their subscriptions with Redis too and catch up themselves; a resync covers the rest.
            $this->pendingResync ??= self::isoNow();
            Log::warning('sse publish failed', ['err' => $e->getMessage()]);
        }
    }

    public static function isoNow(): string
    {
        $t = microtime(true);

        return gmdate('Y-m-d\TH:i:s', (int) $t).sprintf('.%03dZ', (int) (($t - floor($t)) * 1000));
    }

    /**
     * The hub's session: APP_DATABASE_URL as a libpq conninfo — keepalives, tcp_user_timeout 10 s, connect_timeout 5 s,
     * TimeZone UTC as a startup option (no statement but LISTEN ever runs on it).
     */
    public static function connectFromConfig(): PDO
    {
        $url = (string) config('database.connections.pgsql.url');
        $p = parse_url($url) ?: [];
        parse_str((string) ($p['query'] ?? ''), $query);
        $dsn = sprintf("pgsql:host=%s;port=%d;dbname=%s;sslmode=%s;application_name=%s;connect_timeout=5;keepalives=1;keepalives_idle=10;keepalives_interval=5;keepalives_count=3;tcp_user_timeout=10000;options='-c TimeZone=UTC'",
            $p['host'] ?? 'postgres', (int) ($p['port'] ?? 5432), ltrim(rawurldecode((string) ($p['path'] ?? '/agrotrace')), '/'),
            is_string($query['sslmode'] ?? null) ? $query['sslmode'] : 'prefer', self::APPLICATION_NAME);

        return new PDO($dsn, isset($p['user']) ? rawurldecode($p['user']) : null, isset($p['pass']) ? rawurldecode($p['pass']) : null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_TIMEOUT => 5,
        ]);
    }
}
