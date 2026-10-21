<?php

namespace App\Http\Middleware;

use App\Http\Validation\Ecma;
use App\Octane\EndOfRequest;
use App\Support\RequestContext;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * First of the global stack. X-Request-Id (spec 8.3, R79): the client's value when it matches
 * `^[A-Za-z0-9._-]{1,64}$`, else a fresh UUID v4 — echoed on every response, errors included. The client IP (P9): the
 * last X-Forwarded-For entry (the peer the gateway saw — one trusted hop), else the socket peer; `::ffff:a.b.c.d` is
 * shown as IPv4. Also pins the request method to the real one: Symfony's method override (X-HTTP-Method-Override,
 * `_method`) is not part of the contract. Terminable: the end of the request runs App\Octane\EndOfRequest.
 */
final class RequestContextMw
{
    public const REQUEST_ID = '^[A-Za-z0-9._-]{1,64}$';

    public function handle(Request $request, Closure $next): Response
    {
        $request->headers->remove('X-HTTP-Method-Override');
        $request->query->remove('_method');
        $request->request->remove('_method');

        $sent = $request->headers->get('X-Request-Id');
        $id = is_string($sent) && Ecma::test(Ecma::compile(self::REQUEST_ID), $sent) ? $sent : (string) Str::uuid();
        app(RequestContext::class)->begin($id, self::clientIp(
            $request->headers->get('X-Forwarded-For'),
            $request->server->get('REMOTE_ADDR'),
        ));

        $response = $next($request);
        $response->headers->set('X-Request-Id', $id);

        return $response;
    }

    public function terminate(Request $request, Response $response): void
    {
        EndOfRequest::finish(app());
    }

    public static function clientIp(?string $forwardedFor, mixed $remoteAddr): ?string
    {
        if ($forwardedFor !== null && $forwardedFor !== '') {
            $hops = explode(',', $forwardedFor);
            $ip = self::ip(trim((string) end($hops)));
            if ($ip !== null) {
                return $ip;
            }
        }

        return is_string($remoteAddr) ? self::ip($remoteAddr) : null;
    }

    private static function ip(string $raw): ?string
    {
        if (str_starts_with(strtolower($raw), '::ffff:') && filter_var(substr($raw, 7), FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            return substr($raw, 7);
        }

        return filter_var($raw, FILTER_VALIDATE_IP) !== false ? $raw : null;
    }
}
