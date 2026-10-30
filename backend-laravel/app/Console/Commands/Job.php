<?php

namespace App\Console\Commands;

use App\Scheduler\Tick;
use App\Scheduler\TickConfigError;
use App\Support\EnvConfig;
use App\Support\RequestContext;
use App\Support\StopSignal;
use Illuminate\Console\Command;
use Illuminate\Console\Scheduling\CallbackEvent;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Support\Facades\Log;
use ReflectionProperty;
use Throwable;

/**
 * `artisan agrotrace:job <name>` — one long-lived job process of scheduler-laravel (L5; supervisord runs one per
 * registry entry). It finds the entry `<name>` in the registry (routes/console.php, `Schedule::call`), runs it at once
 * («сразу при старте процесса»), then on its own timer at the entry's period (Tick::intervalOf): ticks never overlap,
 * a tick that ran past the next boundary skips the missed ones, a failing tick is logged and the next runs as usual.
 * The process loads Laravel once and holds ONE PostgreSQL connection (the job's transactions and its session advisory
 * lock, Tick::locked). SIGTERM/SIGINT: the running tick finishes, then the process exits 0.
 *
 * The entry's callback is called directly, not through Event::run: a CallbackEvent keeps the exception of a failed
 * run and rethrows it on every later run of the same instance — fine for one `schedule:run`, wrong for a loop.
 */
final class Job extends Command
{
    protected $signature = 'agrotrace:job {name : the registry entry (routes/console.php)}';

    protected $description = 'Run one scheduler job now and then periodically (L5), until SIGTERM';

    public function handle(Schedule $schedule, StopSignal $stop): int
    {
        $name = (string) $this->argument('name');
        $event = null;
        foreach ($schedule->events() as $e) {
            if ($e instanceof CallbackEvent && $e->description === $name) {
                $event = $e;
            }
        }
        if ($event === null) {
            fwrite(STDERR, "agrotrace:job: no scheduler job `{$name}` in routes/console.php\n");

            return EnvConfig::EXIT_CONFIG;
        }
        try {
            Tick::frequency(Tick::configuredMs());
            $interval = Tick::intervalOf($event);
        } catch (TickConfigError $e) {
            fwrite(STDERR, "agrotrace:job: {$e->getMessage()}\n");

            return EnvConfig::EXIT_CONFIG;
        }
        /** @var callable(): mixed $callback */
        $callback = (new ReflectionProperty(CallbackEvent::class, 'callback'))->getValue($event);

        pcntl_async_signals(true);
        foreach ([SIGTERM, SIGINT] as $sig) {
            pcntl_signal($sig, fn () => $stop->raise());
        }
        Log::info('scheduler job started', ['job' => $name, 'intervalSec' => $interval]);
        $next = microtime(true);
        while (! $stop->raised()) {
            $this->tick($name, $callback);
            $next += $interval;
            $now = microtime(true);
            if ($next < $now) {
                $next += ceil(($now - $next) / $interval) * $interval;
            }
            $stop->sleep((int) max(0, round(($next - microtime(true)) * 1000)));
        }
        Log::info('scheduler job stopped', ['job' => $name]);

        return self::SUCCESS;
    }

    /** @param  callable(): mixed  $callback */
    private function tick(string $name, callable $callback): void
    {
        try {
            if ($callback() === false) {
                Log::debug('scheduler job tick skipped: the lock is held elsewhere', ['job' => $name]);
            }
        } catch (Throwable $e) {
            Log::error('scheduler job failed', ['job' => $name, 'err' => $e->getMessage(), 'exception' => $e::class]);
        } finally {
            // The tick's outbox ids: published by the outbox sweeper (no relay process in this container).
            app(RequestContext::class)->takeEventIds();
        }
    }
}
