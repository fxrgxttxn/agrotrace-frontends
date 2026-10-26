<?php

/*
 * The job registry (L5, routes/console.php): exactly four jobs, each a `Schedule::call()` (a CallbackEvent with a
 * JobRun), none a `->command()`; their periods (SCHEDULER_TICK_MS, default 5 min; the sweeper 5 s) and advisory locks
 * (the keys Express and Django share; the sweeper guards itself). supervisord starts one `agrotrace:job` per entry.
 */

use App\Scheduler\JobRun;
use App\Scheduler\Jobs\LabEscalation;
use App\Scheduler\Jobs\NotificationDelivery;
use App\Scheduler\Jobs\OutboxSweep;
use App\Scheduler\Jobs\RecallTaskOverdue;
use App\Scheduler\ScheduledJob;
use App\Scheduler\Tick;
use Illuminate\Console\Scheduling\CallbackEvent;
use Illuminate\Console\Scheduling\Schedule;
use Tests\TestCase;

uses(TestCase::class);

it('has exactly four jobs, each a call() with a JobRun, none a command()', function () {
    $events = app(Schedule::class)->events();
    expect(count($events))->toBe(4);
    $rows = [];
    foreach ($events as $e) {
        expect($e)->toBeInstanceOf(CallbackEvent::class);
        expect($e->command)->toBeNull();
        $run = (new ReflectionProperty(CallbackEvent::class, 'callback'))->getValue($e);
        expect($run)->toBeInstanceOf(JobRun::class);
        expect(is_subclass_of($run->class, ScheduledJob::class))->toBeTrue();
        $rows[$e->description] = [$run->class, $run->lock, Tick::intervalOf($e)];
    }
    expect($rows)->toBe([
        'lab-escalation' => [LabEscalation::class, 'agrotrace.scheduler.lab-escalation', 300],
        'recall-task-overdue' => [RecallTaskOverdue::class, 'agrotrace.scheduler.recall-task-overdue', 300],
        'notification-delivery' => [NotificationDelivery::class, 'agrotrace.scheduler.notification-delivery', 300],
        'outbox-sweep' => [OutboxSweep::class, null, 5],
    ]);
});

it('the registry file never schedules an artisan command', function () {
    $src = (string) file_get_contents(base_path('routes/console.php'));
    expect(substr_count($src, 'Schedule::call('))->toBe(4);
    expect($src)->not->toContain('->command(');
    expect($src)->not->toContain('Schedule::command(');
    expect($src)->not->toContain('schedule:work');
});

it('supervisord starts one agrotrace:job per registry entry', function () {
    $conf = (string) file_get_contents(base_path('docker/supervisord-scheduler.conf'));
    preg_match_all('/^command=php \/app\/artisan agrotrace:job ([a-z-]+)$/m', $conf, $m);
    expect($m[1])->toBe(['lab-escalation', 'recall-task-overdue', 'notification-delivery', 'outbox-sweep']);
});
