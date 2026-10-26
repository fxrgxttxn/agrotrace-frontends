<?php

namespace App\Scheduler\Jobs;

use App\Scheduler\ScheduledJob;

/**
 * Scheduler job `recall-task-overdue` (BR-08; Express scheduler/jobs/recall-task-overdue.ts): OPEN recall tasks past
 * due → OVERDUE. Registered and ticking (L5) from Task 9; the pass itself arrives with the recall tasks in Task 10.
 */
final class RecallTaskOverdue implements ScheduledJob
{
    public function run(): void
    {
        // Task 10.
    }
}
