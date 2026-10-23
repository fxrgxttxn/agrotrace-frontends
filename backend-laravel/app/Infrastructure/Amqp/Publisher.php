<?php

namespace App\Infrastructure\Amqp;

use PhpAmqpLib\Channel\AMQPChannel;
use PhpAmqpLib\Message\AMQPMessage;
use Throwable;

/**
 * Publishing with publisher confirms (R56, P56) on one confirm channel: every message is persistent with
 * `content_type application/json` and `message_id` (the event id); `publishAll` waits for the broker's confirms of the
 * whole batch (10 s). A negative confirm, a basic.return of a `mandatory` message (it reached no queue) or the timeout
 * throws BrokerUnavailable — then nothing of the batch counts as published (the caller closes the channel).
 */
final class Publisher implements ConfirmPublisher
{
    /** @var array<string, true> */
    private array $nacked = [];

    /** @var array<string, true> */
    private array $returned = [];

    public function __construct(private readonly AMQPChannel $channel)
    {
        $channel->set_nack_handler(function (AMQPMessage $m): void {
            $this->nacked[self::id($m)] = true;
        });
        $channel->set_ack_handler(function (AMQPMessage $m): void {});
        $channel->set_return_listener(function ($code, $text, $exchange, $routingKey, AMQPMessage $m): void {
            $this->returned[self::id($m)] = true;
        });
        $channel->confirm_select();
    }

    public function channel(): AMQPChannel
    {
        return $this->channel;
    }

    public function isOpen(): bool
    {
        return $this->channel->is_open();
    }

    /** @throws BrokerUnavailable */
    public function publish(string $exchange, string $routingKey, string $body, string $messageId, bool $mandatory, float $timeoutSec = 10.0): void
    {
        $this->publishAll([['exchange' => $exchange, 'routingKey' => $routingKey, 'body' => $body, 'messageId' => $messageId, 'mandatory' => $mandatory]], $timeoutSec);
    }

    /**
     * @param  list<array{exchange: string, routingKey: string, body: string, messageId: string, mandatory: bool, properties?: array<string, mixed>}>  $messages
     *
     * @throws BrokerUnavailable
     */
    public function publishAll(array $messages, float $timeoutSec = 10.0): void
    {
        if ($messages === []) {
            return;
        }
        $this->nacked = [];
        $this->returned = [];
        try {
            foreach ($messages as $m) {
                $props = ['content_type' => 'application/json', 'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT,
                    ...($m['properties'] ?? []), 'message_id' => $m['messageId']];
                $this->channel->basic_publish(new AMQPMessage($m['body'], $props), $m['exchange'], $m['routingKey'], $m['mandatory']);
            }
            $this->channel->wait_for_pending_acks_returns($timeoutSec);
        } catch (Throwable $e) {
            throw new BrokerUnavailable('rabbitmq publish: '.$e->getMessage(), 0, $e);
        }
        foreach ($messages as $m) {
            if ($this->flagged($this->returned, $m['messageId'])) {
                throw new BrokerUnavailable("rabbitmq publish: {$m['messageId']} returned unroutable (basic.return)");
            }
            if ($this->flagged($this->nacked, $m['messageId'])) {
                throw new BrokerUnavailable("rabbitmq publish: {$m['messageId']} confirmed negatively (basic.nack)");
            }
        }
    }

    /** @param  array<string, true>  $set  filled by the channel's handlers during the wait */
    private function flagged(array $set, string $messageId): bool
    {
        return isset($set[$messageId]);
    }

    private static function id(AMQPMessage $m): string
    {
        return $m->has('message_id') ? (string) $m->get('message_id') : '';
    }
}
