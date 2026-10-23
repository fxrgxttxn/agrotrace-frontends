<?php

namespace App\Scheduler\Jobs;

use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Outbox\Relay;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * The outbox sweeper (R56, R59, envelope; L5 — a scheduler job, every 5 s; its schedule and process arrive with the
 * scheduler skeleton in Task 9): only while `pg_try_advisory_lock(hashtext('agrotrace.outbox.laravel'))` succeeds on
 * this process's connection (session lock, released in `finally`), the oldest 100 unpublished rows of this backend
 * whose type has a handler — `ORDER BY created_at FOR NO KEY UPDATE SKIP LOCKED LIMIT 100`, published as the relay
 * does (Relay: the rows stay locked across the confirm, so a row the relay holds is skipped, never sent twice).
 * Retention (R59) under the same lock: this backend's `outbox_events` published more than 7 days ago and its
 * `processed_events` older than 30 days. The broker's channel is opened first: a broker that is down skips the tick
 * without taking the lock or opening a transaction.
 */
final class OutboxSweep
{
    public const LOCK = 'agrotrace.outbox.laravel';

    public function __construct(private readonly Relay $relay) {}

    /** One pass; the number of rows published (0 when the lock is taken elsewhere or the broker is down). */
    public function run(): int
    {
        try {
            $this->relay->publisher();
        } catch (BrokerUnavailable $e) {
            Log::warning('outbox sweep skipped: the broker is unavailable', ['err' => $e->getMessage()]);

            return 0;
        }
        if (DB::selectOne('SELECT pg_try_advisory_lock(hashtext(?)) AS ok', [self::LOCK])->ok !== true) {
            return 0;
        }
        try {
            DB::delete("DELETE FROM outbox_events WHERE backend = 'laravel' AND published_at < now() - interval '7 days'");
            DB::delete("DELETE FROM processed_events WHERE backend = 'laravel' AND processed_at < now() - interval '30 days'");
            try {
                return $this->relay->publishOldest();
            } catch (BrokerUnavailable $e) {
                Log::warning('outbox sweep failed; the next tick retries', ['err' => $e->getMessage()]);

                return 0;
            }
        } finally {
            DB::select('SELECT pg_advisory_unlock(hashtext(?))', [self::LOCK]);
        }
    }
}
