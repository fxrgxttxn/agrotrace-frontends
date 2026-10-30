<?php

use Illuminate\Http\Request;

/*
 * GET /api/v1/events/stream on FrankenPHP's classic threads (docker/Caddyfile, Task 12 step 2): a stream lives up to
 * the token's 15 minutes, so it must not hold one of the OCTANE_WORKERS Octane workers. Laravel boots per stream
 * (~8 ms with OPcache, ~6 MB per stream) and handles the request with the same kernel and middleware as the workers.
 * No time limit; the stream handles a client that went away itself (App\Sse\Stream).
 */

ignore_user_abort(true);
set_time_limit(0);

require __DIR__.'/../vendor/autoload.php';

(require_once __DIR__.'/../bootstrap/app.php')->handleRequest(Request::capture());
