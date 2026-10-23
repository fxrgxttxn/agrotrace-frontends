<?php

namespace App\Support;

/**
 * The process-wide stop request of a worker process (a container singleton). The consumer raises it on SIGTERM/SIGINT
 * (Consumer::stop), and long handlers look at it: VsdImport ends its Mercury back-off and gives the event back to the
 * queue instead of calling Mercury again (review M2). sleep() is a pause that ends early once a stop is requested.
 */
final class StopSignal
{
    private bool $raised = false;

    public function raise(): void
    {
        $this->raised = true;
    }

    public function raised(): bool
    {
        return $this->raised;
    }

    /** Sleeps $ms in steps of at most 100 ms; returns false when a stop request ended it early. */
    public function sleep(int $ms): bool
    {
        $until = microtime(true) + $ms / 1000;
        while (! $this->raised && microtime(true) < $until) {
            usleep((int) min(100_000, max(0, ($until - microtime(true)) * 1_000_000)));
        }

        return ! $this->raised;
    }
}
