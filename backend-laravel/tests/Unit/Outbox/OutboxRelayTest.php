<?php

/*
 * The outbox relay and sweeper (R56, R59, envelope; Relay, OutboxSweep) against a fake broker (FakePublisher), on
 * agrotrace_test_laravel. The races run the two sides in separate OS processes (separate PostgreSQL sessions,
 * tests/Fixtures/outbox/relay-child.php), every send appended to one shared log:
 * - the row lock is held across publish + confirm, so the other side skips an in-flight row — exactly one send, at
 *   every offset, in both directions, with four processes at once;
 * - a failed confirm releases the lock and leaves the row unpublished (retried); a process killed mid-confirm loses
 *   nothing (its session ends, the row is unlocked and published by the next pass);
 * - only this backend's rows of handled types are picked (Django Ruling Q12); retention R59; the advisory lock;
 *   a broker that is down skips the pass before any lock or transaction.
 */

use App\Events\EventHandlers;
use App\Infrastructure\Amqp\Broker;
use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Amqp\ConfirmPublisher;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Outbox\Relay;
use App\Scheduler\Jobs\OutboxSweep;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\FakePublisher;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

beforeEach(function () {
    $this->requireDatabase();
    DB::delete("DELETE FROM outbox_events WHERE backend = 'laravel'");
    $this->log = sys_get_temp_dir().'/at-relay-'.bin2hex(random_bytes(4)).'.log';
});

afterEach(function () {
    DB::delete("DELETE FROM outbox_events WHERE backend = 'laravel'");
    @unlink($this->log);
});

/** An outbox row (the envelope as its payload); returns its id. */
function outboxRow(string $type = 'vsd.import', string $backend = 'laravel', ?string $publishedAgo = null, string $createdAgo = '1 second'): string
{
    $id = (string) Str::uuid();
    $envelope = ['id' => $id, 'type' => $type, 'occurredAt' => '2026-10-22T10:00:00.000Z', 'backend' => $backend, 'requestId' => null,
        'data' => ['documentId' => (string) Str::uuid(), 'batchId' => (string) Str::uuid(), 'publicCode' => 'AT-2026-000001']];
    DB::insert('INSERT INTO outbox_events (id, backend, type, payload, created_at, published_at)
         VALUES (?, ?, ?, ?::jsonb, now() - ?::interval, CASE WHEN ?::text IS NULL THEN NULL ELSE now() - ?::interval END)',
        [$id, $backend, $type, json_encode($envelope), $createdAgo, $publishedAgo, $publishedAgo]);

    return $id;
}

function fakeRelay(string $log, string $who, int $confirmMs = 0, bool $fail = false): Relay
{
    return new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0, fn () => new FakePublisher($log, $who, $confirmMs, $fail));
}

/**
 * A relay or sweeper pass in a child process; returns once it is connected.
 *
 * @param  list<string>  $ids
 * @return array{0: resource, 1: array<int, resource>}
 */
