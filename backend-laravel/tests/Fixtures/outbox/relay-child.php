<?php

// OutboxRelayTest: one relay or sweeper pass in its own OS process (its own PostgreSQL session) against the fake broker.
// argv: mode (relay|sweep), who, send log, confirm ms, fail (0|1), event ids (comma-separated, relay only).
// Prints `started` once connected, then `published <n>`.

use App\Infrastructure\Amqp\Broker;
use App\Infrastructure\Outbox\Relay;
use App\Scheduler\Jobs\OutboxSweep;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;
use Tests\Support\FakePublisher;

require __DIR__.'/../../../vendor/autoload.php';
$app = require __DIR__.'/../../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
config(['database.connections.pgsql.url' => getenv('TEST_APP_DATABASE_URL')]);
$app['db']->purge('pgsql');

[, $mode, $who, $log, $confirmMs, $fail] = $argv;
$ids = array_values(array_filter(explode(',', $argv[6] ?? '')));
$relay = new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0,
    fn () => new FakePublisher($log, $who, (int) $confirmMs, $fail === '1'));
DB::selectOne('SELECT 1');
echo "started\n";
try {
    $n = $mode === 'relay' ? $relay->publish($ids) : (new OutboxSweep($relay))->sweep();
    echo "published {$n}\n";
} catch (Throwable $e) {
    echo 'error '.get_class($e).': '.$e->getMessage()."\n";
}
