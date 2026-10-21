<?php

namespace App\Console\Commands;

use App\Http\Controllers\Health\Probes;
use Illuminate\Console\Command;
use Throwable;

/** `artisan agrotrace:probe <check>` — one readiness check (exit 0 ok, 1 fail), a child of getHealthReady. */
final class Probe extends Command
{
    protected $signature = 'agrotrace:probe {check}';

    protected $description = 'Run one readiness check (db, redis, rabbitmq, s3) bounded by HEALTH_TIMEOUT_MS';

    public function handle(): int
    {
        try {
            Probes::run((string) $this->argument('check'), max(0.1, (int) config('agrotrace.health_timeout_ms', 2000) / 1000));

            return self::SUCCESS;
        } catch (Throwable $e) {
            fwrite(STDERR, $e->getMessage()."\n");

            return self::FAILURE;
        }
    }
}
