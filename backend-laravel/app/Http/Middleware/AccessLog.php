<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

/**
 * One JSON line per request: method, the path without the query string (signed URLs and SSE tokens never reach the
 * log, R88 M1), status, ms. Liveness probes (the docker healthcheck every few seconds) only at debug level.
 */
final class AccessLog
{
    public function handle(Request $request, Closure $next): Response
    {
        $start = hrtime(true);
        $response = $next($request);
        $path = ContractGate::rawPath($request);
        $status = $response->getStatusCode();
        $fields = [
            'method' => $request->getRealMethod(),
            'path' => $path,
            'status' => $status,
            'ms' => round((hrtime(true) - $start) / 1e6, 1),
        ];
        if ($path === '/api/v1/health/live' && $status === 200) {
            Log::debug('request', $fields);
        } else {
            Log::info('request', $fields);
        }

        return $response;
    }
}
