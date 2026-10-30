<?php

namespace App\Events;

use stdClass;

/**
 * A queue event handler (envelope, R56): ONE database transaction starting with Claim::event for everything it
 * changes; throwing makes the consumer retry it in-process (2, 4, 8, 16, 32 s) and then dead-letter it.
 */
interface EventHandler
{
    public function handle(stdClass $envelope): void;
}
