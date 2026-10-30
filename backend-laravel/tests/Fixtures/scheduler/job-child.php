<?php

// TickTest: one scheduler job process exactly as supervisord starts it (`agrotrace:job <name>` over the real registry
// of routes/console.php, its real advisory lock on agrotrace_test_laravel), with every job class bound to a stub that
// logs `start|end <job> <unix time>` lines and sleeps. argv: name, log file, the stub's sleep in ms. The period comes
// from the environment (SCHEDULER_TICK_MS), as in the container. Exits with agrotrace:job's code.

use App\Scheduler\Jobs\LabEscalation;
use App\Scheduler\Jobs\NotificationDelivery;
use App\Scheduler\Jobs\OutboxSweep;
use App\Scheduler\Jobs\RecallTaskOverdue;
use App\Scheduler\ScheduledJob;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Artisan;

require __DIR__.'/../../../vendor/autoload.php';
$app = require __DIR__.'/../../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
config(['database.connections.pgsql.url' => getenv('TEST_APP_DATABASE_URL')]);
$app['db']->purge('pgsql');

[, $name, $log, $sleepMs] = $argv;

final class StubJob implements ScheduledJob
{
    public function __construct(private readonly string $log, private readonly string $job, private readonly int $sleepMs) {}

    public function run(): void
    {
        file_put_contents($this->log, sprintf("start %s %.3f\n", $this->job, microtime(true)), FILE_APPEND | LOCK_EX);
        // A signal cuts a usleep() short; the tick still runs its full length.
        $until = microtime(true) + $this->sleepMs / 1000;
        while (($left = $until - microtime(true)) > 0) {
            usleep((int) min(100_000, $left * 1_000_000));
        }
        file_put_contents($this->log, sprintf("end %s %.3f\n", $this->job, microtime(true)), FILE_APPEND | LOCK_EX);
    }
}

foreach ([LabEscalation::class, RecallTaskOverdue::class, NotificationDelivery::class, OutboxSweep::class] as $class) {
    $app->bind($class, fn () => new StubJob($log, $name, (int) $sleepMs));
}
exit(Artisan::call('agrotrace:job', ['name' => $name]));
