<?php

namespace App\Infrastructure\Amqp;

use App\Events\EventHandler;
use App\Events\Stopping;
use App\Infrastructure\Outbox\Relay;
use App\Support\Json;
use App\Support\RequestContext;
use App\Support\StopSignal;
use Closure;
use Illuminate\Support\Facades\Log;
use stdClass;
use Throwable;

/**
 * The worker side of the queue (R55, R56, R92, P56; envelope; L1, L2; Express infra/consumer.ts). One delivery at a
 * time on one channel (basic.qos prefetch 1); two `agrotrace:consume` processes make the worker's two channels.
 *
 * - A message that is not an envelope, or of a type without a handler, is rejected without requeue (→ the DLQ).
 * - At most ONE `vsd.import` runs per container (VsdLane, a non-blocking flock): a `vsd.import` delivered while it is
 *   taken is re-scheduled (P56) — the same message (body, message_id, content_type, persistent, its other properties)
 *   is published to `agrotrace.laravel.jobs.delay` (TTL 5 s, then back at the TAIL of the jobs queue) with
 *   `mandatory` and a confirm, and only then acknowledged. A basic.return or a negative confirm: not acknowledged, an
 *   error is logged, and after 1 s it is nack-requeued (the last resort, a broker-side failure only). It is never
 *   requeued to the head as the busy path.
 * - A failing handler is retried in-process after 2, 4, 8, 16 and 32 s (each attempt its own transaction — the
 *   handler's business), then rejected without requeue (→ the DLQ).
 * - stop() (SIGTERM; the brief's order): the consumption is cancelled first (basic.cancel, once the running handler
 *   returns, so no further delivery arrives), then the running delivery is settled, then the command closes the
 *   channel. A handler that fails while stopping, or gives up because of it (StopSignal, Stopping), is not retried
 *   any more. It is returned unacknowledged (nack requeue): a shutdown never dead-letters an event (Ruling: Express
 *   rejects it; see the Task 6 report).
 */
