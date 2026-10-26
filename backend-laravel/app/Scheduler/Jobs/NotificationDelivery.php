<?php

namespace App\Scheduler\Jobs;

use App\Scheduler\ScheduledJob;

/**
 * Scheduler job `notification-delivery` (P49; Express scheduler/jobs/notification-delivery.ts): the stale PENDING
 * EMAIL/TELEGRAM rows are claimed and sent. Registered and ticking in its own process (L5: a slow delivery never
 * delays the other jobs) from Task 9; the delivery itself arrives in Task 12.
 */
final class NotificationDelivery implements ScheduledJob
{
    public function run(): void
    {
        // Task 12.
    }
}
