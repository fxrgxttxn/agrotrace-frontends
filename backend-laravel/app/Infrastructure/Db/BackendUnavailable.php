<?php

namespace App\Infrastructure\Db;

use RuntimeException;

/** No DB slot or connection within the wait (P61, L4): rendered as 503 BACKEND_UNAVAILABLE. */
final class BackendUnavailable extends RuntimeException {}
