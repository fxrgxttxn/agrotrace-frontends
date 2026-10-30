<?php

namespace App\Console\Commands;

use App\Infrastructure\Redis\SharedRedis;
use App\Sse\Hub;
use App\Sse\Stream;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * `artisan agrotrace:sse-hub` — the LISTEN session of api-laravel (L3; App\Sse\Hub), one process under supervisord.
 * SIGTERM/SIGINT: the loop ends within one poll (≤ 1 s) and the session closes.
 */
final class SseHub extends Command
{
    protected $signature = 'agrotrace:sse-hub';

    protected $description = 'LISTEN notifications and fan the payloads out to the SSE streams (Redis pub/sub)';

    public function handle(): int
    {
        $hub = new Hub(
            Hub::connectFromConfig(...),
            function (string $channel, string $message): void {
                try {
                    SharedRedis::client()->publish($channel, $message);
                } catch (\Throwable $e) {
                    app('redis')->purge(); // a fresh connection next time
                    throw $e;
                }
            },
            function (string $lostAt): int {
                try {
                    return (int) SharedRedis::client()->eval(Hub::RESYNC, [Stream::GEN_KEY, Stream::LOST_AT_KEY, Stream::CONTROL_CHANNEL, $lostAt], 3);
                } catch (\Throwable $e) {
                    app('redis')->purge();
                    throw $e;
                }
            },
        );
        pcntl_async_signals(true);
        foreach ([SIGTERM, SIGINT] as $sig) {
            pcntl_signal($sig, fn () => $hub->stop());
        }
        Log::info('sse hub started');
        $hub->run();
        Log::info('sse hub stopped');

        return self::SUCCESS;
    }
}
