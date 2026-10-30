<?php

namespace App\Infrastructure\Db;

/**
 * The state of the running Tx attempt (scoped binding): its `now()` text and its after-commit effects. Reset at every
 * attempt; the effects of an attempt that rolls back are dropped.
 */
final class TxState
{
    public bool $active = false;

    public ?string $now = null;

    /** @var list<callable> */
    public array $effects = [];

    public function begin(): void
    {
        $this->active = true;
        $this->now = null;
        $this->effects = [];
    }

    /** @return list<callable> the attempt's effects (to run after a commit; discarded otherwise) */
    public function end(): array
    {
        $effects = $this->effects;
        $this->active = false;
        $this->now = null;
        $this->effects = [];

        return $effects;
    }
}
