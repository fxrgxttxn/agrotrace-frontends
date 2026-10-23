<?php

/*
 * Consumer on a fake broker (Review Focus 2, 3; envelope, P56, R92, L2): a busy vsd.import goes to the delay queue
 * (mandatory, confirmed) and is then acked — never nacked; a returned or refused copy is not acked, and after 1 s is
 * nack-requeued; other events flow while the lane is taken; a failing handler is retried 2/4/8/16/32 s, then rejected
 * without requeue; unreadable messages and unknown types are rejected; a stop during a retry returns the delivery.
 */

use App\Events\EventHandler;
use App\Events\Stopping;
use App\Infrastructure\Amqp\Broker;
use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Amqp\ChannelPort;
use App\Infrastructure\Amqp\Consumer;
use App\Infrastructure\Amqp\VsdLane;
use App\Infrastructure\Outbox\Relay;
use App\Support\RequestContext;
use App\Support\StopSignal;
use Tests\TestCase;

uses(TestCase::class);

final class FakeChannel implements ChannelPort
{
    /** @var list<string> */
    public array $calls = [];

    /** @var list<array{queue: string, body: string, properties: array<string, mixed>, messageId: string}> */
    public array $copies = [];

    public ?string $copyFails = null;

    public function ack(int $deliveryTag): void
    {
        $this->calls[] = "ack {$deliveryTag}";
    }

    public function reject(int $deliveryTag, bool $requeue): void
    {
        $this->calls[] = "reject {$deliveryTag} ".($requeue ? 'requeue' : 'no-requeue');
    }

    public function nack(int $deliveryTag, bool $requeue): void
    {
        $this->calls[] = "nack {$deliveryTag} ".($requeue ? 'requeue' : 'no-requeue');
    }

    public function cancel(): void
    {
        $this->calls[] = 'cancel';
    }

    public function copyToDelay(string $queue, string $body, array $properties, string $messageId): void
    {
        $this->calls[] = "copy {$queue}";
        if ($this->copyFails !== null) {
            throw new BrokerUnavailable($this->copyFails);
        }
        $this->copies[] = compact('queue', 'body', 'properties', 'messageId');
    }
}

final class RecordingHandler implements EventHandler
{
    /** @var list<string> */
    public array $handled = [];

    /** @var list<?string> */
    public array $requestIds = [];

    public function __construct(public int $failures = 0) {}

    public function handle(stdClass $envelope): void
    {
        $this->requestIds[] = app(RequestContext::class)->eventRequestId();
        if ($this->failures-- > 0) {
            throw new RuntimeException('boom');
        }
        $this->handled[] = $envelope->id;
    }
}

function envelopeBody(string $type, string $id = 'e1', ?string $requestId = 'req-1'): string
{
    return json_encode(['id' => $id, 'type' => $type, 'occurredAt' => '2026-10-22T10:00:00.000Z', 'backend' => 'laravel',
        'requestId' => $requestId, 'data' => new stdClass]);
}

function laneFile(): string
{
    return sys_get_temp_dir().'/at-vsd-lane-'.getmypid().'-'.bin2hex(random_bytes(3));
}

beforeEach(function () {
    $this->sleeps = [];
    $this->sleep = function (int $ms) {
        $this->sleeps[] = $ms;
    };
});

it('a busy vsd.import is copied to the delay queue (mandatory, confirmed) and then acked — never nacked', function () {
    $file = laneFile();
    $holder = new VsdLane($file);
    expect($holder->tryAcquire())->toBeTrue();
    $handler = new RecordingHandler;
    $consumer = new Consumer(['vsd.import' => $handler], new VsdLane($file), sleepMs: $this->sleep);
    $ch = new FakeChannel;
    $props = ['content_type' => 'application/json', 'delivery_mode' => 2, 'message_id' => 'e1'];
    $consumer->handle(envelopeBody('vsd.import'), $props, 7, $ch);
    expect($ch->calls)->toBe(['copy agrotrace.laravel.jobs.delay', 'ack 7']);
    expect($ch->copies[0])->toMatchArray(['queue' => 'agrotrace.laravel.jobs.delay', 'body' => envelopeBody('vsd.import'),
        'properties' => $props, 'messageId' => 'e1']);
    expect($handler->handled)->toBe([]);
    expect($this->sleeps)->toBe([]);
    $holder->release();
    @unlink($file);
});

