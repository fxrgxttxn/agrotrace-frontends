<?php

namespace App\Http\Middleware;

use App\Contract\Contract;
use App\Contract\RouteMatch;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Strict routing by the contract, before any route or body (P3, P8, I1, I2). The raw REQUEST_URI up to `?` is
 * matched against the contract templates, case-sensitively, never decoded or normalized first:
 * - an empty segment anywhere (`//`, `///`, also before /api/v1), a trailing `/`, a malformed `%`-escape in a path
 *   parameter, or a path outside the contract → 404 NOT_FOUND;
 * - a method the contract does not declare for the path (OPTIONS included; HEAD counts as GET) → 405
 *   METHOD_NOT_ALLOWED with `Allow` = the declared methods;
 * - a declared operation not implemented yet → the router finds no route → 404 (Renderer).
 * The only non-contract paths are Swagger UI's (GET/HEAD /api/v1/docs, /api/v1/docs/, /api/v1/docs/<file>). The match
 * (operationId, template, decoded params) is put on the request for the operation middleware.
 */
final class ContractGate
{
    public function __construct(private readonly Contract $contract) {}

    public function handle(Request $request, Closure $next): Response
    {
        $raw = explode('?', (string) $request->server->get('REQUEST_URI', '/'), 2)[0];
        if (str_contains($raw, '//')) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }
        $method = $request->getRealMethod();
        $asGet = $method === 'HEAD' ? 'GET' : $method;
        $allow = $this->contract->methodsFor($raw);
        if ($allow === null) {
            if ($asGet === 'GET' && self::isDocsPath($raw)) {
                return $next($request);
            }
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }
        if (! in_array($asGet, $allow, true)) {
            throw new Problem(405, ProblemCode::METHOD_NOT_ALLOWED, headers: ['Allow' => implode(', ', $allow)]);
        }
        $match = $this->contract->match($asGet, $raw);
        if ($match === null) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }
        $request->attributes->set(RouteMatch::class, $match);

        return $next($request);
    }

    /** Swagger UI (spec 8.3): the page, its initializer, the bundle and the swagger-ui-dist files. */
    public static function isDocsPath(string $raw): bool
    {
        if ($raw === '/api/v1/docs' || $raw === '/api/v1/docs/') {
            return true;
        }
        if (! str_starts_with($raw, '/api/v1/docs/')) {
            return false;
        }

        return ! str_contains(substr($raw, strlen('/api/v1/docs/')), '/');
    }
}
