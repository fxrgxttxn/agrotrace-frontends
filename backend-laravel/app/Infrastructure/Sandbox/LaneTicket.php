<?php

namespace App\Infrastructure\Sandbox;

/**
 * A job's place in a sandbox lane (Lane::admit): the running slot or a waiting one, and the deadline counted from
 * admission. run() waits for the running slot (a client that went away leaves the queue: `aborted`; the deadline
 * passing: `too-complex`), then runs the job once; release() gives the place back (idempotent, also on destruction —
 * flock dies with the file description anyway). One ticket per job; it holds no DB slot (P61).
 */
final class LaneTicket
{
    private const POLL_US = 5_000;

    private bool $used = false;

    /**
     * @param  resource|null  $run  the running slot, when admission found it free
     * @param  resource|null  $wait  the waiting slot otherwise
     */
    public function __construct(
        private readonly LaneOptions $o,
        public readonly float $deadline,
        private $run,
        private $wait,
    ) {}

    /** @param  null|callable(): bool  $clientGone */
    public function run(string $script, string $input, ?callable $clientGone = null): string
    {
        if ($this->used || ($this->run === null && $this->wait === null)) {
            throw new LaneRefused('too-complex', 'the ticket was used or released');
        }
        $this->used = true;
        while ($this->run === null) {
            if ($clientGone !== null && $clientGone()) {
                throw new LaneRefused('aborted', 'client gone while waiting');
            }
            if (microtime(true) >= $this->deadline) {
                throw new LaneRefused('too-complex', 'deadline missed while waiting');
            }
            usleep(self::POLL_US);
            $this->run = Lane::tryLock($this->o->dir().'/run.lock');
        }
        if ($this->wait !== null) {
            Lane::unlock($this->wait);
            $this->wait = null;
        }

        return Lane::execute($script, $input, $this->o, $this->deadline);
    }

    public function release(): void
    {
        if ($this->wait !== null) {
            Lane::unlock($this->wait);
            $this->wait = null;
        }
        if ($this->run !== null) {
            Lane::unlock($this->run);
            $this->run = null;
        }
    }

    public function __destruct()
    {
        $this->release();
    }
}
