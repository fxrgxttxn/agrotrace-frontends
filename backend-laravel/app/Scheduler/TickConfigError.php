<?php

namespace App\Scheduler;

use App\Support\EnvConfig;
use InvalidArgumentException;

/** SCHEDULER_TICK_MS (or a job's period) that maps to no Scheduler frequency: the process exits with 78 (EX_CONFIG). */
final class TickConfigError extends InvalidArgumentException
{
    public function __construct(string $message)
    {
        parent::__construct($message, EnvConfig::EXIT_CONFIG);
    }
}