final class Consumer
{
    public const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];

    public const RESCHEDULE_FAILURE_PAUSE_MS = 1000;

    private bool $stopping = false;

    private readonly Closure $sleepMs;

    /**
     * @param  array<string, EventHandler>  $handlers  type => handler
     * @param  list<int>  $retryDelaysMs
     * @param  null|Closure(int): void  $sleepMs
     */
    public function __construct(
        private readonly array $handlers,
        private readonly VsdLane $lane,
        private readonly string $delayQueue = 'agrotrace.laravel.jobs.delay',
        private readonly array $retryDelaysMs = self::RETRY_DELAYS_MS,
        ?Closure $sleepMs = null,
        private readonly ?Relay $relay = null,
    ) {
        $this->sleepMs = $sleepMs ?? function (int $ms): void {
            // In 100 ms steps so a stop request (SIGTERM, async signals) ends a retry pause promptly.
            $until = microtime(true) + $ms / 1000;
            while (! $this->stopping && microtime(true) < $until) {
                usleep((int) min(100_000, max(0, ($until - microtime(true)) * 1_000_000)));
            }
        };
    }

    public function stop(): void
    {
        $this->stopping = true;
        app(StopSignal::class)->raise();
    }

    public function stopping(): bool
    {
        return $this->stopping;
    }

    /**
     * Handles one delivery and settles it on $channel.
     *
     * @param  array<string, mixed>  $properties
     */
    public function handle(string $body, array $properties, int $deliveryTag, ChannelPort $channel): void
    {
        $envelope = null;
        try {
            $envelope = Json::decode($body);
        } catch (Throwable) {
            // Below.
        }
        if (! $envelope instanceof stdClass || ! is_string($envelope->id ?? null) || ! is_string($envelope->type ?? null)) {
            Log::error('unreadable queue message; dead-lettering');
            $channel->reject($deliveryTag, false);

            return;
        }
        $handler = $this->handlers[$envelope->type] ?? null;
        if ($handler === null) {
            Log::error('no handler for the event type; dead-lettering', ['eventId' => $envelope->id, 'type' => $envelope->type]);
            $channel->reject($deliveryTag, false);

            return;
        }
        $isVsd = $envelope->type === 'vsd.import';
        if ($isVsd && ! $this->lane->tryAcquire()) {
            $this->reschedule($body, $properties, $deliveryTag, $envelope, $channel);

            return;
        }
        try {
            $ok = $this->run($handler, $envelope);
        } finally {
            if ($isVsd) {
                $this->lane->release();
            }
        }
        $this->cancelIfStopping($channel);
        match ($ok) {
            true => $channel->ack($deliveryTag),
            false => $channel->reject($deliveryTag, false),
            null => $channel->nack($deliveryTag, true),
        };
    }

    /**
     * P56: the busy `vsd.import` leaves this channel at once and comes back at the tail of the queue later.
     *
     * @param  array<string, mixed>  $properties
     */
    private function reschedule(string $body, array $properties, int $deliveryTag, stdClass $envelope, ChannelPort $channel): void
    {
        $messageId = is_string($properties['message_id'] ?? null) ? $properties['message_id'] : $envelope->id;
        try {
            $channel->copyToDelay($this->delayQueue, $body, $properties, $messageId);
        } catch (Throwable $e) {
            Log::error('vsd.import re-schedule failed; requeueing', ['eventId' => $envelope->id, 'err' => $e->getMessage()]);
            ($this->sleepMs)(self::RESCHEDULE_FAILURE_PAUSE_MS);
            $this->cancelIfStopping($channel);
            $channel->nack($deliveryTag, true);

            return;
        }
        $this->cancelIfStopping($channel);
        // Acknowledged only after the broker confirmed the copy: a crash in between leaves a duplicate (the claim
        // absorbs it), never a loss.
        $channel->ack($deliveryTag);
        Log::debug('vsd.import busy; re-scheduled', ['eventId' => $envelope->id]);
    }

    /**
     * The outbox events the handler committed are published right after its commit (Express: worker handlers call the
     * relay), never failing the handled event: a broker problem leaves them to the sweeper.
     */
    private function publishCommitted(): void
    {
        $ids = app(RequestContext::class)->takeEventIds();
        if ($ids === [] || $this->relay === null) {
            return;
        }
        try {
            $this->relay->publish($ids);
        } catch (Throwable $e) {
            Log::warning('worker relay failed; the sweeper publishes', ['eventIds' => $ids, 'err' => $e->getMessage()]);
        }
    }

    /**
     * Stop order (brief: cancel → finish → ack → close): once a stop was requested, the consumption is cancelled
     * before the running delivery is settled, so the broker pushes nothing more to this channel (prefetch 1 holds the
     * next one back until this settle). Idempotent on the port; a failed cancel is logged and the settle still happens.
     */
    private function cancelIfStopping(ChannelPort $channel): void
    {
        if (! $this->stopping) {
            return;
        }
        try {
            $channel->cancel();
        } catch (Throwable $e) {
            Log::warning('consumer cancel failed while stopping', ['err' => $e->getMessage()]);
        }
    }

    /** true — handled; false — failed after every retry (dead-letter); null — stopping, return it to the queue. */
    private function run(EventHandler $handler, stdClass $envelope): ?bool
    {
        for ($attempt = 0; ; $attempt++) {
            try {
                app()->forgetScopedInstances();
                app(RequestContext::class)->beginEvent(is_string($envelope->requestId ?? null) ? $envelope->requestId : null);
                $handler->handle($envelope);
                $this->publishCommitted();

                return true;
            } catch (Throwable $e) {
                // Stopping first: a failure caused by the stop (Stopping) or during it is never dead-lettered.
                if ($this->stopping || $e instanceof Stopping) {
                    Log::warning('event handler failed while stopping; returning it to the queue', ['eventId' => $envelope->id, 'err' => $e->getMessage()]);

                    return null;
                }
                if ($attempt >= count($this->retryDelaysMs)) {
                    Log::error('event handler failed; dead-lettering', ['eventId' => $envelope->id, 'type' => $envelope->type, 'err' => $e]);

                    return false;
                }
                Log::warning('event handler failed; retrying', ['eventId' => $envelope->id, 'type' => $envelope->type,
                    'attempt' => $attempt + 1, 'err' => $e->getMessage()]);
                ($this->sleepMs)($this->retryDelaysMs[$attempt]);
                if ($this->stopping) {
                    return null;
                }
            }
        }
    }
}
