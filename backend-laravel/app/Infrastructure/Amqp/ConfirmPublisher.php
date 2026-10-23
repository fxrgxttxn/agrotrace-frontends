<?php

namespace App\Infrastructure\Amqp;

/** A confirm channel to publish on (the real one: Publisher; Pest: a fake broker). */
interface ConfirmPublisher
{
    /**
     * Publishes the batch and waits for the broker's confirms; throws BrokerUnavailable on nack, return or timeout.
     *
     * @param  list<array{exchange: string, routingKey: string, body: string, messageId: string, mandatory: bool, properties?: array<string, mixed>}>  $messages
     */
    public function publishAll(array $messages, float $timeoutSec = 10.0): void;

    public function isOpen(): bool;
}
