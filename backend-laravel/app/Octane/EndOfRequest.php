<?php

namespace App\Octane;

use App\Infrastructure\Db\DbSlots;
use App\Infrastructure\Outbox\RelayNotifier;
use App\Support\RequestContext;
use Illuminate\Contracts\Container\Container;
use Laravel\Octane\Events\RequestTerminated;
use Throwable;

/**
 * The end of a request, after the response was sent (L4 order): the after-response callbacks (the relay, Task 12;
 * metrics, Task 14) → DB::disconnect() → the DbSlots slot freed. RequestContext itself is scoped and dies with the
 * request sandbox. Runs as the terminable part of RequestContextMw (Kernel::terminate, also outside Octane) and as the
 * Octane RequestTerminated listener (config/octane.php) — idempotent, the second run finds nothing to do.
 */
final class EndOfRequest
{
    public function handle(RequestTerminated $event): void
    {
        self::finish($event->sandbox);
    }

    public static function finish(Container $app): void
    {
        if ($app->bound(RequestContext::class)) {
            $ctx = $app->make(RequestContext::class);
            // The response is out: the end of the request's measured duration, before the relay and the
            // after-response work (a mail delivery) that follow (Express's metrics end on `finish`).
            $ctx->markSent();
            // The relay (L4 order: right after the response): the committed events go to the relay process — a
            // non-blocking datagram, never a wait on the broker (RelayNotifier; a failed hand-off is caught up by the relay).
            try {
                RelayNotifier::send($ctx->takeEventIds());
            } catch (Throwable $e) {
                report($e);
            }
            foreach ($ctx->takeAfterResponse() as $callback) {
                try {
                    $callback();
                } catch (Throwable $e) {
                    report($e);
                }
            }
        }
        try {
            $app->make('db')->disconnect();
        } finally {
            $app->make(DbSlots::class)->release();
        }
    }
}
