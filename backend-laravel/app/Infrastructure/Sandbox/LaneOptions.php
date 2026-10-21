<?php

namespace App\Infrastructure\Sandbox;

/**
 * One bounded lane of sandbox work (L6): `name` (its slot files), at most 1 running + `waiting` waiting jobs per
 * container, a deadline of `deadlineSec` counted from enqueue (waiting included, the child's start-up up to `ready`
 * excluded), the child's `memoryLimit`.
 */
final class LaneOptions
{
    public function __construct(
        public readonly string $name,
        public readonly int $waiting = 8,
        public readonly float $deadlineSec = 3.0,
        public readonly string $memoryLimit = '256M',
        public readonly ?string $dir = null,
    ) {}

    public function dir(): string
    {
        return rtrim($this->dir ?? (string) config('agrotrace.sandbox.dir', '/tmp/agrotrace-lanes'), '/').'/'.$this->name;
    }
}
