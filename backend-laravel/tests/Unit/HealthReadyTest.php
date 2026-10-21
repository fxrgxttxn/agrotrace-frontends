<?php

/*
 * getHealthReady (review I3; brief «каждую проверку не дольше HEALTH_TIMEOUT_MS»): the four checks run concurrently
 * and each is cut at HEALTH_TIMEOUT_MS — dependencies that accept TCP and then never answer (a paused container, a
 * stalled AOF fsync) make the whole answer a 503 within about one timeout, not the sum of four.
 */

use Tests\TestCase;

uses(TestCase::class)->group('integration');

/** @var array<string, string|false> */
function envSwap(array $vars): array
{
    $old = [];
    foreach ($vars as $k => $v) {
        $old[$k] = getenv($k);
        $v === false ? putenv($k) : putenv("{$k}={$v}");
    }

    return $old;
}

it('answers 503 with every check failed within one HEALTH_TIMEOUT_MS when all dependencies stall', function () {
    // A listener that accepts every connection and never sends a byte.
    $server = proc_open(['php', '-r', '$s = stream_socket_server("tcp://127.0.0.1:0"); fwrite(STDOUT, stream_socket_get_name($s, false)."\n");'
        .' $c = []; while (true) { $x = @stream_socket_accept($s, 1); if ($x) { $c[] = $x; } }'], [1 => ['pipe', 'w']], $pipes);
    $addr = trim(fgets($pipes[1]));
    $old = envSwap([
        'APP_DATABASE_URL' => "postgres://u:p@{$addr}/x",
        'REDIS_URL' => "redis://{$addr}/0",
        'RABBITMQ_URL' => "amqp://u:p@{$addr}/",
        'S3_ENDPOINT' => "http://{$addr}",
        'HEALTH_TIMEOUT_MS' => '700',
    ]);
    try {
        config(['agrotrace.health_timeout_ms' => 700]);
        $t = microtime(true);
        $res = $this->raw('GET', '/api/v1/health/ready');
        $elapsed = microtime(true) - $t;
        $res->assertStatus(503);
        expect($res->getContent())->toBe('{"status":"fail","checks":{"db":"fail","redis":"fail","rabbitmq":"fail","s3":"fail"}}');
        expect($elapsed)->toBeLessThan(1.8); // one timeout (+ process start); sequential would be at least 4 × 0.7 s
    } finally {
        envSwap($old);
        proc_terminate($server, 9);
        proc_close($server);
    }
});

it('answers 200 with every check ok on the stand', function () {
    $this->requireDatabase();
    $old = envSwap(['APP_DATABASE_URL' => getenv('TEST_APP_DATABASE_URL')]);
    try {
        $res = $this->raw('GET', '/api/v1/health/ready');
        $res->assertStatus(200);
        expect($res->getContent())->toBe('{"status":"ok","checks":{"db":"ok","redis":"ok","rabbitmq":"ok","s3":"ok"}}');
    } finally {
        envSwap($old);
    }
});
