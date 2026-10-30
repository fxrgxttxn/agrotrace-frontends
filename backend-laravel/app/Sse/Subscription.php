<?php

namespace App\Sse;

/** The Redis pub/sub side of one stream (RespSubscriber; a fake in StreamTest). */
interface Subscription
{
    /**
     * (Re)connects and subscribes; $getKeys are read in the same write, right before the subscription.
     *
     * @param  list<string>  $channels
     * @param  list<string>  $getKeys
     * @return array<string, ?string>
     *
     * @throws RespError
     */
    public function subscribe(array $channels, array $getKeys = []): array;

    /**
     * The next message [channel, payload], or null after $timeoutSec without one.
     *
     * @return null|array{0: string, 1: string}
     *
     * @throws RespError
     */
    public function next(float $timeoutSec): ?array;

    public function close(): void;
}
