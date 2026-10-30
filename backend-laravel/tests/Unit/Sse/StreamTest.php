<?php

/*
 * App\Sse\Stream against fakes (no FrankenPHP, Redis or DB): the connect sequence (replay for L with the late-commit
 * window, W, the buffer flushed sorted and deduplicated, N1, `unread`), live events, resync and a lost subscription
 * (only what was missed, never the history), ping/reauth timing on a fake clock, the DB slot given back after every
 * step, and the end conditions — a client that is gone, and more than 1 MiB not taken (the frames written before stay
 * written; a client that reads gets a big replay whole).
 */

use App\Sse\RespError;
use App\Sse\Stream;
use App\Sse\StreamIo;
use App\Sse\StreamStore;
use App\Sse\Subscription;
use Tests\TestCase;

uses(TestCase::class);

final class StreamClock
{
    public float $now = 1_800_000_000.0;
}

final class FakeSub implements Subscription
{
    /** @var list<array{0: string, 1: string}|RespError> */
    public array $queue = [];

    public string $gen = '0';

    public int $subscribes = 0;

    public ?RespError $failSubscribe = null;

    /** @var null|Closure(FakeSub): void called when the stream waits with nothing queued */
    public ?Closure $onIdle = null;

    public function __construct(private readonly StreamClock $clock) {}

    public function subscribe(array $channels, array $getKeys = []): array
    {
        $this->subscribes++;
        if ($this->failSubscribe !== null) {
            $e = $this->failSubscribe;
            $this->failSubscribe = null;
            throw $e;
        }

        return array_fill_keys($getKeys, $this->gen);
    }

    public function next(float $timeoutSec): ?array
    {
        if ($this->queue === [] && $timeoutSec > 0 && $this->onIdle !== null) {
            ($this->onIdle)($this);
        }
        if ($this->queue !== []) {
            $m = array_shift($this->queue);
            if ($m instanceof RespError) {
                throw $m;
            }

            return $m;
        }
        $this->clock->now += max($timeoutSec, 0.001);

        return null;
    }

    public function close(): void {}

    public function notify(string $userId, ?string $id = null): void
    {
        $this->queue[] = [Stream::USER_CHANNEL.$userId, json_encode($id !== null ? ['id' => $id, 'user_id' => $userId] : ['user_id' => $userId, 'unread' => true])];
    }
}

final class FakeStore implements StreamStore
{
    /** @var array<string, array{id: string, seq: int, type: string, payload: mixed, isRead: bool, createdAt: string, user: string}> */
    public array $rows = [];

    public int $releases = 0;

    public int $seq = 100;

    public function add(string $user, int $createdAgoSec = 0, bool $read = false, ?StreamClock $clock = null): array
    {
        $this->seq++;
        $t = ($clock?->now ?? 1_800_000_000.0) - $createdAgoSec;
        $id = sprintf('00000000-0000-4000-8000-%012d', $this->seq);
        $this->rows[$id] = ['id' => $id, 'seq' => $this->seq, 'type' => 'COMPLAINT', 'payload' => new stdClass,
            'isRead' => $read, 'createdAt' => gmdate('Y-m-d\TH:i:s.000\Z', (int) $t), 'user' => $user];

        return $this->rows[$id];
    }

    private function mine(string $user): array
    {
        $rows = array_values(array_filter($this->rows, fn ($r) => $r['user'] === $user));
        usort($rows, fn ($a, $b) => $a['seq'] <=> $b['seq']);

        return $rows;
    }

    private static function view(array $r): array
    {
        unset($r['user']);

        return $r;
    }

    public function maxSeq(string $userId): int
    {
        return max([0, ...array_column($this->mine($userId), 'seq')]);
    }

    public function replay(string $userId, int $lastSeq, int $after, int $limit): array
    {
        $l = null;
        foreach ($this->mine($userId) as $r) {
            if ($r['seq'] === $lastSeq) {
                $l = strtotime($r['createdAt']);
            }
        }
        $out = array_filter($this->mine($userId), fn ($r) => $r['seq'] > $after && ($r['seq'] > $lastSeq
            || ($r['seq'] < $lastSeq && ! $r['isRead'] && $l !== null && strtotime($r['createdAt']) >= $l - 60)));

        return array_map(self::view(...), array_slice(array_values($out), 0, $limit));
    }

