<?php

namespace App\Sse;

use App\Support\Json;
use Closure;
use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Support\Facades\Log;
use stdClass;
use Throwable;

/**
 * One SSE stream (contracts/openapi/paths/events.yaml, spec 8.4, R33; Express sse/hub.ts `open` and Stream), run by
 * the request's own PHP thread (api-laravel: FrankenPHP's classic threads, docker/Caddyfile). The single LISTEN
 * session is the hub's (`agrotrace:sse-hub`, SseHub): it forwards every NOTIFY payload of user U to the Redis channel
 * `agrotrace:laravel:sse:user:{U}` and announces a lost-and-restored session on `agrotrace:laravel:sse:control`
 * (`{type: "resync", gen, lostAt}`; the generation in `agrotrace:laravel:sse:gen`, the loss in `…:lostAt`).
 *
 * Connect (after 401 and the `user` limit, StreamController):
 *   1. subscribe to the user's channel and the control channel (RespSubscriber; live events wait in the socket — the
 *      buffer), the generation and its loss read in the same write just before the subscription;
 *   2. replay for L (`Last-Event-ID` / `lastEventId`): seq > L plus unread rows with seq < L created ≤ 60 s before
 *      row L (only seq > L without row L), uncapped (P53), in pages of 500 by seq;
 *   3. W = max(L, the user's highest seq at that moment), raised by every notification sent;
 *   4. the buffered live events, sorted by seq and deduplicated by id (a stream never sends one notification twice);
 *   5. a generation that moved during the connect (or a resync message) → catch-up with the same query (N1);
 *   6. `unread`; the DB slot is given back (between events the stream holds none, P61).
 * Then: a NOTIFY with `id` → `notification` (`id:` = seq) then `unread`; without `id` → `unread` only; `ping` every
 * 25 s; at the token's `exp` → `reauth` and the end; a resync message → rows with seq > W plus unread rows with seq < W
 * created ≤ 60 s before `lostAt`, then `unread` — never the history; a lost subscription → re-subscribed with back-off
 * (0.5 s doubling to 10 s) and the same catch-up from the moment this stream lost it.
 *
 * Ends: the client is gone (a failed write, or its connection closed — StreamIo::gone between events, ≤ 1 s), reauth,
 * or more than 1 MiB written and not taken by the client (StreamIo::backlog, checked every 64 KiB): then nothing more
 * is written and the response ends normally, so the bytes already handed on still reach a client that reads (Express
 * `res.end()`), and the PHP thread never blocks on a client that does not.
 */
final class Stream
{
    public const PING_SEC = 25.0;

    public const MAX_BACKLOG_BYTES = 1024 * 1024;

    public const BACKLOG_CHECK_EVERY_BYTES = 64 * 1024;

    public const SENT_CAP = 10_000;

    public const PAGE = 500;

    public const USER_CHANNEL = 'agrotrace:laravel:sse:user:';

    public const CONTROL_CHANNEL = 'agrotrace:laravel:sse:control';

    public const GEN_KEY = 'agrotrace:laravel:sse:gen';

    public const LOST_AT_KEY = 'agrotrace:laravel:sse:lostAt';

    /** Seconds between two liveness checks of the client while idle. */
    public const LIVENESS_SEC = 1.0;

    private int $watermark = 0;

    /** @var array<string, true> */
    private array $sent = [];

    private bool $closed = false;

    private int $sinceCheck = 0;

    /** The generation this stream has caught up to (a resync message at or below it is old news). */
    private int $gen = 0;

    private bool $subscribed = false;

    private ?string $lostSince = null;

    private float $nextResubscribe = 0.0;

    private int $resubscribeAttempt = 0;

    /** Why the stream ended (tests, the log). */
    public string $endReason = '';

    /** @var Closure(): float */
    private readonly Closure $clock;

    /** @var Closure(float): void */
    private readonly Closure $sleep;

    /**
     * @param  Closure(): array{gen: int, lostAt: ?string}  $readGen  the generation now (phpredis; the stream's own
     *                                                                connection is subscribed)
     * @param  null|Closure(): float  $clock
     * @param  null|Closure(float): void  $sleep  seconds
     */
    public function __construct(
        private readonly string $userId,
        private readonly int $exp,
        private readonly ?string $lastSeq,
        private readonly Subscription $sub,
        private readonly StreamStore $store,
        private readonly StreamIo $io,
        private readonly Closure $readGen,
        ?Closure $clock = null,
        ?Closure $sleep = null,
        private readonly float $pingSec = self::PING_SEC,
        private readonly float $livenessSec = self::LIVENESS_SEC,
    ) {
        $this->clock = $clock ?? fn (): float => microtime(true);
        $this->sleep = $sleep ?? function (float $sec): void {
            usleep((int) ($sec * 1_000_000));
        };
    }

