<?php

/*
 * SP7, Global Constraints «Общие ключи Redis»: no key prefix, serializer or compression on any Laravel connection —
 * a key written through the facade is the bare key on the wire (read back here with raw RESP over a plain socket),
 * as Express and Django read and write it (`idem:`, `rl:`, `pub:batch:`, …).
 */

use Illuminate\Support\Facades\Redis;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

function rawRedisGetValue(string $key): ?string
{
    $url = parse_url((string) config('database.redis.default.url'));
    $sock = stream_socket_client(sprintf('tcp://%s:%d', $url['host'], $url['port'] ?? 6379), $errno, $err, 2.0);
    $db = isset($url['path']) && trim($url['path'], '/') !== '' ? trim($url['path'], '/') : '0';
    $cmd = fn (string ...$args) => '*'.count($args)."\r\n".implode('', array_map(fn ($a) => '$'.strlen($a)."\r\n{$a}\r\n", $args));
    fwrite($sock, $cmd('SELECT', $db).$cmd('GET', $key));
    $ok = fgets($sock);
    $head = fgets($sock);
    if ($ok !== "+OK\r\n" || $head === false || $head[0] !== '$' || $head === "\$-1\r\n") {
        fclose($sock);

        return null;
    }
    $value = fread($sock, (int) substr($head, 1) + 2);
    fclose($sock);

    return substr((string) $value, 0, -2);
}

it('writes the bare key: no prefix, no serializer, no compression', function () {
    $key = 'at-laravel-test:prefix:'.bin2hex(random_bytes(4));
    try {
        Redis::set($key, '{"state":"pending"}', 'EX', 30);
        expect(rawRedisGetValue($key))->toBe('{"state":"pending"}');
        expect(rawRedisGetValue('laravel_database_'.$key))->toBeNull();
        expect(Redis::get($key))->toBe('{"state":"pending"}');
        expect(config('database.redis.options.prefix'))->toBe('');
    } finally {
        Redis::del($key);
    }
});