it('a copy returned or refused by the broker is not acked: logged, then nack-requeued after 1 s', function () {
    $file = laneFile();
    $holder = new VsdLane($file);
    $holder->tryAcquire();
    $consumer = new Consumer(['vsd.import' => new RecordingHandler], new VsdLane($file), sleepMs: $this->sleep);
    $ch = new FakeChannel;
    $ch->copyFails = 'returned unroutable (basic.return)';
    $consumer->handle(envelopeBody('vsd.import'), ['message_id' => 'e1'], 3, $ch);
    expect($ch->calls)->toBe(['copy agrotrace.laravel.jobs.delay', 'nack 3 requeue']);
    expect($this->sleeps)->toBe([1000]);
    $holder->release();
    @unlink($file);
});

it('the copy keeps the event id as message_id when the delivery had none', function () {
    $file = laneFile();
    $holder = new VsdLane($file);
    $holder->tryAcquire();
    $consumer = new Consumer(['vsd.import' => new RecordingHandler], new VsdLane($file), sleepMs: $this->sleep);
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('vsd.import', 'ev-9'), [], 1, $ch);
    expect($ch->copies[0]['messageId'])->toBe('ev-9');
    $holder->release();
    @unlink($file);
});

it('other events flow while the vsd lane is taken; a free lane runs the vsd.import and frees it again', function () {
    $file = laneFile();
    $holder = new VsdLane($file);
    $holder->tryAcquire();
    $vsd = new RecordingHandler;
    $notify = new RecordingHandler;
    $consumer = new Consumer(['vsd.import' => $vsd, 'notification.dispatch' => $notify], new VsdLane($file), sleepMs: $this->sleep);
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('notification.dispatch', 'n1'), [], 1, $ch);
    expect($ch->calls)->toBe(['ack 1']);
    expect($notify->handled)->toBe(['n1']);
    $holder->release();
    $consumer->handle(envelopeBody('vsd.import', 'v1'), [], 2, $ch);
    expect($vsd->handled)->toBe(['v1']);
    expect($ch->calls)->toBe(['ack 1', 'ack 2']);
    expect($holder->tryAcquire())->toBeTrue(); // released after the handler
    $holder->release();
    @unlink($file);
});

it('a failing handler is retried in-process after 2, 4, 8, 16, 32 s, then rejected without requeue', function () {
    $handler = new RecordingHandler(failures: 99);
    $consumer = new Consumer(['rating.recalculate' => $handler], new VsdLane(laneFile()), sleepMs: $this->sleep);
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('rating.recalculate'), [], 5, $ch);
    expect($this->sleeps)->toBe([2000, 4000, 8000, 16000, 32000]);
    expect($ch->calls)->toBe(['reject 5 no-requeue']);
    expect($handler->requestIds)->toBe(array_fill(0, 6, 'req-1'));
});

it('a handler that recovers within the retries is acked', function () {
    $handler = new RecordingHandler(failures: 2);
    $consumer = new Consumer(['rating.recalculate' => $handler], new VsdLane(laneFile()), sleepMs: $this->sleep);
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('rating.recalculate'), [], 5, $ch);
    expect($this->sleeps)->toBe([2000, 4000]);
    expect($ch->calls)->toBe(['ack 5']);
});

it('unreadable messages and types without a handler are rejected without requeue', function (string $body) {
    $consumer = new Consumer(['vsd.import' => new RecordingHandler], new VsdLane(laneFile()), sleepMs: $this->sleep);
    $ch = new FakeChannel;
    $consumer->handle($body, [], 9, $ch);
    expect($ch->calls)->toBe(['reject 9 no-requeue']);
})->with(['not json', '[]', '{"id":1,"type":"vsd.import"}', envelopeBody('lab.escalate')]);

it('stopping: a failing handler is not retried any more; its delivery returns to the queue (nack requeue), never the DLQ', function () {
    $handler = new RecordingHandler(failures: 99);
    $consumer = null;
    $consumer = new Consumer(['rating.recalculate' => $handler], new VsdLane(laneFile()), sleepMs: function (int $ms) use (&$consumer) {
        $this->sleeps[] = $ms;
        $consumer->stop();
    });
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('rating.recalculate'), [], 4, $ch);
    expect($this->sleeps)->toBe([2000]);
    expect($ch->calls)->toBe(['cancel', 'nack 4 requeue']); // cancelled before the settle (stop order)
});

