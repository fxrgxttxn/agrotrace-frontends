<?php

/*
 * getHealthReady (Ruling Q7; brief «каждую проверку не дольше HEALTH_TIMEOUT_MS»): the four checks run in-process
 * against ONE shared deadline — dependencies that accept TCP and then never answer (a paused container, a stalled AOF
 * fsync) make the answer a 503 within about one HEALTH_TIMEOUT_MS, and the DB check never keeps its DbSlots slot.
 */

use App\Http\Controllers\Health\HealthController;
use App\Infrastructure\Db\DbSlots;
use App\Infrastructure\Db\PgConnector;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

it('answers 503 with every check failed within one HEALTH_TIMEOUT_MS when all dependencies stall', function () {
    // A listener that accepts every connection and never sends a byte.
    $server = proc_open(['php', '-r', '$s = stream_socket_server("tcp://127.0.0.1:0"); fwrite(STDOUT, stream_socket_get_name($s, false)."\n");'
        .' $c = []; while (true) { $x = @stream_socket_accept($s, 1); if ($x) { $c[] = $x; } }'], [1 => ['pipe', 'w']], $pipes);
    $addr = trim(fgets($pipes[1]));
    try {
        config([
            'agrotrace.health_timeout_ms' => 700,
            'database.connections.pgsql.url' => "postgres://u:p@{$addr}/x",
            'database.redis.default.url' => "redis://{$addr}/0",
            'agrotrace.rabbitmq_url' => "amqp://u:p@{$addr}/",
            'agrotrace.s3.endpoint' => "http://{$addr}",
        ]);
        $this->app['db']->purge('pgsql');
        $t = microtime(true);
        $res = $this->raw('GET', '/api/v1/health/ready');
        $elapsed = microtime(true) - $t;
        $res->assertStatus(503);
        expect($res->getContent())->toBe('{"status":"fail","checks":{"db":"fail","redis":"fail","rabbitmq":"fail","s3":"fail"}}');
        expect($elapsed)->toBeLessThan(0.7 + 0.3); // one shared deadline, not one per check
    } finally {
        proc_terminate($server, 9);
        proc_close($server);
    }
});

it('answers 200 with every check ok on the stand, and gives the DB slot back', function () {
    $this->requireDatabase();
    $dir = sys_get_temp_dir().'/at-ready-'.bin2hex(random_bytes(4));
    $slots = new DbSlots(1, $dir, true);
    $this->app->instance(DbSlots::class, $slots);
    $this->app->bind('db.connector.pgsql', fn () => new PgConnector($slots));
    try {
        $res = $this->raw('GET', '/api/v1/health/ready');
        $res->assertStatus(200);
        expect($res->getContent())->toBe('{"status":"ok","checks":{"db":"ok","redis":"ok","rabbitmq":"ok","s3":"ok"}}');
        expect($slots->held())->toBeFalse();
    } finally {
        $slots->release();
        @array_map('unlink', glob("{$dir}/*") ?: []);
        @rmdir($dir);
    }
});

it('marks a check fail without running it when the deadline has passed', function () {
    expect(HealthController::runWithin(['db', 'redis'], 0.001))->toBe(['db' => 'fail', 'redis' => 'fail']);
});
