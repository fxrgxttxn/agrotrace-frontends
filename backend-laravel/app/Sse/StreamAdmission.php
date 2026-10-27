<?php

namespace App\Sse;

use Illuminate\Support\Facades\Log;

/**
 * The caps on open SSE streams of one api-laravel process (fix round 1, I1; fix round 2: per user). Each stream holds
 * one of FrankenPHP's classic threads for up to 15 minutes, and the pool is fixed (docker/entrypoint.sh:
 * SSE_MAX_STREAMS + ADMISSION_THREADS). A request that finds every thread busy is parked by FrankenPHP with no answer
 * at all — not even its 401 or 429 — so the count is kept here, below the pool: past SSE_MAX_STREAMS, or past
 * SSE_MAX_STREAMS_PER_USER streams of one user, a stream is answered at once (StreamController: a 200 with only
 * `retry:`, which an EventSource follows by reconnecting later; a problem response would end it for good, and the
 * operation declares no 503), and the spare threads stay free for those answers. Express has neither cap: it has no
 * pool to exhaust. The global cap is this port's own, and the per-user one keeps a single account (within its `user`
 * rate limit) from taking every place (ruling, T12 re-review 1). The frontends open one stream per tab
 * (api-client openEventStream), so 10 per user is ten tabs.
 *
 * The counts are APCu entries (`…:open-streams` and `…:open-streams:{userId}`), shared by every thread of the process
 * (FrankenPHP is one process; a restart starts from zero with the streams gone). A stream gives its places back
 * exactly once: in a `finally` and, should PHP die on a fatal error, in a shutdown function (StreamController).
 * api-laravel does not start without APCu (EnvConfig); should it still be off, every stream is admitted (logged).
 */
final class StreamAdmission
{
    public const KEY = 'agrotrace:sse:open-streams';

    private bool $held = false;

    public function __construct(
        private readonly int $cap,
        private readonly string $userId = '',
        private readonly int $userCap = PHP_INT_MAX,
        private readonly string $key = self::KEY,
    ) {}

    /** Takes a place; false — a cap is reached (nothing is held then). */
    public function enter(): bool
    {
        if (! function_exists('apcu_inc') || ! apcu_enabled()) {
            Log::error('sse: APCu is off, the stream caps are not enforced');

            return true;
        }
        $user = $this->userKey();
        if (! self::inc($user, $this->userCap)) {
            return false;
        }
        if (! self::inc($this->key, $this->cap)) {
            self::dec($user);

            return false;
        }
        $this->held = true;

        return true;
    }

    /** Gives the places back; a second call does nothing. */
    public function leave(): void
    {
        if ($this->held) {
            $this->held = false;
            self::dec($this->key);
            self::dec($this->userKey());
        }
    }

    /** Streams counted now (tests, the log). */
    public function open(): int
    {
        return function_exists('apcu_fetch') ? max(0, (int) apcu_fetch($this->key)) : 0;
    }

    /** Streams of this user counted now. */
    public function openOfUser(): int
    {
        return function_exists('apcu_fetch') ? max(0, (int) apcu_fetch($this->userKey())) : 0;
    }

    private function userKey(): string
    {
        return "{$this->key}:{$this->userId}";
    }

    /** One more on $key unless that passes $cap (then nothing changes). An APCu failure admits. */
    private static function inc(string $key, int $cap): bool
    {
        apcu_add($key, 0);
        $n = apcu_inc($key);
        if ($n === false) {
            return true;
        }
        if ($n > $cap) {
            self::dec($key);

            return false;
        }

        return true;
    }

    private static function dec(string $key): void
    {
        $n = apcu_dec($key);
        // Below zero only after APCu lost the entry while streams were open (an expunge): count from zero again.
        if (is_int($n) && $n < 0) {
            apcu_cas($key, $n, 0);
        }
    }
}
