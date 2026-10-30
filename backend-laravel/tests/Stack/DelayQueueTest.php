<?php

/*
 * P56 on the real broker (`./at.sh laravel:stack`, worker-laravel running): the copy a busy vsd.import gets —
 * AmqpChannelPort::copyToDelay, mandatory + confirm to agrotrace.laravel.jobs.delay — waits there (TTL 5 s), dead-
 * letters to the TAIL of agrotrace.laravel.jobs and is consumed: the vsd.import handler claims it (an unknown document
 * → the claim alone). The state is polled with a generous deadline (no single management-stats read, no assumption
 * that the queues are idle — other suites may have a backlog). An unroutable copy comes back as basic.return.
 */

use App\Infrastructure\Amqp\AmqpChannelPort;
use App\Infrastructure\Amqp\Broker;
use App\Infrastructure\Amqp\BrokerUnavailable;

beforeEach(function () {
    if (! getenv('STACK_API')) {
        $this->markTestSkipped('STACK_API (host:port of api-laravel) is not set');
    }
});

function stackPdo(): PDO
{
    $u = parse_url((string) getenv('APP_DATABASE_URL'));

    return new PDO(sprintf('pgsql:host=%s;port=%d;dbname=%s', $u['host'], $u['port'] ?? 5432, ltrim($u['path'], '/')),
        rawurldecode($u['user']), rawurldecode($u['pass']), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

function uuid4(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0F) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3F) | 0x80);

    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

it('a delay copy returns from agrotrace.laravel.jobs.delay to the jobs queue after the TTL and is consumed', function () {
    $id = uuid4();
    $body = json_encode(['id' => $id, 'type' => 'vsd.import', 'occurredAt' => gmdate('Y-m-d\TH:i:s.000\Z'), 'backend' => 'laravel',
        'requestId' => 'stack-delay-copy', 'data' => ['documentId' => uuid4(), 'batchId' => uuid4(), 'publicCode' => 'AT-2026-999999']]);
    $broker = new Broker((string) getenv('RABBITMQ_URL'), 'laravel-stack-test');
    $port = new AmqpChannelPort($broker->channel());
    $sent = microtime(true);
    $port->copyToDelay('agrotrace.laravel.jobs.delay', $body, ['content_type' => 'application/json', 'delivery_mode' => 2], $id);
    $broker->reset();

    $pdo = stackPdo();
    $claimed = null;
    $deadline = $sent + 90;
    while ($claimed === null && microtime(true) < $deadline) {
        $st = $pdo->prepare("SELECT 1 FROM processed_events WHERE event_id = ? AND backend = 'laravel'");
        $st->execute([$id]);
        if ($st->fetchColumn() !== false) {
            $claimed = microtime(true) - $sent;
        } else {
            usleep(250_000);
        }
    }
    expect($claimed)->not->toBeNull('the copy was never consumed within 90 s');
    // It waited in the delay queue (TTL 5 s) before it came back: never handed straight back to the head.
    expect($claimed)->toBeGreaterThan(4.0);
    $pdo->prepare('DELETE FROM processed_events WHERE event_id = ?')->execute([$id]);
});

it('a copy that reaches no queue comes back as basic.return: BrokerUnavailable, never counted as re-scheduled', function () {
    $broker = new Broker((string) getenv('RABBITMQ_URL'), 'laravel-stack-test');
    $port = new AmqpChannelPort($broker->channel());
    $id = uuid4();
    expect(fn () => $port->copyToDelay('agrotrace.laravel.jobs.no-such-queue', '{}', [], $id))
        ->toThrow(BrokerUnavailable::class, 'basic.return');
    $broker->reset();
});
