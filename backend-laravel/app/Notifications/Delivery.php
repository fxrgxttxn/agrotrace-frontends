<?php

namespace App\Notifications;

use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Mail\Mailer;
use App\Infrastructure\Telegram\Telegram;
use App\Scheduler\LockLost;
use App\Support\Json;
use App\Support\StopSignal;
use Closure;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use stdClass;
use Throwable;

/**
 * The delivery half of `notification.dispatch` (contracts/events/notification.dispatch.schema.json, P45, P49, N5;
 * Express modules/notifications/delivery.ts): every PENDING EMAIL/TELEGRAM row is sent with up to 3 attempts —
 * success → DELIVERED, every attempt failed → FAILED, the channel not configured on this server (no SMTP_HOST, no bot
 * token) → NOT_CONFIGURED without an attempt, an unlinked TELEGRAM row → FAILED without an attempt. Waits after a
 * failed attempt: 1 s, then 2 s. Every attempt ends by 30 s (ATTEMPT_TIMEOUT_SEC): SMTP waits ≤ 10 s per read and ends
 * at the deadline (Mailer, DeadlineStream), Telegram's whole request ≤ 10 s (curl's total timeout). A port note: the
 * brief's pcntl_alarm(30) is not used — a signal handler runs only when PHP returns from the blocking C call, so it
 * cannot end a read (measured: a 3 s alarm fired at 13 s); the timeouts above are what bound an attempt.
 *
 * Claims (P49, per send): a row is claimed right before its first attempt with ONE autocommit
 *   UPDATE … SET claimed_at = now() WHERE id = :id AND delivery_status = 'PENDING' AND <mode>
 *   RETURNING claimed_at::text
 * — `fresh` (the consumer's own rows): `claimed_at IS NULL OR claimed_at < now() − 5 min`; `stale` (the sweeper):
 * `coalesce(claimed_at, created_at) < now() − 5 min`. The stamp is that text as PostgreSQL printed it (microseconds
 * kept, never through a PHP date or a model); before every attempt the claim is renewed and every write is guarded by
 * `claimed_at = :stamp::timestamptz AND delivery_status = 'PENDING'`. Zero rows — the row is no longer this sender's:
 * it stops without sending and writes nothing. `attempts` is stored after every failed attempt, so a sender that dies
 * leaves its budget behind and the sweeper continues it. A rare duplicate letter after a crash between a send and its
 * status write is accepted (at-least-once).
 *
 * Senders: the consumer process after its handler committed and the delivery was acknowledged (sendOwn, one row after
 * another; the DB connection is given back during each send — SlotHolder — and taken again for the next statement),
 * and the scheduler job `notification-delivery` (sweep: ≤ 100 rows, oldest first; no new row is claimed once a tick
 * has run 240 s, so the job's advisory key is released and the channels interleave across ticks). The scheduler keeps
 * its one connection through the sends: its session holds the tick's advisory lock (Tick::locked), and the connection
 * is the process's own (L5), so an idle send there costs no other request a slot.
 */
final class Delivery
{
    public const ATTEMPTS = 3;

    /** @var list<int> the waits after attempt 1 and attempt 2 (P45) */
    public const DELAYS_MS = [1000, 2000];

    public const CLAIM_STALE_SEC = 300;

    public const ATTEMPT_TIMEOUT_SEC = 30.0;

    public const SWEEP_BATCH = 100;

    public const SWEEP_BUDGET_SEC = 240.0;

    /** @var Closure(array{to: string, subject: string, text: string, kind: string}, float): void */
    private readonly Closure $sendEmail;

    /** @var Closure(string, string, float): void */
    private readonly Closure $sendTelegram;

    /** @var Closure(): bool */
    private readonly Closure $emailConfigured;

    /** @var Closure(): bool */
    private readonly Closure $telegramConfigured;

    /** @var Closure(int): bool sleeps ms; false when a stop ended it */
    private readonly Closure $sleepMs;

