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
 * On METRICS_PORT (docker/Caddyfile: every request of that block arrives with the server variable
 * AGROTRACE_METRICS_LISTENER, which no client can set — headers arrive as HTTP_*): `GET /metrics` exactly as written
 * gets the exposition, anything else Express's plain `404 not found\n`; never measured (L15), no request context, no
 * access log.
 *
 * Every other request is measured ONCE, after its response was sent (an after-response callback of App\Octane\
 * EndOfRequest — L4 order: the relay, then this, then the DB connection closed): method, `route` = the contract
 * template of the raw path ContractGate matches, without `/api/v1` (`unmatched` outside the contract), status, and the
 * time from here to the moment the response was sent (RequestContext::sentAt, taken by EndOfRequest before any
 * after-response work — a mail delivery queued during the request is not response time; Express ends on `finish`).
 *
 * 499 (status()): a client that went away before the response, as Express's `close` before `finish` — seen by
 * App\Http\ClientConnection while the request waited (a report, an upload's lane: it marks RequestContext::clientGone),
 * or reported by the write of a whole response (connection_aborted()). A stream (SSE) whose headers were sent keeps its
 * status and gives one long observation. Known under-count (measured on the stand, Task 14): FrankenPHP 1.4 behind the
 * HAProxy front reports neither through connection_aborted() nor through the socket table a client that closed during
 * a short request (~150 ms) — such a request keeps its real status where Express records 499; HAProxy's termination
 * state is the only observer of it. Answers of the HAProxy front that never reach PHP (its 400 for a malformed
 * %-escape, its own parse errors, docker/haproxy-api.cfg) are not seen here either.
 */
final class Metrics
{
    public const LISTENER_VAR = 'AGROTRACE_METRICS_LISTENER';

    public function handle(Request $request, Closure $next): Response
    {
        if ($request->server->get(self::LISTENER_VAR) === '1') {
            // Caddy's path matcher is case-insensitive and decodes; Express takes `GET /metrics` exactly as written.
            if ($request->getRealMethod() !== 'GET' || explode('?', (string) $request->server->get('REQUEST_URI', ''), 2)[0] !== '/metrics') {
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
            app(HttpMetrics::class)->observe(
                $method,
                $route,
                self::status($response, $ctx->clientGone(), connection_aborted() === 1),
                (($ctx->sentAt() ?? hrtime(true)) - $start) / 1e9,
            );
        });

        return $response;
    }

    /** The status label: 499 for a client gone before the response; a stream that started keeps its status. */
    public static function status(Response $response, bool $clientGone, bool $aborted): int
    {
        if ($clientGone || ($aborted && ! $response instanceof StreamedResponse)) {
            return 499;
        }

        return $response->getStatusCode();
    }
}
