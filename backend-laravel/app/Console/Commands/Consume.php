<?php

namespace App\Console\Commands;

use App\Events\EventHandlers;
use App\Infrastructure\Amqp\AmqpChannelPort;
use App\Infrastructure\Amqp\Broker;
use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Amqp\Consumer;
use App\Infrastructure\Amqp\VsdLane;
use App\Infrastructure\Outbox\Relay;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;
use PhpAmqpLib\Exception\AMQPProtocolChannelException;
use PhpAmqpLib\Exception\AMQPTimeoutException;
use PhpAmqpLib\Message\AMQPMessage;
use Throwable;

/**
 * `artisan agrotrace:consume` — one consumer of `agrotrace.laravel.jobs` (L1, L2; worker-laravel runs two under
 * supervisord: the worker's two channels): one confirm channel, basic.qos prefetch 1, every delivery to Consumer.
 * - A channel the broker closes while the connection stays up (consumer_timeout, PRECONDITION_FAILED …) is opened
 *   again after 1 s; a lost connection reconnects with Broker's back-off (0.5 … 10 s).
 * - SIGTERM/SIGINT: the running handler finishes and its delivery is settled, then the consumer is cancelled and the
 *   channel and connection closed (unacknowledged deliveries return to the queue).
 */
final class Consume extends Command
{
    public const QUEUE = 'agrotrace.laravel.jobs';

    public const CHANNEL_REOPEN_SEC = 1.0;

    protected $signature = 'agrotrace:consume';

    protected $description = 'Consume agrotrace.laravel.jobs (one channel, prefetch 1)';

    public function handle(): int
    {
        // The handlers' own outbox events go out right after their commit on a separate confirm connection.
        $consumer = new Consumer(EventHandlers::resolve(), VsdLane::fromConfig(),
            relay: Relay::fromConfig('agrotrace-laravel-worker-relay-'.getmypid()));
        $broker = Broker::fromConfig('agrotrace-laravel-worker-'.getmypid());
        pcntl_async_signals(true);
        foreach ([SIGTERM, SIGINT] as $sig) {
            pcntl_signal($sig, fn () => $consumer->stop());
        }
        $unavailable = false;
        while (! $consumer->stopping()) {
            $channel = null;
            try {
                $channel = $broker->channel();
                $channel->basic_qos(0, 1, false);
                $port = new AmqpChannelPort($channel, (float) config('agrotrace.amqp.confirm_timeout_sec', 10.0));
                $tag = $channel->basic_consume(self::QUEUE, '', false, false, false, false,
                    function (AMQPMessage $m) use ($consumer, $port): void {
                        $consumer->handle($m->getBody(), $m->get_properties(), (int) $m->getDeliveryTag(), $port);
                    });
                Log::info('worker consuming', ['queue' => self::QUEUE, 'handlers' => EventHandlers::types()]);
                $unavailable = false;
                while ($channel->is_consuming() && ! $consumer->stopping()) {
                    try {
                        $channel->wait(null, false, 1.0);
                    } catch (AMQPTimeoutException) {
                        // Idle: look at the stop flag again.
                    }
                }
                if ($consumer->stopping()) {
                    $channel->basic_cancel($tag);
                    $channel->close();
                    $broker->reset();
                }
            } catch (AMQPProtocolChannelException $e) {
                Log::warning('consumer channel closed by the broker; reopening', ['err' => $e->getMessage()]);
                usleep((int) (self::CHANNEL_REOPEN_SEC * 1_000_000));
            } catch (BrokerUnavailable $e) {
                if (! $unavailable) {
                    Log::warning('rabbitmq unavailable; retrying', ['err' => $e->getMessage()]);
                }
                $unavailable = true;
                usleep((int) (max(0.2, $broker->backoffLeft()) * 1_000_000));
            } catch (Throwable $e) {
                Log::warning('rabbitmq connection lost; reconnecting', ['err' => $e->getMessage()]);
                $broker->reset();
                $broker->failed();
                usleep((int) (max(0.2, $broker->backoffLeft()) * 1_000_000));
            }
        }
        $broker->reset();
        Log::info('worker stopped');

        return self::SUCCESS;
    }
}
