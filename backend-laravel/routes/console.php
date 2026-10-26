<?php

/*
 * The scheduler's job registry (L5, Plan 5 Task 9): one callback event per job — a JobRun of the job class and its
 * advisory lock — with the job's name and frequency; never an artisan-command event (RegistryTest). `schedule:list`
 * shows it. Laravel's own schedule worker is not used: the scheduler-laravel container runs one long-lived
 * `agrotrace:job <name>` per entry (supervisord), which runs the job at once and then on its own timer, so a slow
 * delivery never delays the other jobs.
 *
 * An invalid SCHEDULER_TICK_MS is reported by agrotrace:preflight and agrotrace:job (exit 78); it must not break the
 * loading of this file, which every artisan command does.
 */

use App\Scheduler\JobRun;
use App\Scheduler\Jobs\LabEscalation;
use App\Scheduler\Jobs\NotificationDelivery;
use App\Scheduler\Jobs\OutboxSweep;
use App\Scheduler\Jobs\RecallTaskOverdue;
use App\Scheduler\Tick;
use App\Scheduler\TickConfigError;
use Illuminate\Console\Scheduling\Event;
use Illuminate\Support\Facades\Schedule;

$every = function (Event $event, int $ms): void {
    try {
        Tick::apply($event, $ms);
    } catch (TickConfigError) {
        // Left at the default frequency; agrotrace:job and agrotrace:preflight refuse to start (78).
    }
};

$tick = Tick::configuredMs();
$every(Schedule::call(new JobRun(LabEscalation::class, 'agrotrace.scheduler.lab-escalation'))->name('lab-escalation'), $tick);
$every(Schedule::call(new JobRun(RecallTaskOverdue::class, 'agrotrace.scheduler.recall-task-overdue'))->name('recall-task-overdue'), $tick);
$every(Schedule::call(new JobRun(NotificationDelivery::class, 'agrotrace.scheduler.notification-delivery'))->name('notification-delivery'), $tick);
// The sweeper guards itself (the broker first, then `agrotrace.outbox.laravel`), every 5 s.
$every(Schedule::call(new JobRun(OutboxSweep::class, null))->name('outbox-sweep'), OutboxSweep::PERIOD_MS);
