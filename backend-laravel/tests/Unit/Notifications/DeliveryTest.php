<?php

/*
 * The delivery half (P45, P49, N5; Notifications\Delivery) on agrotrace_test_laravel:
 * - the claim's stamp is `claimed_at::text` as PostgreSQL printed it, microseconds kept, and every write is guarded by
 *   it: a stamp cut to milliseconds matches nothing;
 * - a claim lost before attempt 2 → one send, nothing written after the loss;
 * - a hung SMTP server (silent, or trickling bytes) → each attempt ends at its deadline, FAILED after 3 attempts;
 * - the sweeper continues the stored budget of an abandoned row and leaves live claims and fresh rows alone;
 * - NOT_CONFIGURED without an attempt, an unlinked TELEGRAM row FAILED with 0;
 * - inside the scheduler's Tick::locked the sends keep the locked session (no LockLost); a sender that gave its
 *   connection back there would lose the lock — the reason the scheduler's Delivery keeps it (T10 review M2).
 */

use App\Infrastructure\Mail\Mailer;
use App\Notifications\Delivery;
use App\Scheduler\LockLost;
use App\Scheduler\Tick;
use Illuminate\Support\Facades\DB;
use Tests\Support\EngFixture;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

beforeEach(function () {
    $this->requireDatabase();
    $this->fx = new EngFixture;
    $this->user = $this->fx->user($this->fx->org('FARM'), 'FARMER');
    $this->sends = [];
});

afterEach(function () {
    $this->fx->cleanup();
});

