<?php

namespace App\Http\Middleware;

use App\Http\ExactHeaders;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * `X-Backend: laravel` on every response (spec 8.3) — gate 404/405, 413, 500, SSE and files included. Symfony's
 * default `Cache-Control: no-cache, private` (added to every response without cache headers) is dropped: Express sends
 * none, and an operation that needs one (`no-store` on token responses, file ETags) sets it explicitly (review M2).
 */
final class BackendHeader
{
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);
        $response->headers->set('X-Backend', 'laravel');
        if (! self::hasExplicitCacheControl($response)) {
            $response->headers->remove('Cache-Control');
        } elseif (! $response->headers instanceof ExactHeaders) {
            // Exactly the directives set (`no-store`, not Symfony's `no-store, private`).
            $response->headers = ExactHeaders::from($response->headers);
        }

        return $response;
    }

    /** Directives set by the application (HeaderBag::$cacheControl), as opposed to the computed default. */
    private static function hasExplicitCacheControl(Response $response): bool
    {
        return (fn () => $this->cacheControl !== [])->call($response->headers);
    }
}
