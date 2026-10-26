<?php

namespace App\Scheduler;

use App\Infrastructure\Db\Tx;
use Illuminate\Console\Scheduling\Event;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use LogicException;
use Throwable;

/**
 * The scheduler's period and tick guard (L5, spec 8.2; Express scheduler/runner.ts).
 *
 * Period (port deviation, a controller ruling of the plan): a job's period in ms maps onto a fixed Laravel Scheduler
 * frequency — the divisors of a minute (1, 2, 5, 10, 15, 20, 30 s → everySecond() … everyThirtySeconds()) and whole
 * minutes that divide an hour (everyMinute() … everyThirtyMinutes(), hourly(); 6, 12, 20 min → cron `*∕N * * * *`).
 * Any other value is a configuration error (TickConfigError, exit 78): Express accepts any 100–3 600 000 ms, but the
 * stand and CI use only 1 000 (test stand) and 300 000 (the default). `intervalSec` is the same set of values for the
 * job process's own timer; `intervalOf` reads it back from a registry event.
 *
 * Guard: every tick runs only while this process holds the SESSION advisory lock
 * `pg_try_advisory_lock(hashtext(<lock>))` on its own connection — `agrotrace.scheduler.<job>` (the same keys as
 * Express and Django: one scheduler of any backend on the shared DB ticks at a time), `agrotrace.outbox.laravel` for
 * the sweeper — released in `finally`. Held elsewhere → the tick is skipped (false).
 */
final class Tick
{
    public const DEFAULT_MS = 300_000;

    /** @var array<int, string> seconds → Event method */
    private const SECONDS = [
        1 => 'everySecond', 2 => 'everyTwoSeconds', 5 => 'everyFiveSeconds', 10 => 'everyTenSeconds',
        15 => 'everyFifteenSeconds', 20 => 'everyTwentySeconds', 30 => 'everyThirtySeconds',
    ];

    /** @var array<int, string> minutes → Event method */
    private const MINUTES = [
        1 => 'everyMinute', 2 => 'everyTwoMinutes', 3 => 'everyThreeMinutes', 4 => 'everyFourMinutes',
        5 => 'everyFiveMinutes', 10 => 'everyTenMinutes', 15 => 'everyFifteenMinutes', 30 => 'everyThirtyMinutes',
        60 => 'hourly',
    ];

    /** SCHEDULER_TICK_MS of this process (5 minutes by default; the test stand — 1 s). */
    public static function configuredMs(): int
    {
        return (int) config('agrotrace.scheduler_tick_ms', self::DEFAULT_MS);
    }

    /**
     * The Scheduler frequency of a period: an Event method name, or a cron expression.
     *
     * @throws TickConfigError
     */
    public static function frequency(int $ms): string
    {
        if ($ms > 0 && $ms % 1000 === 0 && isset(self::SECONDS[intdiv($ms, 1000)])) {
            return self::SECONDS[intdiv($ms, 1000)];
        }
        if ($ms > 0 && $ms % 60_000 === 0) {
            $min = intdiv($ms, 60_000);
            if (isset(self::MINUTES[$min])) {
                return self::MINUTES[$min];
            }
            if ($min < 60 && 60 % $min === 0) {
                return "*/{$min} * * * *";
            }
        }
        throw new TickConfigError("SCHEDULER_TICK_MS: {$ms} ms is not a Scheduler frequency — a divisor of 60 s (1, 2, 5, 10, 15, 20, 30 s) or of 60 min in whole minutes");
    }

    /** The job process's timer period in seconds (the same set of values as frequency). @throws TickConfigError */
    public static function intervalSec(int $ms): int
    {
        self::frequency($ms);

        return intdiv($ms, 1000);
    }

    /** Applies the frequency of $ms to a registry event. @throws TickConfigError */
    public static function apply(Event $event, int $ms): Event
    {
        $f = self::frequency($ms);

        return str_contains($f, ' ') ? $event->cron($f) : $event->{$f}();
    }

    /** The period (seconds) of a registry event, read back from its frequency. @throws TickConfigError */
    public static function intervalOf(Event $event): int
    {
        if ($event->isRepeatable()) {
            return (int) $event->repeatSeconds;
        }
        $expr = $event->expression;
        if ($expr === '* * * * *') {
            return 60;
        }
        if ($expr === '0 * * * *') {
            return 3600;
        }
        $n = str_starts_with($expr, '*/') && str_ends_with($expr, ' * * * *') ? substr($expr, 2, -8) : '';
        if (ctype_digit($n) && (int) $n >= 1 && (int) $n < 60 && 60 % (int) $n === 0) {
            return (int) $n * 60;
        }
        throw new TickConfigError("scheduler event {$event->description}: `{$expr}` is not a job period");
    }

    /**
     * Runs $fn under the session advisory lock $lockName on this process's connection; false — the lock is held by
     * another session and the tick is skipped. Never inside a transaction (the lock outlives it).
     */
    public static function locked(string $lockName, callable $fn): bool
    {
        if (Tx::active()) {
            throw new LogicException('Tick::locked inside a transaction');
        }
        if (DB::selectOne('SELECT pg_try_advisory_lock(hashtext(?)) AS ok', [$lockName])->ok !== true) {
            return false;
        }
        try {
            $fn();
        } finally {
            try {
                DB::select('SELECT pg_advisory_unlock(hashtext(?))', [$lockName]);
            } catch (Throwable $e) {
                // The session is in doubt: drop it, PostgreSQL releases its session locks with it.
                Log::warning('scheduler: advisory unlock failed; the connection is dropped', ['lock' => $lockName, 'err' => $e->getMessage()]);
                DB::disconnect();
            }
        }

        return true;
    }
}
