<?php

namespace App\Scheduler;

/**
 * The callback of a registry entry (routes/console.php `Schedule::call(new JobRun(…))`): one tick of the job class
 * (resolved by the container on every tick) under the advisory lock $lock (Tick::locked); a job that guards itself
 * (the outbox sweeper: the broker first, then its lock) has $lock = null. Returns false when the tick was skipped.
 */
final class JobRun
{
    /** @param  class-string<ScheduledJob>  $class */
    public function __construct(public readonly string $class, public readonly ?string $lock) {}

    public function __invoke(): bool
    {
        /** @var ScheduledJob $job */
        $job = app($this->class);
        if ($this->lock === null) {
            $job->run();

            return true;
        }

        return Tick::locked($this->lock, fn () => $job->run());
    }
}
