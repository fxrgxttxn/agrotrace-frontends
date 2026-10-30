<?php

// RelayLoopTest: the relay process (RelayLoop, as `agrotrace:relay` runs it) in its own OS process against the fake
// broker. argv: socket path, drop marker, send log, confirm ms, ids per publish, flush seconds.
// Prints `listening` once bound, then `stopped <ids left pending>` after SIGTERM.

use App\Infrastructure\Amqp\Broker;
use App\Infrastructure\Outbox\Relay;
use App\Infrastructure\Outbox\RelayLoop;
use Illuminate\Contracts\Console\Kernel;
use Tests\Support\FakePublisher;

require __DIR__.'/../../../vendor/autoload.php';
$app = require __DIR__.'/../../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
config(['database.connections.pgsql.url' => getenv('TEST_APP_DATABASE_URL')]);
$app['db']->purge('pgsql');

[, $socket, $marker, $log, $confirmMs, $perPublish, $flushSec] = $argv;
$relay = new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0, fn () => new FakePublisher($log, 'relay', (int) $confirmMs));
$loop = new RelayLoop($relay, RelayLoop::bind($socket), $socket, $marker, (int) $perPublish, catchUpEverySec: 3600.0);
pcntl_async_signals(true);
pcntl_signal(SIGTERM, fn () => $loop->stop());
echo "listening\n";
$left = $loop->run((float) $flushSec);
echo "stopped {$left}\n";
