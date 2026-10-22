<?php

namespace App\Infrastructure\Db;

use LogicException;

/**
 * A container-wide mutex taken with no DB slot or connection held (P61; review M5 of Tasks 4+5): long writers that
 * serialize on one PostgreSQL advisory lock (importDictionary: `dictionary:<name>`) queue here first, so at most one of
 * them per container holds a DbSlots slot while it waits for that advisory lock — the waiters cannot starve DB_SLOTS.
 * A flock'ed file per key (`/tmp/agrotrace-gates`): every FrankenPHP thread opens it itself (flock holds per open file
 * description), the kernel drops it if the process dies. The advisory lock is still taken inside the transaction.
 *
 * The wait is bounded (re-review N1), as Express's wait for the same lock is:
 * - at most `$maxWaiters` requests wait per key (flock'ed `wait-<i>` slot files, like the sandbox lanes); one more is
 *   refused at once — 503 BACKEND_UNAVAILABLE, Express's answer when its pool is exhausted — so waiters never take
 *   every Octane worker;
 * - the wait ends after `$deadlineSec` (default: the session's lock_timeout, 10 s — what the advisory-lock wait itself
 *   gets; Express answers its expiry, 55P03, with 503 BACKEND_UNAVAILABLE) — the same 503;
 * - a client that went away ($clientGone, ClientConnection) leaves the queue before its work ever starts (a 503 nobody
 *   reads): an aborted request is never applied later.
 * Every path gives the gate and the waiting slot back (finally; the kernel on a crash).
 */
final class LocalGate
{
    public const MAX_WAITERS = 8;

    private const POLL_MIN_US = 2_000;

    private const POLL_MAX_US = 20_000;

    /**
     * @template T
     *
     * @param  callable(): T  $work
     * @param  null|callable(): bool  $clientGone
     * @return T
     *
     * @throws BackendUnavailable when the queue is full, the deadline passes or the client is gone
     */
    public static function run(
        string $key,
        callable $work,
        ?callable $clientGone = null,
        ?float $deadlineSec = null,
        int $maxWaiters = self::MAX_WAITERS,
        ?string $dir = null,
    ): mixed {
        if (Tx::active() || app(DbSlots::class)->held()) {
            throw new LogicException('LocalGate::run() with a DB slot held');
        }
        $deadline = microtime(true) + ($deadlineSec ?? self::lockTimeoutSec());
        $dir ??= (string) config('agrotrace.gates_dir', '/tmp/agrotrace-gates');
        if (! is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $base = $dir.'/'.hash('sha256', $key);
        $gate = self::tryLock("{$base}.lock");
        $wait = null;
        try {
            if ($gate === null) {
                for ($i = 0; $i < $maxWaiters && $wait === null; $i++) {
                    $wait = self::tryLock("{$base}.wait-{$i}.lock");
                }
                if ($wait === null) {
                    throw new BackendUnavailable("gate {$key}: {$maxWaiters} requests already waiting");
                }
                $sleep = self::POLL_MIN_US;
                while ($gate === null) {
                    if ($clientGone !== null && $clientGone()) {
                        throw new BackendUnavailable("gate {$key}: the client went away while waiting");
                    }
                    if (microtime(true) >= $deadline) {
                        throw new BackendUnavailable("gate {$key}: not free within the lock timeout");
                    }
                    usleep(random_int(self::POLL_MIN_US, $sleep));
                    $sleep = min(self::POLL_MAX_US, $sleep * 2);
                    $gate = self::tryLock("{$base}.lock");
                }
                self::unlock($wait);
                $wait = null;
                if ($clientGone !== null && $clientGone()) {
                    throw new BackendUnavailable("gate {$key}: the client went away while waiting");
                }
            }

            return $work();
        } finally {
            if ($wait !== null) {
                self::unlock($wait);
            }
            if ($gate !== null) {
                self::unlock($gate);
            }
        }
    }

    /** The session's lock_timeout (config agrotrace.db.lock_timeout: `10s`, `500ms`) in seconds. */
    private static function lockTimeoutSec(): float
    {
        $v = trim((string) config('agrotrace.db.lock_timeout', '10s'));

        return str_ends_with($v, 'ms') ? (float) $v / 1000 : (float) $v;
    }

    /** @return resource|null */
    private static function tryLock(string $file)
    {
        $h = @fopen($file, 'c');
        if ($h === false) {
            throw new LogicException("LocalGate: cannot open {$file}");
        }
        if (flock($h, LOCK_EX | LOCK_NB)) {
            return $h;
        }
        fclose($h);

        return null;
    }

    /** @param  resource  $h */
    private static function unlock($h): void
    {
        flock($h, LOCK_UN);
        fclose($h);
    }
}
