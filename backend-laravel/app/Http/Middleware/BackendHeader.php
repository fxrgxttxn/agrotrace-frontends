<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** `X-Backend: laravel` on every response (spec 8.3) — gate 404/405, 413, 500, SSE and files included. */
final class BackendHeader
{
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);
        $response->headers->set('X-Backend', 'laravel');

        return $response;
    }
}