    public function run(): void
    {
        $t0 = ($this->clock)();
        try {
            $this->connect();
        } catch (Throwable $e) {
            // The stream has started: no problem document can follow — log and end it (the client reconnects).
            Log::error('sse stream setup failed', ['err' => $e->getMessage()]);
            $this->store->release();

            return;
        }
        $this->store->release();
        $nextPing = $t0 + $this->pingSec;
        $nextLiveness = ($this->clock)() + $this->livenessSec;
        while (! $this->closed) {
            $now = ($this->clock)();
            if ($now >= $this->exp) {
                $this->write(SseFrame::reauth());
                $this->end('reauth');
                break;
            }
            if ($now >= $nextPing) {
                $this->write(SseFrame::ping($this->instant($now)));
                $nextPing += $this->pingSec;

                continue;
            }
            if ($now >= $nextLiveness) {
                $nextLiveness = $now + $this->livenessSec;
                if ($this->io->gone()) {
                    $this->end('client gone');
                    break;
                }
            }
            if (! $this->subscribed && $now >= $this->nextResubscribe) {
                $this->resubscribe();

                continue;
            }
            $until = min((float) $this->exp, $nextPing, $nextLiveness, $this->subscribed ? INF : $this->nextResubscribe);
            $wait = max(0.0, $until - $now);
            if (! $this->subscribed) {
                ($this->sleep)($wait);

                continue;
            }
            try {
                $msg = $this->sub->next($wait);
            } catch (RespError $e) {
                $this->lose($e);

                continue;
            }
            if ($msg !== null) {
                $this->live($msg[0], $msg[1]);
            }
        }
        $this->sub->close();
    }

    private function connect(): void
    {
        try {
            $v = $this->sub->subscribe([self::USER_CHANNEL.$this->userId, self::CONTROL_CHANNEL], [self::GEN_KEY]);
            $this->gen = (int) ($v[self::GEN_KEY] ?? 0);
            $this->subscribed = true;
        } catch (RespError $e) {
            // No Redis now: the connect sequence still runs; the subscription is retried and caught up like a loss.
            $this->lose($e);
        }
        $top = $this->store->maxSeq($this->userId);
        $given = $this->lastSeq !== null ? (int) $this->lastSeq : 0;
        if ($this->lastSeq !== null) {
            $after = -1;
            do {
                $rows = $this->store->replay($this->userId, $given, $after, self::PAGE);
                foreach ($rows as $n) {
                    $this->send($n);
                    $after = $n['seq'];
                }
            } while (count($rows) === self::PAGE && ! $this->closed);
        }
        $this->watermark = max($this->watermark, $given, $top);
        // The buffer: live events that arrived during the replay, sorted and deduplicated.
        $buffered = [];
        $resync = null;
        while ($this->subscribed && ! $this->closed) {
            try {
                $msg = $this->sub->next(0.0);
            } catch (RespError $e) {
                $this->lose($e);
                break;
            }
            if ($msg === null) {
                break;
            }
            [$channel, $payload] = $msg;
            if ($channel === self::CONTROL_CHANNEL) {
                $c = self::decode($payload);
                if (($c->type ?? null) === 'resync' && is_numeric($c->gen ?? null) && (int) $c->gen > $this->gen) {
                    $resync = $c;
                }

                continue;
            }
            $id = self::decode($payload)->id ?? null;
            if (is_string($id) && ! isset($buffered[$id])) {
                $n = $this->store->row($this->userId, $id);
                if ($n !== null) {
                    $buffered[$id] = $n;
                }
            }
        }
        usort($buffered, fn (array $a, array $b) => $a['seq'] <=> $b['seq']);
        foreach ($buffered as $n) {
            $this->send($n);
        }
        // N1: the generation moved during the connect (a resync published between the GET and the SUBSCRIBE is in no
        // buffer; one published later is) → the same catch-up, from the latest loss.
        if (! $this->closed && $this->subscribed) {
            try {
                $now = ($this->readGen)();
            } catch (Throwable) {
                $now = ['gen' => $this->gen + 1, 'lostAt' => null]; // unknown: catch up to be safe
            }
            if ($resync !== null && (int) $resync->gen >= $now['gen']) {
                $now = ['gen' => (int) $resync->gen, 'lostAt' => is_string($resync->lostAt ?? null) ? $resync->lostAt : null];
            }
            if ($now['gen'] > $this->gen) {
                $this->catchUp($now['lostAt'] ?? $this->isoNow());
                $this->gen = $now['gen'];
            }
        }
        if (! $this->closed) {
            $this->write(SseFrame::unread($this->store->unread($this->userId)));
        }
    }