    /**
     * @param  bool  $releaseDuringSend  give the DB connection back around each send (the consumer); false keeps it (the
     *                                   scheduler's session holds the tick's advisory lock)
     * @param  null|Closure(array{to: string, subject: string, text: string, kind: string}, float): void  $sendEmail
     * @param  null|Closure(string, string, float): void  $sendTelegram
     * @param  list<int>  $delaysMs
     */
    public function __construct(
        private readonly bool $releaseDuringSend,
        ?Closure $sendEmail = null,
        ?Telegram $telegram = null,
        ?Closure $sendTelegram = null,
        ?Closure $emailConfigured = null,
        ?Closure $telegramConfigured = null,
        private readonly array $delaysMs = self::DELAYS_MS,
        private readonly float $attemptTimeoutSec = self::ATTEMPT_TIMEOUT_SEC,
        ?Closure $sleepMs = null,
        private readonly ?StopSignal $stop = null,
    ) {
        $telegram ??= Telegram::fromConfig();
        $this->sendEmail = $sendEmail ?? fn (array $letter, float $timeout) => Mailer::sendOnce($letter, $timeout);
        $this->sendTelegram = $sendTelegram ?? fn (string $chatId, string $text, float $timeout) => $telegram->sendMessage($chatId, $text, $timeout);
        $this->emailConfigured = $emailConfigured ?? fn (): bool => Mailer::configured();
        $this->telegramConfigured = $telegramConfigured ?? fn (): bool => $telegram->configured();
        $this->sleepMs = $sleepMs ?? function (int $ms): bool {
            if ($this->stop !== null) {
                return $this->stop->sleep($ms);
            }
            usleep($ms * 1000);

            return true;
        };
    }

    /** The consumer's sender (worker): its own rows, the connection given back during each send. */
    public static function forWorker(): self
    {
        return new self(true, stop: app(StopSignal::class));
    }

    /** The scheduler's sender: the tick's locked session is kept through the sends. */
    public static function forScheduler(): self
    {
        return new self(false, stop: app(StopSignal::class));
    }

    /**
     * Sends the PENDING rows the caller's handler inserted, one after another (after its commit and ack). A stop
     * request (SIGTERM) ends it before the next row: rows not claimed yet are the sweeper's after 5 minutes.
     *
     * @param  list<string>  $pendingIds
     */
    public function sendOwn(array $pendingIds): void
    {
        foreach ($pendingIds as $id) {
            if ($this->stop?->raised()) {
                return;
            }
            try {
                $this->deliverOne($id, 'fresh');
            } catch (Throwable $e) {
                Log::error('notification delivery crashed', ['notificationId' => $id, 'err' => $e->getMessage()]);
            }
        }
        if ($this->releaseDuringSend) {
            SlotHolder::release();
        }
    }

