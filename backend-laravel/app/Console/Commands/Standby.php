<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * `artisan agrotrace:standby <process>` — the long-running placeholder of worker-laravel and scheduler-laravel until
 * their processes land (consumers and Telegram poller: Tasks 6 and 12; the scheduler's job processes: Task 9). It holds
 * no connection and exits cleanly on SIGTERM/SIGINT, so `./at up laravel` and SP1's scheduler quieting work today.
 */
final class Standby extends Command
{
    protected $signature = 'agrotrace:standby {process}';

    protected $description = 'Idle placeholder process (worker/scheduler) until their real processes are implemented';

    public function handle(): int
    {
        $stop = false;
        pcntl_async_signals(true);
        pcntl_signal(SIGTERM, function () use (&$stop) {
            $stop = true;
        });
        pcntl_signal(SIGINT, function () use (&$stop) {
            $stop = true;
        });
        Log::info('standby', ['role' => (string) $this->argument('process')]);
        while (! $stop) {
            usleep(200_000);
        }

        return self::SUCCESS;
    }
}
