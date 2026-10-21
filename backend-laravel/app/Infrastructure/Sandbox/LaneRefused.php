<?php

namespace App\Infrastructure\Sandbox;

use RuntimeException;

/**
 * A lane did not produce a result: `too-complex` (queue full, deadline missed, the child crashed or exceeded its memory)
 * or `aborted` (the client went away while the job waited).
 */
final class LaneRefused extends RuntimeException
{
    public function __construct(public readonly string $reason, string $why = '')
    {
        parent::__construct("sandbox lane refused ({$reason}): {$why}");
    }
}
