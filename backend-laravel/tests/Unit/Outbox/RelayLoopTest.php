<?php

/*
 * The relay hand-off (review I1): RelayNotifier → the Unix datagram socket → RelayLoop → Relay, against the fake broker
 * (FakePublisher's shared send log) on agrotrace_test_laravel. No committed event id is ever lost, and none is sent twice:
 * - a full socket (EAGAIN): the senders touch the drop marker, and the loop catches the dropped ids up from the outbox;
 * - a relay restart (pending ids lost with the process, senders refused while nothing is bound): the next loop's
 *   start-up catch-up publishes them;
 * - SIGTERM mid-publish (a separate OS process, tests/Fixtures/outbox/relay-loop-child.php): the queued and pending ids
 *   are flushed before the exit;
 * - P61: the DB slot is kept while ids are pending and given back after the idle grace and on a broker failure.
 */

use App\Infrastructure\Amqp\Broker;
use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Outbox\Relay;
use App\Infrastructure\Outbox\RelayLoop;
use App\Infrastructure\Outbox\RelayNotifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\FakePublisher;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

beforeEach(function () {
    $this->requireDatabase();
    DB::delete("DELETE FROM outbox_events WHERE backend = 'laravel'");
    $tag = bin2hex(random_bytes(4));
    $this->log = sys_get_temp_dir()."/at-loop-{$tag}.log";
    $this->sock = sys_get_temp_dir()."/at-loop-{$tag}.sock";
    $this->marker = sys_get_temp_dir()."/at-loop-{$tag}.dropped";
});

afterEach(function () {
    DB::delete("DELETE FROM outbox_events WHERE backend = 'laravel'");
    foreach ([$this->log, $this->sock, $this->marker] as $f) {
        @unlink($f);
    }
});

/** Committed vsd.import outbox rows; returns their ids. @return list<string> */
function loopRows(int $n): array
{
    $ids = [];
    for ($i = 0; $i < $n; $i++) {
        $id = (string) Str::uuid();
        DB::insert("INSERT INTO outbox_events (id, backend, type, payload) VALUES (?, 'laravel', 'vsd.import', ?::jsonb)",
            [$id, json_encode(['id' => $id, 'type' => 'vsd.import', 'occurredAt' => '2026-10-22T10:00:00.000Z', 'backend' => 'laravel',
                'requestId' => null, 'data' => ['documentId' => (string) Str::uuid(), 'batchId' => (string) Str::uuid(), 'publicCode' => 'AT-2026-000001']])]);
        $ids[] = $id;
    }

    return $ids;
}

/**
 * @param  null|Closure(): void  $acquire
 * @param  null|Closure(): void  $release
 */
function loopFor(object $t, Relay $relay, int $perPublish = RelayLoop::PER_PUBLISH, float $idleGraceSec = 1.0, ?Closure $acquire = null, ?Closure $release = null): RelayLoop
{
    return new RelayLoop($relay, RelayLoop::bind($t->sock), $t->sock, $t->marker, $perPublish, 3600.0, $idleGraceSec,
        $acquire ?? fn () => null, $release ?? fn () => null);
}

function loopRelay(string $log, int $confirmMs = 0): Relay
{
    return new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0, fn () => new FakePublisher($log, 'relay', $confirmMs));
}

/** Every id published exactly once: in the send log once, and marked published in the outbox. @param list<string> $ids */
function expectPublishedOnce(string $log, array $ids): void
{
    $sent = array_count_values(array_column(FakePublisher::sends($log), 'id'));
    foreach ($ids as $id) {
        expect($sent[$id] ?? 0)->toBe(1, "sends of {$id}");
    }
    expect(array_sum($sent))->toBe(count($ids));
    $unpublished = DB::selectOne("SELECT count(*) AS n FROM outbox_events WHERE backend = 'laravel' AND published_at IS NULL")->n;
    expect($unpublished)->toBe(0);
}

