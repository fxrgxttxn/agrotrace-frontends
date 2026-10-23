<?php

namespace App\Infrastructure\Outbox;

use App\Http\Query\QueryReader;
use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Db\BackendUnavailable;
use App\Infrastructure\Db\DbSlots;
use Closure;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Socket;
use Throwable;

/**
 * The loop of the api container's relay process (`agrotrace:relay`, RelayDaemon). It receives the ids of committed
 * outbox events from the Octane workers (RelayNotifier, Unix datagrams) and publishes them through Relay (confirm
 * channel opened first, row locks held across publish + confirm). It never loses an id:
 *
 * - **Hand-off.** The socket is drained before every publish chunk, so it never stays unread for longer than one
 *   chunk's confirm. The api container raises `net.unix.max_dgram_qlen` (docker-compose) so a slow confirm does not
 *   fill it.
 * - **Self-healing.** The loop catches up from the outbox itself: the oldest unpublished rows of handled types
 *   (Relay::publishOldest), at start (ids dropped while no relay was bound), whenever a sender touched the drop
 *   marker (queue full or no relay), when its own pending set overflowed, and every `catchUpEverySec` as a safety
 *   net. Row locks (SKIP LOCKED) and `published_at IS NULL` mean an id that is both pending and caught up, or also
 *   taken by the worker relay or the sweeper, is sent once.
 * - **Broker down.** Ids stay pending (≤ MAX_PENDING) and are retried after Broker's back-off.
 * - **Stop (SIGTERM).** The socket's name is removed first (later senders touch the marker, so the next relay
 *   catches them up). The queue is drained, and the pending ids are flushed within `flushSec` (inside supervisord's
 *   stopwaitsecs). Anything still pending stays in the outbox for the next relay's start-up catch-up.
 *
 * DB slot discipline (P61, the container's DbSlots): at most ONE connection. It is taken only after the broker
 * channel is open, kept while ids are pending and for `idleGraceSec` after the last of them (no reconnect per
 * request in a burst), and given back at once on a broker failure, after a catch-up that leaves nothing pending, and
 * on stop. The only remote work done while holding it is the publish + confirm that the row locks require. A slot
 * that is not free within 0.2 s is retried shortly, and the socket is drained in between.
 */
final class RelayLoop
{
    public const MAX_PENDING = 10000;

    public const PER_PUBLISH = 500;

    /** Rows per catch-up round, and rounds per tick (pending ids are served between them). */
    public const CATCH_UP_BATCH = 100;

    public const CATCH_UP_ROUNDS = 10;

    /** @var array<string, true> */
    private array $pending = [];

    private bool $stop = false;

    /** At start: ids dropped while no relay was bound. */
    private bool $catchUpDue = true;

    private float $nextCatchUp = 0.0;

    private float $retryAt = 0.0;

    private bool $failing = false;

    private bool $overflowing = false;

    private bool $holding = false;

    private float $lastPendingAt = 0.0;

    private readonly Closure $acquireDb;

    private readonly Closure $releaseDb;

    /**
     * @param  null|Closure(): void  $acquireDb  takes the DB slot (throws BackendUnavailable when none is free soon)
     * @param  null|Closure(): void  $releaseDb  closes the connection and gives the slot back
     */
    public function __construct(
        private readonly Relay $relay,
        private readonly Socket $sock,
        private readonly string $socketPath,
        private readonly string $droppedMarker,
        private readonly int $perPublish = self::PER_PUBLISH,
        private readonly float $catchUpEverySec = 10.0,
        private readonly float $idleGraceSec = 1.0,
        ?Closure $acquireDb = null,
        ?Closure $releaseDb = null,
    ) {
        $this->acquireDb = $acquireDb ?? fn () => app(DbSlots::class)->acquire(0.2);
        $this->releaseDb = $releaseDb ?? function (): void {
            DB::disconnect();
            app(DbSlots::class)->release();
        };
    }

    /** Binds the relay's datagram socket at $path (a stale name is replaced), world-writable, non-blocking. */
    public static function bind(string $path): Socket
    {
        $sock = socket_create(AF_UNIX, SOCK_DGRAM, 0);
        if (! $sock instanceof Socket) {
            throw new RuntimeException('relay: cannot create the socket');
        }
        @unlink($path);
        if (! socket_bind($sock, $path)) {
            throw new RuntimeException("relay: cannot bind {$path}: ".socket_strerror(socket_last_error($sock)));
        }
        @chmod($path, 0666);
        socket_set_nonblock($sock);

        return $sock;
    }

    public function stop(): void
    {
        $this->stop = true;
    }

    public function stopping(): bool
    {
        return $this->stop;
    }

    public function pendingCount(): int
    {
        return count($this->pending);
    }

    public function holdsDb(): bool
    {
        return $this->holding;
    }

    /** Runs until stop(), then shuts down (flush within $flushSec). Returns the number of ids left pending. */
    public function run(float $flushSec = 8.0): int
    {
        while (! $this->stop) {
            $this->tick();
        }

        return $this->shutdown($flushSec);
    }

    /** One iteration: wait for datagrams (≤ $maxWaitSec), drain, publish what is pending, catch up when due. */
    public function tick(float $maxWaitSec = 1.0): void
    {
        $read = [$this->sock];
        $none = null;
        $wait = $this->waitFor(microtime(true), $maxWaitSec);
        if (@socket_select($read, $none, $none, (int) $wait, (int) (fmod($wait, 1.0) * 1_000_000)) > 0) {
            $this->drain();
        }
        if (@unlink($this->droppedMarker)) {
            $this->catchUpDue = true;
        }
        $now = microtime(true);
        if ($now >= $this->nextCatchUp) {
            $this->catchUpDue = true;
        }
        if (($this->pending !== [] || $this->catchUpDue) && $now >= $this->retryAt) {
            $this->work();
        }
        if ($this->holding && $this->pending === [] && ! $this->catchUpDue
            && microtime(true) - $this->lastPendingAt >= $this->idleGraceSec) {
            $this->release();
        }
    }