    public function catchUp(string $userId, int $watermark, string $sinceIso, int $after, int $limit): array
    {
        $since = strtotime($sinceIso);
        $out = array_filter($this->mine($userId), fn ($r) => $r['seq'] > $after && ($r['seq'] > $watermark
            || ($r['seq'] < $watermark && ! $r['isRead'] && strtotime($r['createdAt']) >= $since - 60)));

        return array_map(self::view(...), array_slice(array_values($out), 0, $limit));
    }

    public function row(string $userId, string $id): ?array
    {
        $r = $this->rows[$id] ?? null;

        return $r !== null && $r['user'] === $userId ? self::view($r) : null;
    }

    public function unread(string $userId): int
    {
        return count(array_filter($this->mine($userId), fn ($r) => ! $r['isRead']));
    }

    public function release(): void
    {
        $this->releases++;
    }
}

final class FakeIo implements StreamIo
{
    /** @var list<string> */
    public array $frames = [];

    public int $written = 0;

    public bool $gone = false;

    /** Bytes the client has taken (null: it takes everything at once). */
    public ?int $taken = null;

    public function write(string $bytes): bool
    {
        if ($this->gone) {
            return false;
        }
        $this->frames[] = $bytes;
        $this->written += strlen($bytes);

        return true;
    }

    public function gone(): bool
    {
        return $this->gone;
    }

    public function backlog(): ?int
    {
        return $this->taken === null ? 0 : $this->written - $this->taken;
    }

    /** @return list<string> event names, with `notification` as `n:<seq>` */
    public function events(): array
    {
        return array_map(function (string $f): string {
            preg_match('/^(?:id: (\d+)\n)?event: (\w+)\n/', $f, $m);

            return $m[2] === 'notification' ? 'n:'.$m[1] : ($m[2] === 'unread' ? 'unread:'.json_decode(substr($f, strpos($f, 'data: ') + 6))->count : $m[2]);
        }, $this->frames);
    }
}

const SSE_USER = '11111111-1111-4111-8111-111111111111';

/** @return array{0: Stream, 1: FakeSub, 2: FakeStore, 3: FakeIo, 4: StreamClock} */
function sseStream(?string $lastSeq = null, ?FakeStore $store = null, int $ttl = 900, ?Closure $readGen = null, ?StreamClock $clock = null): array
{
    $clock ??= new StreamClock;
    $sub = new FakeSub($clock);
    $store ??= new FakeStore;
    $io = new FakeIo;
    $stream = new Stream(SSE_USER, (int) $clock->now + $ttl, $lastSeq, $sub, $store, $io,
        $readGen ?? fn () => ['gen' => (int) $sub->gen, 'lostAt' => null], fn () => $clock->now,
        function (float $sec) use ($clock): void {
            $clock->now += max($sec, 0.001);
        });

    return [$stream, $sub, $store, $io, $clock];
}

it('connect: unread first; a live row → notification (id = seq) then unread; no id → unread; other users ignored', function () {
    [$s, $sub, $store, $io, $clock] = sseStream(ttl: 30);
    $sub->onIdle = function (FakeSub $sub) use ($store) {
        static $step = 0;
        $step++;
        if ($step === 1) {
            $r = $store->add(SSE_USER);
            $sub->notify(SSE_USER, $r['id']);
            $sub->notify('22222222-2222-4222-8222-222222222222', $store->add('22222222-2222-4222-8222-222222222222')['id']);
            $sub->notify(SSE_USER);
        }
    };
    $s->run();
    expect($io->events())->toBe(['unread:0', 'n:101', 'unread:1', 'unread:1', 'ping', 'reauth']);
    expect($s->endReason)->toBe('reauth');
    expect($io->frames[1])->toStartWith("id: 101\nevent: notification\ndata: {\"id\":\"00000000-0000-4000-8000-000000000101\",\"seq\":101,");
});