it('a full socket loses nothing: the refused senders touch the marker and the loop catches their ids up, each sent once', function () {
    $loop = loopFor($this, loopRelay($this->log));
    $loop->tick(0.01); // start-up catch-up on an empty outbox
    $ids = loopRows(60);
    // One datagram per request, nobody reading: the socket fills (the kernel's default queue is 10 datagrams).
    $results = array_map(fn ($id) => RelayNotifier::send([$id], $this->sock, $this->marker), $ids);
    expect(in_array(false, $results, true))->toBeTrue();
    expect(is_file($this->marker))->toBeTrue();
    for ($i = 0; $i < 5; $i++) {
        $loop->tick(0.01);
    }
    expectPublishedOnce($this->log, $ids);
    expect(is_file($this->marker))->toBeFalse();
    $loop->shutdown(1.0);
});

it('a broker outage keeps the ids pending; a stop that cannot flush them leaves the marker for the next relay', function () {
    $loop = loopFor($this, new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0, fn () => throw new BrokerUnavailable('down')));
    $loop->tick(0.01);
    // The broker is down: the ids stay pending.
    $ids = loopRows(3);
    RelayNotifier::send($ids, $this->sock, $this->marker);
    $loop->tick(0.05);
    expect($loop->pendingCount())->toBe(3);
    $loop->shutdown(0.2);
    expect(DB::selectOne("SELECT count(*) AS n FROM outbox_events WHERE backend = 'laravel' AND published_at IS NULL")->n)->toBe(3);
    // A stop with ids pending leaves the marker for the next relay.
    expect(is_file($this->marker))->toBeTrue();
});

it('a relay restart loses nothing: ids pending in the dead process and ids refused while nothing was bound are caught up at start', function () {
    // Relay A: the broker is down, so the handed ids stay in its memory — then the process dies (no shutdown).
    $a = loopFor($this, new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0, fn () => throw new BrokerUnavailable('down')));
    $a->tick(0.01);
    $pendingInA = loopRows(5);
    expect(RelayNotifier::send($pendingInA, $this->sock, $this->marker))->toBeTrue();
    $a->tick(0.05);
    expect($a->pendingCount())->toBe(5);
    unset($a);
    @unlink($this->sock);
    // Nothing bound: the senders are refused and touch the marker.
    $refused = loopRows(4);
    foreach ($refused as $id) {
        expect(RelayNotifier::send([$id], $this->sock, $this->marker))->toBeFalse();
    }
    expect(FakePublisher::sends($this->log))->toBe([]);
    // Relay B starts: its start-up catch-up publishes all of them, once.
    $b = loopFor($this, loopRelay($this->log));
    $b->tick(0.01);
    expectPublishedOnce($this->log, [...$pendingInA, ...$refused]);
    // Later hand-offs of the same ids (late datagrams) send nothing again.
    RelayNotifier::send([...$pendingInA, ...$refused], $this->sock, $this->marker);
    $b->tick(0.05);
    expectPublishedOnce($this->log, [...$pendingInA, ...$refused]);
    $b->shutdown(1.0);
});

