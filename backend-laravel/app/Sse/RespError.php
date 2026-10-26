<?php

namespace App\Sse;

use RuntimeException;

/** A lost or failed Redis subscription (closed socket, error reply, no pong, protocol error). */
final class RespError extends RuntimeException {}