function relayChild(string $mode, string $who, string $log, int $confirmMs, bool $fail = false, array $ids = []): array
{
    $proc = proc_open([PHP_BINARY, base_path('tests/Fixtures/outbox/relay-child.php'), $mode, $who, $log, (string) $confirmMs, $fail ? '1' : '0', implode(',', $ids)],
        [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
    expect(fgets($pipes[1]))->toBe("started\n");

    return [$proc, $pipes];
}

/** @param  array{0: resource, 1: array<int, resource>}  $child */
function relayChildResult(array $child): string
{
    $out = trim((string) stream_get_contents($child[1][1]));
    fclose($child[1][1]);
    proc_close($child[0]);

    return $out;
}

/** @return object{published_at: ?string, attempts: int} */
function outboxState(string $id): object
{
    return DB::selectOne('SELECT published_at::text AS published_at, attempts FROM outbox_events WHERE id = ?', [$id]);
}

it('a sweeper pass during the relay\'s confirm skips the in-flight row: exactly one send, at every offset', function (int $offsetMs) {
    $id = outboxRow();
    $relay = relayChild('relay', 'relay', $this->log, 1000, ids: [$id]);
    usleep($offsetMs * 1000);
    expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(0);
    expect(relayChildResult($relay))->toBe('published 1');
    $sends = FakePublisher::sends($this->log);
    expect(array_column($sends, 'who'))->toBe(['relay']);
    expect($sends[0]['id'])->toBe($id);
    expect($sends[0]['routingKey'])->toBe('vsd.import');
    expect(outboxState($id)->published_at)->not->toBeNull();
    expect((int) outboxState($id)->attempts)->toBe(1);
    // A later pass finds it published.
    expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(0);
    expect(count(FakePublisher::sends($this->log)))->toBe(1);
})->with([50, 500, 900]);

it('a relay during the sweeper\'s confirm skips the row the sweeper holds: exactly one send', function (int $offsetMs) {
    $id = outboxRow();
    $sweeper = relayChild('sweep', 'sweeper', $this->log, 1000);
    usleep($offsetMs * 1000);
    expect(fakeRelay($this->log, 'relay')->publish([$id]))->toBe(0);
    expect(relayChildResult($sweeper))->toBe('published 1');
    expect(array_column(FakePublisher::sends($this->log), 'who'))->toBe(['sweeper']);
    expect((int) outboxState($id)->attempts)->toBe(1);
})->with([50, 500, 900]);

it('two relays and two sweepers in four processes at once: one send in total', function () {
    $id = outboxRow();
    $children = [];
    foreach ([['relay', 'relay-1'], ['sweep', 'sweeper-1'], ['relay', 'relay-2'], ['sweep', 'sweeper-2']] as [$mode, $who]) {
        $children[] = relayChild($mode, $who, $this->log, 1500, ids: [$id]);
    }
    $results = array_map(fn ($c) => relayChildResult($c), $children);
    sort($results);
    expect($results)->toBe(['published 0', 'published 0', 'published 0', 'published 1']);
    expect(count(FakePublisher::sends($this->log)))->toBe(1);
    expect((int) outboxState($id)->attempts)->toBe(1);
});

it('a failed confirm releases the row lock and leaves the row unpublished; the next pass sends it again', function () {
    $id = outboxRow();
    $relay = relayChild('relay', 'relay', $this->log, 600, fail: true, ids: [$id]);
    usleep(200_000);
    expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(0);
    expect(relayChildResult($relay))->toStartWith('error '.BrokerUnavailable::class);
    expect(outboxState($id)->published_at)->toBeNull();
    expect((int) outboxState($id)->attempts)->toBe(0);
    // Not locked any more.
    DB::transaction(fn () => expect(DB::selectOne('SELECT id FROM outbox_events WHERE id = ? FOR NO KEY UPDATE NOWAIT', [$id])->id)->toBe($id));
    expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(1);
    expect(array_column(FakePublisher::sends($this->log), 'who'))->toBe(['relay', 'sweeper']);
    expect((int) outboxState($id)->attempts)->toBe(1);
});

it('a relay killed mid-confirm loses nothing: its session ends, the next pass publishes the row', function () {
    $id = outboxRow();
    $relay = relayChild('relay', 'relay', $this->log, 30_000, ids: [$id]);
    usleep(300_000);
    expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(0);
    proc_terminate($relay[0], 9);
    relayChildResult($relay);
    $published = 0;
    $deadline = microtime(true) + 5;
    while ($published === 0 && microtime(true) < $deadline) {
        $published = (new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep();
        usleep(50_000);
    }
    expect($published)->toBe(1);
    expect(array_column(FakePublisher::sends($this->log), 'who'))->toBe(['relay', 'sweeper']);
    expect(outboxState($id)->published_at)->not->toBeNull();
    expect((int) outboxState($id)->attempts)->toBe(1);
});

it('picks only this backend\'s unpublished rows of handled types, oldest first, at most 100 (Q12)', function () {
    expect(EventHandlers::types())->toBe(['vsd.import', 'lab.escalate', 'recall.requested', 'rating.recalculate']);
    $old = outboxRow(createdAgo: '3 minutes');
    $new = outboxRow(createdAgo: '1 minute');
    $unhandled = outboxRow('notification.dispatch', createdAgo: '5 minutes');
    $express = outboxRow('vsd.import', 'express', createdAgo: '4 minutes');
    try {
        expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(2);
        expect(array_column(FakePublisher::sends($this->log), 'id'))->toBe([$old, $new]);
        expect(outboxState($unhandled)->published_at)->toBeNull();
        expect(outboxState($express)->published_at)->toBeNull();
        // The relay ignores an unhandled id as well (it stays for the task that registers its handler).
        expect(fakeRelay($this->log, 'relay')->publish([$unhandled]))->toBe(0);
        for ($i = 0; $i < 105; $i++) {
            outboxRow();
        }
        expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(100);
        expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(5);
    } finally {
        DB::delete('DELETE FROM outbox_events WHERE id = ?', [$express]);
    }
});

it('the body is the envelope as compact JSON, routing key = type, message_id = id', function () {
    $id = outboxRow();
    $payload = DB::selectOne('SELECT payload::text AS p FROM outbox_events WHERE id = ?', [$id])->p;
    fakeRelay($this->log, 'relay')->publish([$id]);
    $send = FakePublisher::sends($this->log)[0];
    expect($send['sha'])->toBe(sha1(json_encode(json_decode($payload), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)));
    expect($send['id'])->toBe($id);
});

it('retention (R59): this backend\'s rows published over 7 days ago and processed events over 30 days ago go', function () {
    $gone = outboxRow(publishedAgo: '8 days', createdAgo: '8 days');
    $kept = outboxRow(publishedAgo: '6 days', createdAgo: '6 days');
    $express = outboxRow('vsd.import', 'express', publishedAgo: '8 days', createdAgo: '8 days');
    $ev = [(string) Str::uuid(), (string) Str::uuid(), (string) Str::uuid()];
    DB::insert("INSERT INTO processed_events (event_id, backend, processed_at) VALUES
        (?, 'laravel', now() - interval '31 days'), (?, 'laravel', now() - interval '29 days'), (?, 'express', now() - interval '31 days')", $ev);
    try {
        (new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep();
        expect(DB::selectOne('SELECT count(*) AS n FROM outbox_events WHERE id = ?', [$gone])->n)->toBe(0);
        expect(DB::selectOne('SELECT count(*) AS n FROM outbox_events WHERE id IN (?, ?)', [$kept, $express])->n)->toBe(2);
        expect(array_map(fn ($r) => $r->event_id, DB::select('SELECT event_id FROM processed_events WHERE event_id IN (?, ?, ?) ORDER BY processed_at', $ev)))
            ->toBe([$ev[2], $ev[1]]);
    } finally {
        DB::delete('DELETE FROM outbox_events WHERE id = ?', [$express]);
        DB::delete('DELETE FROM processed_events WHERE event_id IN (?, ?, ?)', $ev);
    }
});

it('skips the pass while another session holds the sweeper\'s advisory lock', function () {
    $id = outboxRow();
    config(['database.connections.other' => config('database.connections.pgsql')]);
    $other = DB::connection('other');
    $other->select("SELECT pg_advisory_lock(hashtext('agrotrace.outbox.laravel'))");
    try {
        expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(0);
        expect(outboxState($id)->published_at)->toBeNull();
    } finally {
        $other->select("SELECT pg_advisory_unlock(hashtext('agrotrace.outbox.laravel'))");
        $other->disconnect();
    }
    expect((new OutboxSweep(fakeRelay($this->log, 'sweeper')))->sweep())->toBe(1);
});

it('a broker that is down skips the pass before any lock or transaction is taken', function () {
    $id = outboxRow();
    $relay = new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0, fn () => throw new BrokerUnavailable('down'));
    expect((new OutboxSweep($relay))->sweep())->toBe(0);
    expect(fn () => $relay->publish([$id]))->toThrow(BrokerUnavailable::class);
    expect(outboxState($id)->published_at)->toBeNull();
    expect(DB::selectOne("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()")->n)->toBe(0);
});

it('the real Broker fails fast against a refused port and then backs off without touching the network', function () {
    $broker = new Broker('amqp://guest:guest@127.0.0.1:1/', 'test', 0.5);
    $started = microtime(true);
    expect(fn () => $broker->connection())->toThrow(BrokerUnavailable::class);
    expect(microtime(true) - $started)->toBeLessThan(0.6);
    $started = microtime(true);
    expect(fn () => $broker->connection())->toThrow(BrokerUnavailable::class, 'in back-off');
    expect(microtime(true) - $started)->toBeLessThan(0.01);
    expect($broker->backoffLeft())->toBeGreaterThan(0.0);
});

it('a serialization failure during the publish is never retried by the relay: one send, the row stays unpublished (M5)', function () {
    $id = outboxRow();
    $sends = new ArrayObject;
    $relay = new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0, fn () => new class($sends) implements ConfirmPublisher
    {
        public function __construct(private readonly ArrayObject $sends) {}

        public function publishAll(array $messages, float $timeoutSec = 10.0): void
        {
            $this->sends->append(count($messages));
            $e = new PDOException('could not serialize access');
            $e->errorInfo = ['40001', 7, 'could not serialize access'];
            throw $e;
        }

        public function isOpen(): bool
        {
            return true;
        }
    });
    expect(fn () => $relay->publish([$id]))->toThrow(PDOException::class);
    expect($sends->getArrayCopy())->toBe([1]);
    expect(outboxState($id)->published_at)->toBeNull();
    expect(DB::transactionLevel())->toBe(0);
    // Not locked any more.
    DB::transaction(fn () => expect(DB::selectOne('SELECT id FROM outbox_events WHERE id = ? FOR NO KEY UPDATE NOWAIT', [$id])->id)->toBe($id));
});

it('refuses to publish inside a transaction (the events must have committed first)', function () {
    $id = outboxRow();
    expect(fn () => Tx::run(fn () => fakeRelay($this->log, 'relay')->publish([$id])))->toThrow(LogicException::class);
    expect(FakePublisher::sends($this->log))->toBe([]);
});