    /**
     * One sweep (scheduler `notification-delivery`): the PENDING rows nobody handled for 5 minutes, oldest first, at
     * most 100, claimed and sent one by one until $budgetSec has passed; returns how many it took.
     */
    public function sweep(float $budgetSec = self::SWEEP_BUDGET_SEC): int
    {
        $started = microtime(true);
        $ids = array_map(fn (stdClass $r) => (string) $r->id, DB::select("SELECT id FROM notifications
             WHERE delivery_status = 'PENDING' AND channel <> 'IN_APP'
               AND coalesce(claimed_at, created_at) < now() - make_interval(secs => ?)
             ORDER BY created_at LIMIT ?", [self::CLAIM_STALE_SEC, self::SWEEP_BATCH]));
        $taken = 0;
        foreach ($ids as $id) {
            if ($this->stop?->raised() || microtime(true) - $started >= $budgetSec) {
                break;
            }
            $taken++;
            try {
                $this->deliverOne($id, 'stale');
            } catch (Throwable $e) {
                // A lost scheduler session (LockLost) ends the tick; any other failure is this row's.
                if ($e instanceof LockLost) {
                    throw $e;
                }
                Log::error('notification delivery crashed', ['notificationId' => $id, 'err' => $e->getMessage()]);
            }
        }

        return $taken;
    }

    /**
     * Claims one row (P49) and sends it within the rest of its budget. `fresh`: unless a live claim is held; `stale`:
     * only when nobody handled it for 5 minutes.
     */
    public function deliverOne(string $id, string $mode): void
    {
        $claimed = $this->claim($id, $mode);
        if ($claimed === null) {
            return;
        }
        [$row, $stamp] = $claimed;
        $mine = function (int $attempts, ?string $status) use ($id, &$stamp): void {
            $sql = 'UPDATE notifications SET attempts = ?'.($status !== null ? ', delivery_status = ?' : '')
                ." WHERE id = ? AND delivery_status = 'PENDING' AND claimed_at = ?::timestamptz";
            DB::update($sql, $status !== null ? [$attempts, $status, $id, $stamp] : [$attempts, $id, $stamp]);
        };
        $out = $this->sendRow($row,
            beforeAttempt: function () use ($id, &$stamp): bool {
                $r = DB::selectOne("UPDATE notifications SET claimed_at = now()
                     WHERE id = ? AND delivery_status = 'PENDING' AND claimed_at = ?::timestamptz
                    RETURNING claimed_at::text AS stamp", [$id, $stamp]);
                if ($r === null) {
                    return false;
                }
                $stamp = (string) $r->stamp;

                return true;
            },
            onFailure: fn (int $attempts) => $mine($attempts, null),
        );
        if ($out !== null) {
            $mine($out['attempts'], $out['status']);
        }
    }

    /**
     * The claim (one autocommit statement): the row and the stamp — `claimed_at::text` exactly as printed — or null
     * when another sender holds it or it is no longer PENDING.
     *
     * @return null|array{0: stdClass, 1: string}
     */
    public function claim(string $id, string $mode): ?array
    {
        $pred = $mode === 'fresh'
            ? '(n.claimed_at IS NULL OR n.claimed_at < now() - make_interval(secs => ?))'
            : 'coalesce(n.claimed_at, n.created_at) < now() - make_interval(secs => ?)';
        $r = DB::selectOne("WITH taken AS (
                UPDATE notifications n SET claimed_at = now()
                 WHERE n.id = ? AND n.delivery_status = 'PENDING' AND n.channel <> 'IN_APP' AND {$pred}
                RETURNING n.id, n.type, n.payload::text AS payload, n.channel, n.attempts, n.user_id,
                          n.claimed_at::text AS stamp)
            SELECT t.id, t.type, t.payload, t.channel, t.attempts, t.stamp, u.email,
                   u.telegram_chat_id::text AS telegram_chat_id
              FROM taken t JOIN users u ON u.id = t.user_id", [$id, self::CLAIM_STALE_SEC]);

        return $r === null ? null : [$r, (string) $r->stamp];
    }

    /**
     * Sends one claimed row (no SQL of its own): the outcome to store, or null when the row stopped being this
     * sender's (`beforeAttempt` false, or a stop request during a pause) — nothing is stored then.
     *
     * @param  Closure(): bool  $beforeAttempt  renews the claim before every attempt
     * @param  Closure(int): void  $onFailure  stores `attempts` after a failed attempt that is not the last
     * @return null|array{status: string, attempts: int}
     */
    public function sendRow(stdClass $row, Closure $beforeAttempt, Closure $onFailure): ?array
    {
        $done = (int) $row->attempts;
        $channel = (string) $row->channel;
        if ($channel === 'TELEGRAM' && ! ($this->telegramConfigured)()) {
            return ['status' => 'NOT_CONFIGURED', 'attempts' => $done];
        }
        if ($channel === 'EMAIL' && ! ($this->emailConfigured)()) {
            return ['status' => 'NOT_CONFIGURED', 'attempts' => $done];
        }
        if ($channel === 'TELEGRAM' && $row->telegram_chat_id === null) {
            return ['status' => 'FAILED', 'attempts' => $done];
        }
        if ($done >= self::ATTEMPTS) {
            return ['status' => 'FAILED', 'attempts' => $done];
        }
        $payload = is_string($row->payload) ? Json::decode($row->payload) : $row->payload;
        $payload = $payload instanceof stdClass ? $payload : new stdClass;
        $type = (string) $row->type;
        $send = $channel === 'EMAIL'
            ? fn () => ($this->sendEmail)([
                'kind' => "notification.{$type}",
                'to' => (string) $row->email,
                'subject' => NotificationText::message($type, $payload, 'email.subject'),
                'text' => NotificationText::message($type, $payload, 'email.body'),
            ], $this->attemptTimeoutSec)
            : fn () => ($this->sendTelegram)((string) $row->telegram_chat_id,
                NotificationText::message($type, $payload, 'telegram'), $this->attemptTimeoutSec);
        for ($attempt = $done + 1; ; $attempt++) {
            if (! $beforeAttempt()) {
                return null;
            }
            try {
                if ($this->releaseDuringSend) {
                    SlotHolder::release(); // no connection is held while SMTP/Telegram answers (P61)
                }
                $send();

                return ['status' => 'DELIVERED', 'attempts' => $attempt];
            } catch (Throwable $e) {
                Log::warning('notification send failed', ['err' => $e->getMessage(), 'notificationId' => $row->id,
                    'channel' => $channel, 'attempt' => $attempt]);
                if ($attempt >= self::ATTEMPTS) {
                    return ['status' => 'FAILED', 'attempts' => $attempt];
                }
                $onFailure($attempt);
                if (! ($this->sleepMs)($this->delaysMs[$attempt - 1] ?? 0)) {
                    return null; // stopping: the claim lapses, the sweeper continues the stored budget
                }
            }
        }
    }
}
