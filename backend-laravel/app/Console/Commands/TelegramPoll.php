<?php

namespace App\Console\Commands;

use App\Infrastructure\Redis\SharedRedis;
use App\Infrastructure\Telegram\Poller;
use App\Infrastructure\Telegram\Telegram;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * `artisan agrotrace:telegram-poll` — the worker's Telegram poller (L2; App\Infrastructure\Telegram\Poller). Without
 * TELEGRAM_BOT_TOKEN it exits 0 at once (supervisord: an expected exit, not restarted). One PostgreSQL connection at
 * most, only while linking (P61: the worker's third). SIGTERM/SIGINT: the long poll is aborted, the key handed over.
 */
final class TelegramPoll extends Command
{
    protected $signature = 'agrotrace:telegram-poll';

    protected $description = 'Poll Telegram getUpdates while holding tg:poller (links /start <code>)';

    public function handle(): int
    {
        $telegram = Telegram::fromConfig();
        if (! $telegram->configured()) {
            Log::info('telegram poller not started: TELEGRAM_BOT_TOKEN is not set');

            return self::SUCCESS;
        }
        $poller = new Poller($telegram, SharedRedis::client(), Poller::instanceId());
        pcntl_async_signals(true);
        foreach ([SIGTERM, SIGINT] as $sig) {
            pcntl_signal($sig, fn () => $poller->stop());
        }
        Log::info('telegram poller started', ['instance' => $poller->instance]);
        $poller->run();
        Log::info('telegram poller stopped');

        return self::SUCCESS;
    }
}
