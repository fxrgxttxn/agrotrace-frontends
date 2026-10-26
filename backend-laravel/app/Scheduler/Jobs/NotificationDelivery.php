<?php

namespace App\Scheduler\Jobs;

use App\Notifications\Delivery;
use App\Scheduler\ScheduledJob;

/**
 * Scheduler job `notification-delivery` (P49; Express scheduler/jobs/notification-delivery.ts): every tick claims the
 * PENDING EMAIL/TELEGRAM rows whose sender died — `coalesce(claimed_at, created_at)` older than 5 minutes — one by one
 * with the conditional claim UPDATE (no row lock is held while sending; a row another sender claimed in between is
 * skipped), and sends them within the rest of their 3-attempt budget (Notifications\Delivery::sweep: ≤ 100 rows, no
 * new claim after 240 s). Any implementation's sweeper may take any such row. It runs in its own process (L5) under
 * Tick::locked on that process's one connection, which it keeps through the sends (the lock lives with the session).
 */
final class NotificationDelivery implements ScheduledJob
{
    public function run(): void
    {
        Delivery::forScheduler()->sweep();
    }
}
