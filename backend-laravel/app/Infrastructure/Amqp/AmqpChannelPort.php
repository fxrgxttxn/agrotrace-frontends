<?php

namespace App\Infrastructure\Amqp;

use PhpAmqpLib\Channel\AMQPChannel;

/** ChannelPort over a php-amqplib confirm channel (the consumer's own: acks and the delay copies share it, as Express). */
final class AmqpChannelPort implements ChannelPort
{
    private readonly Publisher $publisher;

    public function __construct(private readonly AMQPChannel $channel, private readonly float $confirmTimeoutSec = 10.0)
    {
        $this->publisher = new Publisher($channel);
    }

    public function ack(int $deliveryTag): void
    {
        $this->channel->basic_ack($deliveryTag);
    }

    public function reject(int $deliveryTag, bool $requeue): void
    {
        $this->channel->basic_reject($deliveryTag, $requeue);
    }

    public function nack(int $deliveryTag, bool $requeue): void
    {
        $this->channel->basic_nack($deliveryTag, false, $requeue);
    }

    public function copyToDelay(string $queue, string $body, array $properties, string $messageId): void
    {
        $this->publisher->publishAll([[
            'exchange' => '', 'routingKey' => $queue, 'body' => $body, 'messageId' => $messageId, 'mandatory' => true,
            'properties' => $properties,
        ]], $this->confirmTimeoutSec);
    }
}
