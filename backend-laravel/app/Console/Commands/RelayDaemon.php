<?php

namespace App\Console\Commands;

use App\Infrastructure\Outbox\Relay;
use App\Infrastructure\Outbox\RelayLoop;
use App\Infrastructure\Outbox\RelayNotifier;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * `artisan agrotrace:relay`: the api container's relay process (supervisord, next to FrankenPHP; L4 placement in
 * the Task 6 report). It binds the hand-off socket and runs RelayLoop, which receives the ids of committed outbox
 * events from the Octane workers (RelayNotifier) and publishes them, and catches up from the outbox at start, on a
 * sender's drop marker and periodically. Requests never wait on the broker. The process holds at most ONE
 * PostgreSQL connection, from the container's DbSlots (P61). SIGTERM/SIGINT: unbind, drain, flush the pending ids
 * within FLUSH_SEC (inside supervisord's stopwaitsecs = 12), exit.
 */
final class RelayDaemon extends Command
{
    public const FLUSH_SEC = 8.0;

    protected $signature = 'agrotrace:relay';

    protected $description = 'Publish the outbox events the API committed (after the response, off the request path)';

    public function handle(): int
    {
        $path = RelayNotifier::socketPath();
        $loop = new RelayLoop(Relay::fromConfig('agrotrace-laravel-relay'), RelayLoop::bind($path), $path, RelayNotifier::droppedMarker());
        pcntl_async_signals(true);
        foreach ([SIGTERM, SIGINT] as $sig) {
            pcntl_signal($sig, fn () => $loop->stop());
        }
        Log::info('relay listening', ['socket' => $path]);
        $left = $loop->run(self::FLUSH_SEC);
        Log::info('relay stopped', ['pending' => $left]);

        return self::SUCCESS;
    }
}
