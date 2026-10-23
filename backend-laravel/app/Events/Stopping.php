<?php

namespace App\Events;

use RuntimeException;

/** A handler gave up because the process is stopping (StopSignal): the Consumer returns the event to the queue. */
final class Stopping extends RuntimeException {}