it('the handled event\'s requestId tags the worker (logs, enqueued events); audit stays system (no request id)', function () {
    $handler = new RecordingHandler;
    $consumer = new Consumer(['vsd.import' => $handler], new VsdLane(laneFile()), sleepMs: $this->sleep);
    $consumer->handle(envelopeBody('vsd.import', 'e2', 'req-77'), [], 1, new FakeChannel);
    expect($handler->requestIds)->toBe(['req-77']);
    expect(app(RequestContext::class)->requestId())->toBeNull();
    expect(app(RequestContext::class)->logRequestId())->toBe('req-77');
});

it('the outbox events a handler committed are handed to the relay after it (a relay failure never fails the event)', function () {
    $handler = new class implements EventHandler
    {
        public function handle(stdClass $envelope): void
        {
            app(RequestContext::class)->addEventId('11111111-1111-4111-8111-111111111111');
        }
    };
    $relay = new Relay(new Broker('amqp://x:y@127.0.0.1:1/', 't'), 1.0,
        fn () => throw new BrokerUnavailable('down'));
    $consumer = new Consumer(['rating.recalculate' => $handler], new VsdLane(laneFile()), sleepMs: $this->sleep, relay: $relay);
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('rating.recalculate'), [], 2, $ch);
    expect($ch->calls)->toBe(['ack 2']);
    expect(app(RequestContext::class)->eventIds())->toBe([]);
});

it('stop order (brief): a stop during the handler cancels the consumer first, then the delivery is acked (review M6)', function () {
    $handler = new class implements EventHandler
    {
        public ?Consumer $consumer = null;

        public function handle(stdClass $envelope): void
        {
            $this->consumer?->stop(); // SIGTERM arrives while the handler runs
        }
    };
    $consumer = new Consumer(['rating.recalculate' => $handler], new VsdLane(laneFile()), sleepMs: $this->sleep);
    $handler->consumer = $consumer;
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('rating.recalculate'), [], 6, $ch);
    expect($ch->calls)->toBe(['cancel', 'ack 6']);
    expect(app(StopSignal::class)->raised())->toBeTrue(); // long handlers see the stop too
});

it('a busy vsd.import re-scheduled while stopping: cancel, then the ack after the confirmed copy', function () {
    $file = laneFile();
    $holder = new VsdLane($file);
    $holder->tryAcquire();
    $consumer = new Consumer(['vsd.import' => new RecordingHandler], new VsdLane($file), sleepMs: $this->sleep);
    $consumer->stop();
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('vsd.import'), ['message_id' => 'e1'], 8, $ch);
    expect($ch->calls)->toBe(['copy agrotrace.laravel.jobs.delay', 'cancel', 'ack 8']);
    $holder->release();
    @unlink($file);
});

it('a handler giving up because of the stop (Stopping) is returned to the queue even on its last attempt, never the DLQ', function () {
    $handler = new class implements EventHandler
    {
        public int $calls = 0;

        public function handle(stdClass $envelope): void
        {
            $this->calls++;
            throw new Stopping('stopping');
        }
    };
    $consumer = new Consumer(['rating.recalculate' => $handler], new VsdLane(laneFile()), retryDelaysMs: [], sleepMs: $this->sleep);
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('rating.recalculate'), [], 3, $ch);
    expect($handler->calls)->toBe(1);
    expect($this->sleeps)->toBe([]);
    expect($ch->calls)->toBe(['nack 3 requeue']);
});

it('the default retry pause ends within ~100 ms of a stop request', function () {
    $consumer = new Consumer(['rating.recalculate' => new RecordingHandler(failures: 1)], new VsdLane(laneFile()));
    pcntl_async_signals(true);
    pcntl_signal(SIGALRM, fn () => $consumer->stop());
    $started = microtime(true);
    pcntl_alarm(1);
    $ch = new FakeChannel;
    $consumer->handle(envelopeBody('rating.recalculate'), [], 2, $ch);
    pcntl_signal(SIGALRM, SIG_DFL);
    expect(microtime(true) - $started)->toBeLessThan(1.5); // the first pause is 2 s
    expect($ch->calls)->toBe(['cancel', 'nack 2 requeue']);
});
