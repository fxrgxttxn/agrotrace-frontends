<?php

namespace App\Infrastructure\Amqp;

/**
 * At most ONE `vsd.import` handler per worker container (R92, L2): the two `agrotrace:consume` processes share a
 * non-blocking flock on `agrotrace.vsd_lock` (/tmp/agrotrace-vsd.lock); the kernel drops it when the holder dies.
 */
final class VsdLane
{
    /** @var resource|null */
    private $handle = null;

    public function __construct(private readonly string $file = '/tmp/agrotrace-vsd.lock') {}

    public static function fromConfig(): self
    {
        return new self((string) config('agrotrace.vsd_lock', '/tmp/agrotrace-vsd.lock'));
    }

    public function tryAcquire(): bool
    {
        if ($this->handle !== null) {
            return false;
        }
        $h = @fopen($this->file, 'c');
        if ($h === false) {
            return false;
        }
        if (! flock($h, LOCK_EX | LOCK_NB)) {
            fclose($h);

            return false;
        }
        $this->handle = $h;

        return true;
    }

    public function release(): void
    {
        if ($this->handle !== null) {
            flock($this->handle, LOCK_UN);
            fclose($this->handle);
            $this->handle = null;
        }
    }
}
