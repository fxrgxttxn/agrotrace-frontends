<?php

namespace App\Infrastructure\Db;

use LogicException;

/**
 * A container-wide mutex taken with no DB slot or connection held (P61; review M5 of Tasks 4+5): long writers that
 * serialize on one PostgreSQL advisory lock (importDictionary: `dictionary:<name>`) queue here first, so at most one of
 * them per container holds a DbSlots slot while it waits for that advisory lock — the waiters cannot starve DB_SLOTS
 * (other requests would get 503 after 5 s). A flock'ed file per key (`/tmp/agrotrace-gates`): every FrankenPHP thread
 * opens it itself (flock holds per open file description), the kernel drops it if the process dies. The wait is
 * unbounded, as the advisory-lock wait it replaces; the advisory lock is still taken inside the transaction (other
 * containers, other writers).
 */
final class LocalGate
{
    private const POLL_MIN_US = 2_000;

    private const POLL_MAX_US = 20_000;

    /**
     * @template T
     *
     * @param  callable(): T  $work
     * @return T
     */
    public static function run(string $key, callable $work, ?string $dir = null): mixed
    {
        if (Tx::active() || app(DbSlots::class)->held()) {
            throw new LogicException('LocalGate::run() with a DB slot held');
        }
        $dir ??= (string) config('agrotrace.gates_dir', '/tmp/agrotrace-gates');
        if (! is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $h = fopen($dir.'/'.hash('sha256', $key).'.lock', 'c');
        if ($h === false) {
            throw new LogicException("LocalGate: cannot open the gate of {$key}");
        }
        try {
            $sleep = self::POLL_MIN_US;
            while (! flock($h, LOCK_EX | LOCK_NB)) {
                usleep(random_int(self::POLL_MIN_US, $sleep));
                $sleep = min(self::POLL_MAX_US, $sleep * 2);
            }

            return $work();
        } finally {
            flock($h, LOCK_UN);
            fclose($h);
        }
    }
}