    /** The stop: unbind, drain, flush the pending ids until $flushSec passes. Returns the number left pending. */
    public function shutdown(float $flushSec): int
    {
        $deadline = microtime(true) + $flushSec;
        @unlink($this->socketPath);
        $this->drain();
        while ($this->pending !== [] && microtime(true) < $deadline) {
            try {
                $this->relay->publisher();
                ($this->acquireDb)();
                $this->holding = true;
                $this->publishPending();
            } catch (BackendUnavailable) {
                usleep(50_000);
            } catch (Throwable $e) {
                Log::warning('relay: flush on stop failed; retrying until the deadline', ['pending' => count($this->pending), 'err' => $e->getMessage()]);
                $this->release();
                usleep((int) (max(0.0, min(0.2, $deadline - microtime(true))) * 1_000_000));
            }
            $this->drain();
        }
        $left = count($this->pending);
        if ($left > 0) {
            // The rows are committed: the next relay's start-up catch-up publishes them.
            @touch($this->droppedMarker);
            Log::warning('relay stopped with ids pending; the next relay catches them up from the outbox', ['pending' => $left]);
        }
        $this->release();
        socket_close($this->sock);

        return $left;
    }

    private function waitFor(float $now, float $maxWaitSec): float
    {
        if ($this->pending !== [] || $this->catchUpDue) {
            return max(0.0, min($maxWaitSec, $this->retryAt - $now));
        }
        $wait = min($maxWaitSec, $this->nextCatchUp - $now);
        if ($this->holding) {
            $wait = min($wait, $this->lastPendingAt + $this->idleGraceSec - $now);
        }

        return max(0.0, $wait);
    }

    private function work(): void
    {
        try {
            // The broker first: a broker that is down never holds a DB connection.
            $this->relay->publisher();
            ($this->acquireDb)();
            $this->holding = true;
            $this->publishPending();
            if ($this->catchUpDue) {
                $this->catchUp();
            }
            if ($this->failing) {
                Log::info('relay: the broker is back', ['pending' => count($this->pending)]);
            }
            $this->failing = false;
        } catch (BackendUnavailable) {
            // No DB slot free right now (a burst of requests holds them): drain and try again shortly.
            $this->retryAt = microtime(true) + 0.05;
        } catch (BrokerUnavailable $e) {
            if (! $this->failing) {
                Log::warning('relay: the broker is unavailable; the ids stay pending', ['pending' => count($this->pending), 'err' => $e->getMessage()]);
            }
            $this->failing = true;
            $this->retryAt = microtime(true) + 0.5;
            $this->release();
        } catch (Throwable $e) {
            Log::warning('relay failed; retrying', ['pending' => count($this->pending), 'err' => $e->getMessage()]);
            $this->retryAt = microtime(true) + 1.0;
            $this->release();
        }
    }

    /** The pending ids in chunks; the socket is drained before each (new ids join the next tick's snapshot). */
    private function publishPending(): void
    {
        foreach (array_chunk(array_keys($this->pending), $this->perPublish) as $chunk) {
            $this->drain();
            $ids = array_map('strval', $chunk);
            $this->guarded(fn () => $this->relay->publish($ids));
            foreach ($ids as $id) {
                unset($this->pending[$id]);
            }
            $this->lastPendingAt = microtime(true);
        }
    }

    /** Up to CATCH_UP_ROUNDS rounds of the oldest unpublished rows; still due if more remain. */
    private function catchUp(): void
    {
        for ($round = 0; $round < self::CATCH_UP_ROUNDS; $round++) {
            $this->drain();
            $n = $this->guarded(fn () => $this->relay->publishOldest(self::CATCH_UP_BATCH));
            if ($n < self::CATCH_UP_BATCH) {
                $this->catchUpDue = false;
                $this->nextCatchUp = microtime(true) + $this->catchUpEverySec;

                return;
            }
        }
    }

    /**
     * Runs a publish + confirm with SIGTERM/SIGINT held back: a stop request never interrupts the confirm wait
     * halfway (it is delivered right after, and the loop then flushes and stops).
     *
     * @template T
     *
     * @param  Closure(): T  $fn
     * @return T
     */
    private function guarded(Closure $fn): mixed
    {
        if (! function_exists('pcntl_sigprocmask')) {
            return $fn();
        }
        pcntl_sigprocmask(SIG_BLOCK, [SIGTERM, SIGINT]);
        try {
            return $fn();
        } finally {
            pcntl_sigprocmask(SIG_UNBLOCK, [SIGTERM, SIGINT]);
        }
    }

    private function drain(): void
    {
        $buf = '';
        $from = '';
        while (($n = @socket_recvfrom($this->sock, $buf, 65536, 0, $from)) !== false && $n > 0) {
            foreach (explode("\n", $buf) as $id) {
                if (! QueryReader::isUuid($id) || isset($this->pending[$id])) {
                    continue;
                }
                if (count($this->pending) < self::MAX_PENDING) {
                    $this->pending[$id] = true;
                    $this->overflowing = false;
                } else {
                    // Dropped from memory only: the row is committed, the catch-up publishes it.
                    $this->catchUpDue = true;
                    if (! $this->overflowing) {
                        Log::warning('relay: too many pending ids; the rest are caught up from the outbox', ['pending' => count($this->pending)]);
                    }
                    $this->overflowing = true;
                }
            }
        }
    }

    private function release(): void
    {
        if ($this->holding) {
            ($this->releaseDb)();
        }
        $this->holding = false;
    }
}
