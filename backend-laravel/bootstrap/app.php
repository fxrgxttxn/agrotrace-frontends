<?php

/*
 * The application (Plan 5 Task 1). The global middleware stack is replaced as a whole (port notes):
 *   RequestContextMw → BackendHeader → AccessLog → ContractGate → JsonBody
 * — no HandleCors (it would answer OPTIONS itself), TrustProxies (P9: the last X-Forwarded-For hop is read by
 * RequestContextMw), ValidatePostSize (its own 413), TrimStrings / ConvertEmptyStringsToNull (R36) or
 * PreventRequestsDuringMaintenance. Every exception is rendered by App\Http\Problem\Renderer (RFC 7807, contract
 * `Problem`). Routes have no middleware group: the contract operations are in routes/api.php.
 */

use App\Http\Middleware\AccessLog;
use App\Http\Middleware\BackendHeader;
use App\Http\Middleware\ContractGate;
use App\Http\Middleware\JsonBody;
use App\Http\Middleware\Operation;
use App\Http\Middleware\RequestContextMw;
use App\Http\Problem\Problem;
use App\Http\Problem\Renderer;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        using: function () {
            Route::group([], base_path('routes/api.php'));
        },
        commands: __DIR__.'/../routes/console.php',
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->use([
            RequestContextMw::class,
            BackendHeader::class,
            AccessLog::class,
            ContractGate::class,
            JsonBody::class,
        ]);
        $middleware->alias(['operation' => Operation::class]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        // A client error is the client's, not a failure of ours: only 5xx problems and unexpected exceptions are logged.
        $exceptions->reportable(fn (Problem $p) => $p->status >= 500 ? null : false);
        $exceptions->render(fn (Throwable $e) => Renderer::render($e));
    })
    ->create();
