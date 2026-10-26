<?php

/*
 * The SSE hub (L3; App\Sse\Hub) on agrotrace_test_laravel: its own session, whose only statement is
 * `LISTEN notifications` (pg_stat_activity shows it, P48); a NOTIFY of user U goes unchanged to U's channel; a payload
 * without user_id goes nowhere; a terminated session (the stand's pg_terminate_backend) is reconnected and the resync
 * announced with the moment of the loss; the process start announces itself the same way.
 */

use App\Infrastructure\Redis\SharedRedis;
use App\Sse\Hub;
use App\Sse\RespSubscriber;
use App\Sse\Stream;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

it('forwards NOTIFY payloads per user, survives a terminated session and announces each resync', function () {
    $this->requireDatabase();
    $published = [];
    $resyncs = [];
    $hub = new Hub(Hub::connectFromConfig(...),
        function (string $channel, string $message) use (&$published): void {
            $published[] = [$channel, $message];
        },
        function (string $lostAt) use (&$resyncs): int {
            $resyncs[] = $lostAt;

            return count($resyncs);
        },
        probeSec: 30.0, pollMs: 200);
    $session = fn () => DB::select('SELECT pid, query FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = ?', [Hub::APPLICATION_NAME]);
    $until = function (callable $done) use ($hub): void {
        $t = microtime(true);
        while (! $done() && microtime(true) - $t < 10) {
            $hub->tick();
        }
    };
    $start = Hub::isoNow();
    $until(fn () => $session() !== []);
    expect($resyncs)->toHaveCount(1); // the first session of the process
    expect($resyncs[0] >= substr($start, 0, 19))->toBeTrue();
    expect(array_column($session(), 'query'))->toBe(['LISTEN notifications']);

    $user = '11111111-2222-4333-8444-555555555555';
    $payload = json_encode(['id' => '66666666-7777-4888-9999-000000000000', 'user_id' => $user]);
    DB::select("SELECT pg_notify('notifications', ?)", [$payload]);
    DB::select("SELECT pg_notify('notifications', '{\"unread\":true}')");
    DB::select("SELECT pg_notify('notifications', ?)", [json_encode(['user_id' => $user, 'unread' => true])]);
    $until(fn () => count($published) >= 2);
    expect($published)->toBe([
        [Stream::USER_CHANNEL.$user, $payload],
        [Stream::USER_CHANNEL.$user, '{"user_id":"11111111-2222-4333-8444-555555555555","unread":true}'],
    ]);

    // The stand's sanctioned action (P48): the LISTEN session is terminated.
    $killedAt = Hub::isoNow();
    DB::select('SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = ?', [Hub::APPLICATION_NAME]);
    $until(fn () => count($resyncs) >= 2);
    expect($resyncs)->toHaveCount(2);
    expect($resyncs[1] >= substr($killedAt, 0, 19))->toBeTrue();
    expect(array_column($session(), 'query'))->toBe(['LISTEN notifications']);
    // Live again.
    DB::select("SELECT pg_notify('notifications', ?)", [$payload]);
    $until(fn () => count($published) >= 3);
    expect($published[2])->toBe([Stream::USER_CHANNEL.$user, $payload]);
    $hub->stop();
});

it('the resync script increments the generation, records the loss and publishes {type, gen, lostAt}', function () {
    expect(Hub::RESYNC)->toContain("redis.call('INCR', KEYS[1])")
        ->toContain("redis.call('SET', KEYS[2], ARGV[1])")
        ->toContain("cjson.encode({type = 'resync', gen = g, lostAt = ARGV[1]})");
    $redis = SharedRedis::client();
    $p = 'agrotrace:laravel:sse:test:'.bin2hex(random_bytes(3));
    $sub = RespSubscriber::fromConfig();
    try {
        $sub->subscribe([$p.':control']);
        expect($redis->eval(Hub::RESYNC, ["{$p}:gen", "{$p}:lostAt", "{$p}:control", '2026-10-26T20:00:00.000Z'], 3))->toBe(1);
        expect($redis->eval(Hub::RESYNC, ["{$p}:gen", "{$p}:lostAt", "{$p}:control", '2026-10-26T20:00:01.000Z'], 3))->toBe(2);
        expect($redis->get("{$p}:lostAt"))->toBe('2026-10-26T20:00:01.000Z');
        $m = $sub->next(2.0);
        expect($m[0])->toBe($p.':control');
        expect(json_decode($m[1], true))->toEqual(['type' => 'resync', 'gen' => 1, 'lostAt' => '2026-10-26T20:00:00.000Z']);
    } finally {
        $sub->close();
        $redis->del("{$p}:gen", "{$p}:lostAt");
    }
});
