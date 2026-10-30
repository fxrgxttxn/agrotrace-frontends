<?php

namespace App\Scheduler\Jobs;

use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Outbox\Relay;
use App\Scheduler\ScheduledJob;
use App\Scheduler\Tick;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * The outbox sweeper (R56, R59, envelope; L5 — the scheduler job `outbox-sweep`, every 5 s whatever
 * SCHEDULER_TICK_MS): only while `pg_try_advisory_lock(hashtext('agrotrace.outbox.laravel'))` succeeds on this
 * process's connection (Tick::locked: session lock, released in `finally`), the oldest 100 unpublished rows of this
 * backend whose type has a handler — `ORDER BY created_at FOR NO KEY UPDATE SKIP LOCKED LIMIT 100`, published as the
 * relay does (Relay: the rows stay locked across the confirm, so a row the relay holds is skipped, never sent twice).
 * Retention (R59) under the same lock: this backend's `outbox_events` published more than 7 days ago and its
 * `processed_events` older than 30 days. The broker's channel is opened first: a broker that is down skips the tick
 * without taking the lock or opening a transaction — so the job guards itself (its registry entry has no lock).
 */
final class OutboxSweep implements ScheduledJob
{
    public const LOCK = 'agrotrace.outbox.laravel';

    /** The sweeper's period (independent of SCHEDULER_TICK_MS). */
    public const PERIOD_MS = 5000;

    public function __construct(private readonly Relay $relay) {}

    public function run(): void
    {
        $n = $this->sweep();
        if ($n > 0) {
            Log::info('scheduler job tick', ['job' => 'outbox-sweep', 'rows' => $n]);
        }
    }

    /** One pass; the number of rows published (0 when the lock is taken elsewhere or the broker is down). */
    public function sweep(): int
    {
        try {
            $this->relay->publisher();
        } catch (BrokerUnavailable $e) {
            Log::warning('outbox sweep skipped: the broker is unavailable', ['err' => $e->getMessage()]);

            return 0;
        }
        $published = 0;
        Tick::locked(self::LOCK, function () use (&$published): void {
            DB::delete("DELETE FROM outbox_events WHERE backend = 'laravel' AND published_at < now() - interval '7 days'");
            DB::delete("DELETE FROM processed_events WHERE backend = 'laravel' AND processed_at < now() - interval '30 days'");
            try {
                $published = $this->relay->publishOldest();
            } catch (BrokerUnavailable $e) {
                Log::warning('outbox sweep failed; the next tick retries', ['err' => $e->getMessage()]);
            }
        });

        return $published;
    }
}
