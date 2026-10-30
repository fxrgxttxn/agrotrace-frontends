<?php

/*
 * The SSE stream's own Redis pub/sub client (L3, plan risk 9): RESP2 parsed from fragments of any size, messages
 * returned in order, a timeout that returns null in time, a closed socket or a missing pong as a lost subscription.
 * The fragmented frames come from a tiny TCP server in a forked child; the pub/sub round trip uses the stand's Redis
 * (integration).
 */

use App\Infrastructure\Redis\SharedRedis;
use App\Sse\RespError;
use App\Sse\RespParser;
use App\Sse\RespSubscriber;
use Tests\TestCase;

uses(TestCase::class);

it('parses every RESP2 type, from any prefix of the bytes (INCOMPLETE until whole)', function () {
    $frames = [
        "+OK\r\n" => 'OK',
        ":42\r\n" => 42,
        "\$5\r\nhello\r\n" => 'hello',
        "\$0\r\n\r\n" => '',
        "\$-1\r\n" => null,
        "*-1\r\n" => null,
        "*3\r\n\$7\r\nmessage\r\n\$2\r\nch\r\n\$10\r\n{\"a\":\"\r\n\"}\r\n" => ['message', 'ch', "{\"a\":\"\r\n\"}"],
        "*2\r\n*1\r\n:1\r\n\$1\r\nx\r\n" => [[1], 'x'],
    ];
    foreach ($frames as $bytes => $want) {
        for ($cut = 0; $cut < strlen($bytes); $cut++) {
            $pos = 0;
            expect(RespParser::parse(substr($bytes, 0, $cut), $pos))->toBe(RespParser::INCOMPLETE);
            expect($pos)->toBe(0);
        }
        $pos = 0;
        expect(RespParser::parse($bytes."+NEXT\r\n", $pos))->toBe($want);
        expect($pos)->toBe(strlen($bytes));
    }
    $pos = 0;
    $err = RespParser::parse("-ERR wrong\r\n", $pos);
    expect($err)->toBeInstanceOf(RespError::class);
    expect($err->getMessage())->toBe('redis: ERR wrong');
});

/**
 * A one-connection TCP server in a child process that runs $script: a list of [delaySec, bytes] after the client's
 * first write, then closes (or keeps the socket open for $holdSec).
 *
 * @param  list<array{0: float, 1: string}>  $script
 * @return array{0: int, 1: int} [port, child pid]
 */
function respServer(array $script, float $holdSec = 0.0): array
{
    $srv = stream_socket_server('tcp://127.0.0.1:0', $errno, $err);
    expect($srv)->not->toBeFalse();
    $port = (int) substr((string) stream_socket_get_name($srv, false), strrpos((string) stream_socket_get_name($srv, false), ':') + 1);
    $pid = pcntl_fork();
    if ($pid === 0) {
        $c = @stream_socket_accept($srv, 5);
        if ($c !== false) {
            fread($c, 65536); // the client's commands
            foreach ($script as [$delay, $bytes]) {
                usleep((int) ($delay * 1_000_000));
                fwrite($c, $bytes);
                fflush($c);
            }
            usleep((int) ($holdSec * 1_000_000));
            fclose($c);
        }
        posix_kill(posix_getpid(), SIGKILL); // no shutdown handlers of the test runner in the child
    }
    fclose($srv);

    return [$port, $pid];
}

function reap(int $pid): void
{
    posix_kill($pid, SIGKILL);
    pcntl_waitpid($pid, $status);
}

it('subscribes, returns the GET values read before the subscription, then messages that arrive in pieces', function () {
    $confirm = "*3\r\n\$9\r\nsubscribe\r\n\$1\r\na\r\n:1\r\n*3\r\n\$9\r\nsubscribe\r\n\$1\r\nb\r\n:2\r\n";
    $msg = "*3\r\n\$7\r\nmessage\r\n\$1\r\na\r\n\$5\r\nhello\r\n";
    $script = [[0.0, "\$1\r\n7\r\n".substr($confirm, 0, 9)], [0.05, substr($confirm, 9)]];
    foreach (str_split($msg, 3) as $piece) {
        $script[] = [0.02, $piece];
    }
    $script[] = [0.0, "*3\r\n\$7\r\nmessage\r\n\$1\r\nb\r\n\$3\r\nbye\r\n"];
    [$port, $pid] = respServer($script, 1.0);
    try {
        $sub = new RespSubscriber('127.0.0.1', $port);
        expect($sub->subscribe(['a', 'b'], ['gen']))->toBe(['gen' => '7']);
        expect($sub->next(2.0))->toBe(['a', 'hello']);
        expect($sub->next(2.0))->toBe(['b', 'bye']);
        $t = microtime(true);
        expect($sub->next(0.3))->toBeNull();
        expect(microtime(true) - $t)->toBeGreaterThan(0.25)->toBeLessThan(0.8);
        // The server closes after its hold: the subscription is lost.
        expect(fn () => $sub->next(3.0))->toThrow(RespError::class);
        expect($sub->connected())->toBeFalse();
    } finally {
        reap($pid);
    }
});

it('sends PING in subscribed mode and treats a missing pong as a lost subscription', function () {
    $confirm = "*3\r\n\$9\r\nsubscribe\r\n\$1\r\na\r\n:1\r\n";
    [$port, $pid] = respServer([[0.0, $confirm]], 5.0);
    try {
        $sub = new RespSubscriber('127.0.0.1', $port, pingEverySec: 0.2, pongTimeoutSec: 0.3);
        $sub->subscribe(['a']);
        $t = microtime(true);
        expect(function () use ($sub) {
            while (true) {
                $sub->next(0.1);
            }
        })->toThrow(RespError::class, 'no pong');
        expect(microtime(true) - $t)->toBeGreaterThan(0.45)->toBeLessThan(1.5);
    } finally {
        reap($pid);
    }
});

it('round-trips through the stand\'s Redis: GET then SUBSCRIBE, PUBLISH arrives, a pong keeps it alive', function () {
    $redis = SharedRedis::client();
    $chan = 'agrotrace:laravel:sse:test:'.bin2hex(random_bytes(4));
    $key = $chan.':gen';
    $redis->set($key, '41', ['ex' => 60]);
    $sub = RespSubscriber::fromConfig();
    try {
        expect($sub->subscribe([$chan], [$key, $key.':missing']))->toBe([$key => '41', $key.':missing' => null]);
        expect($redis->publish($chan, '{"user_id":"u"}'))->toBe(1);
        expect($sub->next(2.0))->toBe([$chan, '{"user_id":"u"}']);
        expect($sub->next(0.05))->toBeNull();
    } finally {
        $sub->close();
        $redis->del($key);
    }
    $url = (string) config('database.redis.default.url');
    $quick = new RespSubscriber((string) (parse_url($url, PHP_URL_HOST) ?: 'redis'), (int) (parse_url($url, PHP_URL_PORT) ?: 6379),
        pingEverySec: 0.1, pongTimeoutSec: 1.0);
    try {
        $quick->subscribe([$chan]);
        $t = microtime(true);
        while (microtime(true) - $t < 0.6) {
            expect($quick->next(0.1))->toBeNull(); // pongs come back: no RespError
        }
    } finally {
        $quick->close();
    }
})->group('integration');