it('SIGTERM mid-publish flushes the queued and pending ids before the exit, each sent once', function () {
    $proc = proc_open([PHP_BINARY, base_path('tests/Fixtures/outbox/relay-loop-child.php'), $this->sock, $this->marker, $this->log, '300', '5', '8'],
        [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
    expect(fgets($pipes[1]))->toBe("listening\n");
    usleep(300_000); // past the child's start-up catch-up
    $ids = loopRows(40);
    // 8 datagrams of 5 (the socket holds them all), i.e. 8 chunks of 300 ms each.
    foreach (array_chunk($ids, 5) as $chunk) {
        expect(RelayNotifier::send($chunk, $this->sock, $this->marker))->toBeTrue();
    }
    $deadline = microtime(true) + 5;
    while (FakePublisher::sends($this->log) === [] && microtime(true) < $deadline) {
        usleep(20_000);
    }
    expect(count(FakePublisher::sends($this->log)))->toBeLessThan(40);
    // More ids arrive while it is in a confirm: they wait in the socket.
    $late = loopRows(5);
    expect(RelayNotifier::send($late, $this->sock, $this->marker))->toBeTrue();
    $stopped = microtime(true);
    proc_terminate($proc, SIGTERM);
    $out = trim((string) stream_get_contents($pipes[1]));
    fclose($pipes[1]);
    $code = proc_close($proc);
    expect($out)->toBe('stopped 0');
    expect($code)->toBe(0);
    expect(microtime(true) - $stopped)->toBeLessThan(8.0);
    expectPublishedOnce($this->log, [...$ids, ...$late]);
    // After the stop the name is gone: a later sender is refused and leaves the marker for the next relay.
    expect(file_exists($this->sock))->toBeFalse();
    expect(RelayNotifier::send(loopRows(1), $this->sock, $this->marker))->toBeFalse();
    expect(is_file($this->marker))->toBeTrue();
});

it('P61: the DB slot is kept while ids keep coming, given back after the idle grace and on a broker failure', function () {
    $events = [];
    $up = true;
    $relay = new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0, function () use (&$up) {
        if (! $up) {
            throw new BrokerUnavailable('down');
        }

        return new FakePublisher($this->log, 'relay');
    });
    $loop = loopFor($this, $relay, 2, 0.3, function () use (&$events) {
        $events[] = 'acquire';
    }, function () use (&$events) {
        $events[] = 'release';
    });
    $loop->tick(0.01);
    expect($events)->toBe(['acquire', 'release']); // the start-up catch-up found nothing pending: given back at once
    $events = [];
    for ($i = 0; $i < 3; $i++) {
        RelayNotifier::send(loopRows(3), $this->sock, $this->marker);
        $loop->tick(0.01);
        expect($loop->holdsDb())->toBeTrue();
    }
    expect(array_count_values($events))->toBe(['acquire' => 3]); // no release between the bursts
    usleep(350_000);
    $loop->tick(0.01);
    expect($loop->holdsDb())->toBeFalse();
    expect(end($events))->toBe('release');
    // A broker failure gives the slot back at once, before any DB work, and the ids stay pending.
    RelayNotifier::send(loopRows(1), $this->sock, $this->marker);
    $loop->tick(0.01);
    $events = [];
    $up = false;
    $relay->reset();
    RelayNotifier::send(loopRows(1), $this->sock, $this->marker);
    $loop->tick(0.01);
    expect($loop->pendingCount())->toBe(1);
    expect($loop->holdsDb())->toBeFalse();
    expect($events)->toBe(['release']);
    $up = true;
    usleep(550_000);
    $loop->tick(0.01);
    expect($loop->pendingCount())->toBe(0);
    $loop->shutdown(1.0);
    expect(DB::selectOne("SELECT count(*) AS n FROM outbox_events WHERE backend = 'laravel' AND published_at IS NULL")->n)->toBe(0);
});

it('the flush deadline counts from the stop request, not from the start of the shutdown (re-review N1)', function () {
    $loop = loopFor($this, new Relay(new Broker('amqp://none:none@127.0.0.1:1/', 'test'), 10.0, fn () => throw new BrokerUnavailable('down')));
    $loop->tick(0.01);
    $ids = loopRows(2);
    RelayNotifier::send($ids, $this->sock, $this->marker);
    $loop->tick(0.05);
    expect($loop->pendingCount())->toBe(2);
    $loop->stop();
    usleep(300_000); // the last tick still running when SIGTERM came
    $t0 = microtime(true);
    $loop->shutdown(0.3);
    // 0.3 s from the stop request: at most what is left of it, not a fresh 0.3 s.
    expect(microtime(true) - $t0)->toBeLessThan(0.15);
    expect(is_file($this->marker))->toBeTrue();
});