it('replay for L: seq > L; unread rows below L created ≤ 60 s before row L; only seq > L without row L', function () {
    $store = new FakeStore;
    $old = $store->add(SSE_USER, createdAgoSec: 200);          // 101: outside the window of n2
    $n1 = $store->add(SSE_USER, createdAgoSec: 30);            // 102
    $read = $store->add(SSE_USER, createdAgoSec: 20, read: true); // 103: read
    $n2 = $store->add(SSE_USER, createdAgoSec: 10);            // 104
    [$a, , , $ioA] = sseStream((string) $n1['seq'], $store, ttl: 1);
    $a->run();
    expect($ioA->events())->toBe(['n:103', 'n:104', 'unread:3', 'reauth']);
    [$b, , , $ioB] = sseStream((string) $n2['seq'], $store, ttl: 1);
    $b->run();
    expect($ioB->events())->toBe(['n:102', 'unread:3', 'reauth']);
    [$c, , , $ioC] = sseStream('99', $store, ttl: 1);
    $c->run();
    expect($ioC->events())->toBe(['n:101', 'n:102', 'n:103', 'n:104', 'unread:3', 'reauth']);
    expect($old['seq'])->toBe(101);
    expect($read['isRead'])->toBeTrue();
});

it('flushes the buffer sorted by seq and never sends a notification twice (replay ∩ live)', function () {
    $store = new FakeStore;
    $n1 = $store->add(SSE_USER);
    [$s, $sub, , $io] = sseStream('100', $store, ttl: 1);
    // Live events that arrived during the replay: n3 before n2, n1 (also replayed) again.
    $n2 = $store->add(SSE_USER);
    $n3 = $store->add(SSE_USER);
    $sub->notify(SSE_USER, $n3['id']);
    $sub->notify(SSE_USER, $n2['id']);
    $sub->notify(SSE_USER, $n1['id']);
    $sub->notify(SSE_USER);
    $s->run();
    expect($io->events())->toBe(['n:101', 'n:102', 'n:103', 'unread:3', 'reauth']);
    expect($s->watermark())->toBe(103);
});

it('N1: a generation that moved during the connect catches up with seq > W', function () {
    $store = new FakeStore;
    $store->add(SSE_USER, read: true);
    $missed = null;
    $readGen = function () use ($store, &$missed) {
        // A LISTEN loss and its resync happened between the GET and the SUBSCRIBE: no message in the buffer.
        $missed = $store->add(SSE_USER);

        return ['gen' => 8, 'lostAt' => gmdate('Y-m-d\TH:i:s.000\Z', 1_800_000_000)];
    };
    [$s, $sub, , $io] = sseStream(null, $store, ttl: 1, readGen: $readGen);
    $sub->gen = '7';
    $s->run();
    expect($io->events())->toBe(['n:102', 'unread:1', 'reauth']);
    expect($missed['seq'])->toBe(102);
});

it('resync: only rows above W and the unread late commits of 60 s before the loss — never the history', function () {
    $clock = new StreamClock;
    $store = new FakeStore;
    $store->add(SSE_USER, createdAgoSec: 3600, clock: $clock);  // 101 unread history
    $store->add(SSE_USER, createdAgoSec: 30, clock: $clock);    // 102 unread, inside the window
    $store->add(SSE_USER, createdAgoSec: 5, read: true, clock: $clock); // 103 = W at connect
    [$s, $sub, , $io] = sseStream(null, $store, ttl: 5, clock: $clock);
    $sub->onIdle = function (FakeSub $sub) use ($store, $clock) {
        static $done = false;
        if (! $done) {
            $done = true;
            $store->add(SSE_USER, clock: $clock); // 104: its NOTIFY was lost
            $lost = gmdate('Y-m-d\TH:i:s.000\Z', (int) $clock->now);
            $sub->queue[] = [Stream::CONTROL_CHANNEL, json_encode(['type' => 'resync', 'gen' => 1, 'lostAt' => $lost])];
            $sub->queue[] = [Stream::CONTROL_CHANNEL, json_encode(['type' => 'resync', 'gen' => 1, 'lostAt' => $lost])]; // old news
        }
    };
    $s->run();
    expect($io->events())->toBe(['unread:2', 'n:102', 'n:104', 'unread:3', 'reauth']);
});

