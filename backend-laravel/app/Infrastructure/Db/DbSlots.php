<?php

namespace App\Infrastructure\Db;

/**
 * The api container's counting semaphore over PostgreSQL connections (L4, P61): `DB_SLOTS` flock'ed files, so the
 * number of Octane workers (`OCTANE_WORKERS`, SSE streams hold workers) never decides the number of connections.
 * Every FrankenPHP worker thread opens the slot file with its own fopen — flock locks an open file description, so
 * threads of one process exclude each other like processes do; the kernel drops the lock if the process dies.
 *
 * One instance per worker (warmed in config/octane.php): PgConnector acquires before connecting, EndOfRequest
 * releases after disconnecting. `acquire` is a no-op while this worker holds a slot; disabled outside the api process
 * (worker and scheduler hold exactly one connection per process, L2/L5).
 */
final class DbSlots
{
    /** @var resource|null */
    private $handle = null;

    private ?int $slot = null;

    public function __construct(
        private readonly int $count,
        private readonly string $dir,
        private readonly bool $enabled,
    ) {}

    /** @throws BackendUnavailable when no slot frees up within $timeoutSec */
    public function acquire(float $timeoutSec = 5.0): void
    {
        if (! $this->enabled || $this->handle !== null) {
            return;
        }
        if (! is_dir($this->dir)) {
            @mkdir($this->dir, 0777, true);
        }
        $deadline = microtime(true) + $timeoutSec;
        $start = random_int(0, max(0, $this->count - 1));
        do {
            for ($k = 0; $k < $this->count; $k++) {
                $i = ($start + $k) % $this->count;
                $h = @fopen("{$this->dir}/slot-{$i}", 'c');
                if ($h === false) {
                    continue;
                }
                if (flock($h, LOCK_EX | LOCK_NB)) {
                    $this->handle = $h;
                    $this->slot = $i;

                    return;
                }
                fclose($h);
            }
            usleep(random_int(5_000, 20_000));
        } while (microtime(true) < $deadline);

        throw new BackendUnavailable("no database slot of {$this->count} became free within {$timeoutSec} s");
    }

    public function release(): void
    {
        if ($this->handle === null) {
            return;
        }
        flock($this->handle, LOCK_UN);
        fclose($this->handle);
        $this->handle = null;
        $this->slot = null;
    }

    public function held(): bool
    {
        return $this->handle !== null;
    }

    /** The index of the held slot (tests, logs). */
    public function slot(): ?int
    {
        return $this->slot;
    }

    public function enabled(): bool
    {
        return $this->enabled;
    }

    public function __destruct()
    {
        $this->release();
    }
}