    /** One message of the subscription. */
    private function live(string $channel, string $payload): void
    {
        try {
            if ($channel === self::CONTROL_CHANNEL) {
                $c = self::decode($payload);
                if (($c->type ?? null) === 'resync' && is_numeric($c->gen ?? null) && (int) $c->gen > $this->gen) {
                    $this->gen = (int) $c->gen;
                    $this->catchUp(is_string($c->lostAt ?? null) ? $c->lostAt : $this->isoNow());
                    if (! $this->closed) {
                        $this->write(SseFrame::unread($this->store->unread($this->userId)));
                    }
                }

                return;
            }
            $m = self::decode($payload);
            if (($m->user_id ?? null) !== $this->userId) {
                return;
            }
            if (is_string($m->id ?? null)) {
                $n = $this->store->row($this->userId, $m->id);
                if ($n !== null) {
                    $this->send($n);
                }
            }
            if (! $this->closed) {
                $this->write(SseFrame::unread($this->store->unread($this->userId)));
            }
        } catch (Throwable $e) {
            Log::warning('sse event failed', ['err' => $e->getMessage()]);
        } finally {
            $this->store->release();
        }
    }

    /** Rows this stream may have missed (seq > W, plus the late commits of 60 s before $sinceIso). */
    private function catchUp(string $sinceIso): void
    {
        $after = -1;
        do {
            $rows = $this->store->catchUp($this->userId, $this->watermark, $sinceIso, $after, self::PAGE);
            foreach ($rows as $n) {
                $this->send($n);
                $after = $n['seq'];
            }
        } while (count($rows) === self::PAGE && ! $this->closed);
    }

    private function lose(Throwable $e): void
    {
        $this->sub->close();
        if ($this->subscribed || $this->lostSince === null) {
            $this->lostSince = $this->isoNow();
            Log::warning('sse subscription lost; re-subscribing', ['err' => $e->getMessage()]);
        }
        $this->subscribed = false;
        $this->nextResubscribe = ($this->clock)() + min(0.5 * 2 ** $this->resubscribeAttempt, 10.0);
        $this->resubscribeAttempt++;
    }

    private function resubscribe(): void
    {
        try {
            $v = $this->sub->subscribe([self::USER_CHANNEL.$this->userId, self::CONTROL_CHANNEL], [self::GEN_KEY]);
        } catch (RespError $e) {
            $this->lose($e);

            return;
        }
        $this->subscribed = true;
        $this->resubscribeAttempt = 0;
        $this->gen = max($this->gen, (int) ($v[self::GEN_KEY] ?? 0));
        try {
            $this->catchUp($this->lostSince ?? $this->isoNow());
            if (! $this->closed) {
                $this->write(SseFrame::unread($this->store->unread($this->userId)));
            }
        } catch (Throwable $e) {
            Log::warning('sse catch-up failed', ['err' => $e->getMessage()]);
        } finally {
            $this->lostSince = null;
            $this->store->release();
        }
    }

    /** @param  array{id: string, seq: int, type: string, payload: mixed, isRead: bool, createdAt: string}  $n */
    private function send(array $n): void
    {
        if ($this->closed || isset($this->sent[$n['id']])) {
            return;
        }
        if (count($this->sent) >= self::SENT_CAP) {
            $this->sent = [];
        }
        $this->sent[$n['id']] = true;
        if ($n['seq'] > $this->watermark) {
            $this->watermark = $n['seq'];
        }
        $this->write(SseFrame::notification($n));
    }

    private function write(string $frame): void
    {
        if ($this->closed) {
            return;
        }
        if (! $this->io->write($frame)) {
            $this->end('client gone');

            return;
        }
        $this->sinceCheck += strlen($frame);
        if ($this->sinceCheck >= self::BACKLOG_CHECK_EVERY_BYTES) {
            $this->sinceCheck = 0;
            $backlog = $this->io->backlog();
            if ($backlog !== null && $backlog > self::MAX_BACKLOG_BYTES) {
                $this->end('backlog over 1 MiB');
            }
        }
    }

    private function end(string $reason): void
    {
        if (! $this->closed) {
            $this->closed = true;
            $this->endReason = $reason;
        }
    }

    public function closed(): bool
    {
        return $this->closed;
    }

    public function watermark(): int
    {
        return $this->watermark;
    }

    private function isoNow(): string
    {
        return $this->instant(($this->clock)())->format('Y-m-d\TH:i:s.v\Z');
    }

    private function instant(float $t): DateTimeImmutable
    {
        return (new DateTimeImmutable('@'.sprintf('%.6F', $t)))->setTimezone(new DateTimeZone('UTC'));
    }

    private static function decode(string $payload): stdClass
    {
        try {
            $v = Json::decode($payload);
        } catch (Throwable) {
            return new stdClass;
        }

        return $v instanceof stdClass ? $v : new stdClass;
    }
}