it('a lost subscription is re-subscribed with back-off and caught up from the moment this stream lost it', function () {
    $clock = new StreamClock;
    $store = new FakeStore;
    [$s, $sub, , $io] = sseStream(null, $store, ttl: 20, clock: $clock);
    $sub->onIdle = function (FakeSub $sub) use ($store, $clock) {
        static $step = 0;
        $step++;
        if ($step === 1) {
            $sub->queue[] = new RespError('connection closed');
            $sub->failSubscribe = new RespError('redis down'); // the first retry fails too
            $store->add(SSE_USER, clock: $clock);
        }
    };
    $s->run();
    expect($sub->subscribes)->toBe(3);
    expect($io->events())->toBe(['unread:0', 'n:101', 'unread:1', 'reauth']);
});

it('ping every 25 s, reauth at exp — the last event — and the slot given back after every step', function () {
    $store = new FakeStore;
    [$s, $sub, , $io] = sseStream(null, $store, ttl: 60);
    $sub->onIdle = function (FakeSub $sub) use ($store) {
        static $sent = false;
        if (! $sent) {
            $sent = true;
            $sub->notify(SSE_USER, $store->add(SSE_USER)['id']);
        }
    };
    $s->run();
    expect($io->events())->toBe(['unread:0', 'n:101', 'unread:1', 'ping', 'ping', 'reauth']);
    expect(end($io->frames))->toBe("event: reauth\ndata: {\"reason\":\"TOKEN_EXPIRED\"}\n\n");
    expect($store->releases)->toBe(2); // after the connect, after the live event
});

it('ends when the client is gone: a failed write, or its socket closed between events', function () {
    [$s, $sub, , $io] = sseStream(ttl: 600);
    $sub->onIdle = function () use ($io) {
        static $n = 0;
        if (++$n === 3) {
            $io->gone = true;
        }
    };
    $s->run();
    expect($s->endReason)->toBe('client gone');
    expect($io->events())->toBe(['unread:0']);
});

it('a replay over 1 MiB reaches a reading client whole; a client that does not read is cut after 1 MiB, its frames kept', function () {
    $store = new FakeStore;
    for ($i = 0; $i < 3000; $i++) {
        $r = $store->add(SSE_USER);
        $store->rows[$r['id']]['payload'] = (object) ['productName' => str_repeat('x', 400)];
    }
    [$reading, , , $ioR] = sseStream('100', $store, ttl: 1);
    $reading->run();
    expect(count(array_filter($ioR->events(), fn ($e) => str_starts_with($e, 'n:'))))->toBe(3000);
    expect($ioR->written)->toBeGreaterThan(1_500_000);
    expect($reading->endReason)->toBe('reauth');

    [$stuck, , , $ioS] = sseStream('100', $store, ttl: 600);
    $ioS->taken = 2000; // took the first frames, then stopped reading
    $stuck->run();
    expect($stuck->endReason)->toBe('backlog over 1 MiB');
    expect($ioS->written)->toBeGreaterThan(Stream::MAX_BACKLOG_BYTES)
        ->toBeLessThan(Stream::MAX_BACKLOG_BYTES + Stream::BACKLOG_CHECK_EVERY_BYTES + 4096);
    // Contiguous: the frames before the cut are all there, in order, and L moves on for the reconnect.
    $seqs = array_map(fn ($e) => (int) substr($e, 2), array_filter($ioS->events(), fn ($e) => str_starts_with($e, 'n:')));
    expect(array_values($seqs))->toBe(range(101, 100 + count($seqs)));
    expect(end($ioS->frames))->toStartWith('id: ');
});
