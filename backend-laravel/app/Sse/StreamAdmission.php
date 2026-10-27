<?php

namespace App\Sse;

/**
 * The cap on open SSE streams of one api-laravel process (fix round 1, I1). Each stream holds one of FrankenPHP's
 * classic threads for up to 15 minutes, and the pool is fixed (docker/entrypoint.sh: SSE_MAX_STREAMS +
 * ADMISSION_THREADS). A request that finds every thread busy is parked by FrankenPHP with no answer at all — not
 * even its 401 or 429 — so the count is kept here, below the pool: past SSE_MAX_STREAMS a stream is answered at once
 * (StreamController: a 200 with only `retry:`, which an EventSource follows by reconnecting later; a problem
 * response would end it for good, and the operation declares no 503), and the spare threads stay free for those
 * answers. Express has no stream cap of its own (none per user either), so neither is there one per user here.
 *
 * The count is one APCu entry, shared by every thread of the process (FrankenPHP is one process; a restart starts
 * from zero with the streams gone). A stream gives its place back exactly once: in a `finally` and, should PHP die
 * on a fatal error, in a shutdown function (StreamController). Without APCu every stream is admitted, as before.
 */
final class StreamAdmission
{
    public const KEY = 'agrotrace:sse:open-streams';

    private bool $held = false;

    public function __construct(private readonly int $cap, private readonly string $key = self::KEY) {}

    /** Takes a place; false — the cap is reached (nothing is held then). */
    public function enter(): bool
    {
        if (! function_exists('apcu_inc') || ! apcu_enabled()) {
            return true;
        }
        apcu_add($this->key, 0);
        $n = apcu_inc($this->key);
        if ($n === false) {
            return true;
        }
        if ($n > $this->cap) {
            $this->decrement();

            return false;
        }
        $this->held = true;

        return true;
    }

    /** Gives the place back; a second call does nothing. */
    public function leave(): void
    {
        if ($this->held) {
            $this->held = false;
            $this->decrement();
        }
    }

    /** Streams counted now (tests, the log). */
    public function open(): int
    {
        return function_exists('apcu_fetch') ? max(0, (int) apcu_fetch($this->key)) : 0;
    }

    private function decrement(): void
    {
        $n = apcu_dec($this->key);
        // Below zero only after APCu lost the entry while streams were open (an expunge): count from zero again.
        if (is_int($n) && $n < 0) {
            apcu_cas($this->key, $n, 0);
        }
    }
}
