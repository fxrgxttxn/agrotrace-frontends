<?php

namespace App\Scheduler;

/**
 * A periodic job of the scheduler (L5; routes/console.php registry, `agrotrace:job <name>`): one tick. It runs on
 * the job process's single PostgreSQL connection, under the tick's advisory lock (Tick::locked), and never overlaps
 * itself; a throw is logged by the process and the next tick runs as usual.
 */
interface ScheduledJob
{
    public function run(): void;
}
