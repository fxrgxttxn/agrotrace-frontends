<?php

namespace App\Infrastructure\Amqp;

/**
 * What the Consumer does to the channel a delivery came on (the real one: AmqpChannelPort; Pest: a fake broker).
 */
interface ChannelPort
{
    public function ack(int $deliveryTag): void;

    public function reject(int $deliveryTag, bool $requeue): void;

    public function nack(int $deliveryTag, bool $requeue): void;

    /** Cancels this channel's consumer (basic.cancel, waiting for cancel-ok); idempotent, a no-op once cancelled. */
    public function cancel(): void;

    /**
     * Publishes a copy of the delivery to the delay queue (default exchange, routing key = the queue) with `mandatory`
     * and waits for its confirm; throws BrokerUnavailable on basic.return, basic.nack or a confirm timeout.
     *
     * @param  array<string, mixed>  $properties
     */
    public function copyToDelay(string $queue, string $body, array $properties, string $messageId): void;
}
