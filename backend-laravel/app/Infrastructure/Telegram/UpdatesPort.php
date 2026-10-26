<?php

namespace App\Infrastructure\Telegram;

use GuzzleHttp\Promise\PromiseInterface;

/** What the poller needs of the Bot API (Telegram; a fake in TelegramPollerTest). */
interface UpdatesPort
{
    public function configured(): bool;

    /** Starts a long poll; the promise resolves to the updates or rejects. */
    public function getUpdatesAsync(?int $offset, int $timeoutSec): PromiseInterface;

    /** Drives in-flight calls for a short while (≤ ~0.2 s). */
    public function tick(): void;
}
