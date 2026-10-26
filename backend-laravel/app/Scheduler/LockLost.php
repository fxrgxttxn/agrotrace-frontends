<?php

namespace App\Scheduler;

use RuntimeException;

/**
 * A scheduler tick lost its session advisory lock (Tick::locked): the session that took it is gone, or the unlock
 * did not release it. The tick is aborted (or reported as failed when it had already finished).
 */
final class LockLost extends RuntimeException {}