/** A notification row as the owner writes it (created/claimed `… ago` as SQL intervals). */
function deliveryRow(string $user, string $channel = 'EMAIL', int $attempts = 0, string $createdAgo = '0 seconds', ?string $claimedAgo = null): string
{
    $st = EngFixture::owner()->prepare("INSERT INTO notifications (user_id, type, payload, channel, delivery_status, attempts, created_at, claimed_at)
        VALUES (?, 'COMPLAINT', ?::jsonb, ?, 'PENDING', ?, now() - ?::interval, ".($claimedAgo === null ? 'NULL' : 'now() - ?::interval').') RETURNING id');
    $args = [$user, json_encode(['complaintId' => 'c', 'batchId' => 'b', 'publicCode' => 'AT-2026-000777', 'productName' => 'Молоко']),
        $channel, $attempts, $createdAgo];
    if ($claimedAgo !== null) {
        $args[] = $claimedAgo;
    }
    $st->execute($args);

    return (string) $st->fetchColumn();
}

/** @return object{delivery_status: string, attempts: int, stamp: ?string} */
function deliveryState(string $id): object
{
    return DB::selectOne('SELECT delivery_status, attempts, claimed_at::text AS stamp FROM notifications WHERE id = ?', [$id]);
}

/** A Delivery whose sends are recorded in $test->sends; $email: what one email attempt does. */
function testDelivery(object $test, ?Closure $email = null, bool $release = false, ?Closure $sleep = null, bool $configured = true): Delivery
{
    return new Delivery($release,
        sendEmail: function (array $letter, float $timeout) use ($test, $email): void {
            $test->sends[] = $letter;
            if ($email !== null) {
                $email($letter, $timeout);
            }
        },
        sendTelegram: function (string $chat, string $text) use ($test): void {
            $test->sends[] = ['chat' => $chat, 'text' => $text];
        },
        emailConfigured: fn () => $configured,
        telegramConfigured: fn () => $configured,
        delaysMs: [10, 20],
        sleepMs: $sleep ?? fn (int $ms): bool => (usleep($ms * 1000) === null),
    );
}

it('stamps the claim with claimed_at::text, microseconds kept; every guard compares it exactly', function () {
    $id = deliveryRow($this->user, createdAgo: '10 minutes', claimedAgo: '6 minutes');
    $d = testDelivery($this);
    [$row, $stamp] = $d->claim($id, 'stale');
    expect($row->id)->toBe($id);
    expect($stamp)->toMatch('/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/');
    expect($stamp)->toBe(deliveryState($id)->stamp);
    expect(DB::selectOne('SELECT count(*) AS n FROM notifications WHERE id = ? AND claimed_at = ?::timestamptz', [$id, $stamp])->n)->toBe(1);
    // Microseconds matter: the same instant cut to milliseconds (a PHP date, a model cast) is another stamp.
    DB::update("UPDATE notifications SET claimed_at = date_trunc('milliseconds', claimed_at) + interval '123 microseconds' WHERE id = ?", [$id]);
    $exact = deliveryState($id)->stamp;
    $cut = preg_replace('/(\.\d{3})\d+/', '$1', (string) $exact);
    expect($cut)->not->toBe($exact);
    expect(DB::selectOne('SELECT count(*) AS n FROM notifications WHERE id = ? AND claimed_at = ?::timestamptz', [$id, $cut])->n)->toBe(0);
    // A claimed row is not claimed again within 5 minutes, fresh or stale.
    expect($d->claim($id, 'fresh'))->toBeNull();
    expect($d->claim($id, 'stale'))->toBeNull();
});

it('a claim lost before attempt 2: one send, and nothing is written after the loss', function () {
    $id = deliveryRow($this->user);
    $takenOver = null;
    $d = testDelivery($this, email: fn () => throw new RuntimeException('smtp down'),
        sleep: function (int $ms) use ($id, &$takenOver): bool {
            // Another sender takes the row over during the pause after attempt 1.
            DB::update("UPDATE notifications SET claimed_at = now() + interval '1 second' WHERE id = ?", [$id]);
            $takenOver = deliveryState($id)->stamp;

            return true;
        });
    $d->sendOwn([$id]);
    expect($this->sends)->toHaveCount(1);
    $s = deliveryState($id);
    expect($s->delivery_status)->toBe('PENDING');
    expect($s->attempts)->toBe(1); // stored after attempt 1, while the claim was still ours
    expect($s->stamp)->toBe($takenOver);
});

it('3 attempts with waits 1 s and 2 s by default; success on attempt 2 is DELIVERED attempts 2', function () {
    expect(Delivery::DELAYS_MS)->toBe([1000, 2000]);
    expect(Delivery::ATTEMPTS)->toBe(3);
    expect(Delivery::ATTEMPT_TIMEOUT_SEC)->toBe(30.0);
    $id = deliveryRow($this->user);
    $waits = [];
    $n = 0;
    $d = testDelivery($this, email: function () use (&$n) {
        if (++$n === 1) {
            throw new RuntimeException('once');
        }
    }, sleep: function (int $ms) use (&$waits): bool {
        $waits[] = $ms;

        return true;
    });
    $d->sendOwn([$id]);
    expect($waits)->toBe([10]);
    expect(deliveryState($id))->toMatchArray(['delivery_status' => 'DELIVERED', 'attempts' => 2]);
});

/**
 * An SMTP server in a child process that accepts $connections connections and then never completes a line: silent,
 * or one byte every 0.1 s (each read gets data well within 10 s, so only the attempt's deadline can end it).
 *
 * @return array{0: int, 1: int} [port, pid]
 */
function hungSmtp(bool $trickle, int $connections = 3): array
{
    $srv = stream_socket_server('tcp://127.0.0.1:0');
    $name = (string) stream_socket_get_name($srv, false);
    $port = (int) substr($name, strrpos($name, ':') + 1);
    $pid = pcntl_fork();
    if ($pid === 0) {
        $open = [];
        $deadline = microtime(true) + 20;
        while (microtime(true) < $deadline) {
            $r = [$srv];
            $w = $e = null;
            if (count($open) < $connections && @stream_select($r, $w, $e, 0, 100_000) > 0) {
                $open[] = stream_socket_accept($srv);
            } else {
                usleep(100_000);
            }
            if ($trickle) {
                foreach ($open as $c) {
                    @fwrite($c, '2');
                }
            }
        }
        posix_kill(posix_getpid(), SIGKILL);
    }
    fclose($srv);

    return [$port, $pid];
}

it('a hung SMTP server — silent or trickling — ends every attempt at its deadline: FAILED after 3 attempts', function (bool $trickle) {
    [$port, $pid] = hungSmtp($trickle);
    config(['agrotrace.smtp.host' => '127.0.0.1', 'agrotrace.smtp.port' => $port]);
    try {
        $id = deliveryRow($this->user);
        $d = new Delivery(false, emailConfigured: fn () => true, delaysMs: [10, 10], attemptTimeoutSec: 0.6);
        $t = microtime(true);
        $d->sendOwn([$id]);
        $elapsed = microtime(true) - $t;
        expect(deliveryState($id))->toMatchArray(['delivery_status' => 'FAILED', 'attempts' => 3]);
        expect($elapsed)->toBeGreaterThan(1.7)->toBeLessThan(4.0);
    } finally {
        posix_kill($pid, SIGKILL);
        pcntl_waitpid($pid, $status);
    }
})->with(['silent' => false, 'trickling' => true]);

it('the sweeper continues the stored budget and leaves live claims and fresh rows to their senders', function () {
    $abandoned = deliveryRow($this->user, attempts: 1, createdAgo: '10 minutes', claimedAgo: '6 minutes');
    $last = deliveryRow($this->user, attempts: 2, createdAgo: '10 minutes', claimedAgo: '6 minutes');
    $spent = deliveryRow($this->user, attempts: 3, createdAgo: '10 minutes');
    $busy = deliveryRow($this->user, createdAgo: '10 minutes', claimedAgo: '1 second');
    $fresh = deliveryRow($this->user);
    $failing = false;
    $d = testDelivery($this, email: function () use (&$failing) {
        if ($failing) {
            throw new RuntimeException('no');
        }
    });
    $mine = fn () => count(array_filter($this->sends, fn (array $l) => $l['to'] === "eng-{$this->user}@test.local"));
    $d->deliverOne($abandoned, 'stale');
    expect(deliveryState($abandoned))->toMatchArray(['delivery_status' => 'DELIVERED', 'attempts' => 2]);
    $failing = true; // the one attempt left fails
    $d->deliverOne($last, 'stale');
    expect(deliveryState($last))->toMatchArray(['delivery_status' => 'FAILED', 'attempts' => 3]);
    $failing = false;
    expect($mine())->toBe(2);
    expect($d->sweep())->toBeGreaterThanOrEqual(1);
    expect(deliveryState($spent))->toMatchArray(['delivery_status' => 'FAILED', 'attempts' => 3]);
    expect($mine())->toBe(2); // a spent budget sends nothing
    expect(deliveryState($busy))->toMatchArray(['delivery_status' => 'PENDING', 'attempts' => 0]);
    expect(deliveryState($fresh))->toMatchArray(['delivery_status' => 'PENDING', 'attempts' => 0, 'stamp' => null]);
    // The consumer's own (fresh) claim takes the fresh row, never the live claim.
    $d->sendOwn([$busy, $fresh]);
    expect(deliveryState($busy)->delivery_status)->toBe('PENDING');
    expect(deliveryState($fresh)->delivery_status)->toBe('DELIVERED');
});

it('the sweep stops claiming new rows once its time budget is spent', function () {
    $ids = [];
    for ($i = 0; $i < 4; $i++) {
        $ids[] = deliveryRow($this->user, createdAgo: (10 + $i).' minutes');
    }
    $d = testDelivery($this, email: fn () => usleep(150_000));
    $taken = $d->sweep(0.2);
    expect($taken)->toBeLessThan(4);
    expect($taken)->toBeGreaterThanOrEqual(1);
});

it('NOT_CONFIGURED without an attempt; an unlinked TELEGRAM row FAILED with 0; a linked one sent to its chat', function () {
    $email = deliveryRow($this->user);
    $tg = deliveryRow($this->user, 'TELEGRAM');
    testDelivery($this, configured: false)->sendOwn([$email, $tg]);
    expect(deliveryState($email))->toMatchArray(['delivery_status' => 'NOT_CONFIGURED', 'attempts' => 0]);
    expect(deliveryState($tg))->toMatchArray(['delivery_status' => 'NOT_CONFIGURED', 'attempts' => 0]);
    $unlinked = deliveryRow($this->user, 'TELEGRAM');
    testDelivery($this)->sendOwn([$unlinked]);
    expect(deliveryState($unlinked))->toMatchArray(['delivery_status' => 'FAILED', 'attempts' => 0]);
    EngFixture::exec('UPDATE users SET telegram_chat_id = 4242 WHERE id = ?', [$this->user]);
    $linked = deliveryRow($this->user, 'TELEGRAM');
    testDelivery($this)->sendOwn([$linked]);
    expect(deliveryState($linked))->toMatchArray(['delivery_status' => 'DELIVERED', 'attempts' => 1]);
    expect($this->sends)->toBe([['chat' => '4242', 'text' => 'Жалоба на партию AT-2026-000777 (Молоко)']]);
});

it('the letter is the i18n text of the row, to the user\'s address', function () {
    $id = deliveryRow($this->user);
    testDelivery($this)->sendOwn([$id]);
    expect($this->sends)->toHaveCount(1);
    expect($this->sends[0]['to'])->toBe("eng-{$this->user}@test.local");
    expect($this->sends[0]['subject'])->toBe('AgroTrace: жалоба на партию AT-2026-000777');
    expect($this->sends[0]['kind'])->toBe('notification.COMPLAINT');
    expect(Mailer::SOCKET_TIMEOUT_SEC)->toBe(10.0);
});

it('in a scheduler tick the sends keep the locked session; giving the connection back there would lose the lock', function () {
    $lock = 'agrotrace.scheduler.delivery-test-'.bin2hex(random_bytes(3));
    $id = deliveryRow($this->user, createdAgo: '10 minutes');
    $slow = fn () => usleep(300_000);
    expect(Tick::locked($lock, fn () => testDelivery($this, email: $slow)->sweep()))->toBeTrue();
    expect(deliveryState($id)->delivery_status)->toBe('DELIVERED');

    $id2 = deliveryRow($this->user, createdAgo: '10 minutes');
    expect(fn () => Tick::locked($lock, fn () => testDelivery($this, email: $slow, release: true)->sweep()))->toThrow(LockLost::class);
    DB::disconnect();
    expect(DB::selectOne('SELECT pg_try_advisory_lock(hashtext(?)) AS ok', [$lock])->ok)->toBeTrue();
    DB::select('SELECT pg_advisory_unlock(hashtext(?))', [$lock]);
    expect(deliveryState($id2)->delivery_status)->toBe('PENDING'); // its write was refused with the lost session
});
