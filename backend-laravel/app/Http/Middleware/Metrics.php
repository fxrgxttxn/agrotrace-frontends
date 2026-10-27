<?php

namespace App\Http\Middleware;

use App\Contract\Contract;
use App\Infrastructure\Metrics\Exposition;
use App\Infrastructure\Metrics\HttpMetrics;
use App\Infrastructure\Metrics\ScrapeGauges;
use App\Support\RequestContext;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Http\Response as PlainResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * The outermost global middleware (P54, L15).
 *
 * On METRICS_PORT (docker/Caddyfile: the :9464 block passes only `GET /metrics` and marks it with the server variable
 * AGROTRACE_METRICS_LISTENER, which no client can set — headers arrive as HTTP_*): the exposition, never measured
 * itself (L15), no request context, no access log.
 *
 * Every other request is measured ONCE, after its response was sent (an after-response callback of App\Octane\
 * EndOfRequest — L4 order: the relay, then this, then the DB connection closed): method, `route` = the contract
 * template of the raw path ContractGate matches, without `/api/v1` (`unmatched` outside the contract), status, the
 * time from here to the end of the send. A client that went away before the response is 499, as Express's `close`
 * before `finish`: seen by App\Http\ClientConnection while the request waited (a report, an upload's lane — it marks
 * RequestContext::clientGone), or reported by the write of the answer (connection_aborted()). Measured on the stand:
 * FrankenPHP 1.4 behind the HAProxy front does not report a client that closed during a short request (~150 ms) —
 * such a request keeps its status; only the waits that watch the connection see it. A stream (SSE) whose headers
 * were sent keeps its status and gives one long observation. Answers of the HAProxy front that never reach PHP (its
 * 400 for a malformed %-escape, docker/haproxy-api.cfg) are not seen here.
 */
final class Metrics
{
    public const LISTENER_VAR = 'AGROTRACE_METRICS_LISTENER';

    public function handle(Request $request, Closure $next): Response
    {
        if ($request->server->get(self::LISTENER_VAR) === '1') {
            // Caddy's path matcher is case-insensitive and decodes; Express takes `/metrics` exactly as written.
            if (explode('?', (string) $request->server->get('REQUEST_URI', ''), 2)[0] !== '/metrics') {
                return new PlainResponse("not found\n", 404, ['Content-Type' => 'text/plain; charset=utf-8']);
            }

            return Exposition::response(app(HttpMetrics::class), app(ScrapeGauges::class));
        }
        $start = hrtime(true);
        $response = $next($request);
        $method = $request->getRealMethod();
        $route = app(Contract::class)->templateFor(ContractGate::rawPath($request)) ?? 'unmatched';
        $ctx = app(RequestContext::class);
        $ctx->afterResponse(function () use ($start, $response, $method, $route, $ctx): void {
            $gone = $ctx->clientGone() || (! $response instanceof StreamedResponse && connection_aborted() === 1);
            app(HttpMetrics::class)->observe(
                $method,
                $route,
                $gone ? 499 : $response->getStatusCode(),
                (hrtime(true) - $start) / 1e9,
            );
        });

        return $response;
    }
}
