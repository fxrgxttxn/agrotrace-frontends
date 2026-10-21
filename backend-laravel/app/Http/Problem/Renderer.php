<?php

namespace App\Http\Problem;

use App\Infrastructure\Db\BackendUnavailable;
use App\Support\Json;
use App\Support\RequestContext;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Database\QueryException;
use Illuminate\Http\Exceptions\PostTooLargeException;
use Illuminate\Http\Response;
use Illuminate\Validation\ValidationException;
use JsonException;
use PDOException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Throwable;

/**
 * The single exception renderer (bootstrap/app.php withExceptions): every throwable becomes an
 * `application/problem+json` response of the contract's `Problem` schema with X-Backend (and X-Request-Id when the
 * request has one) — Laravel's HTML pages, `message`/`errors` JSON and traces never reach a client. An unknown
 * exception is 500 INTERNAL without any detail.
 */
final class Renderer
{
    /** The JSON body limit of the gateway (R34/R79: client_max_body_size 12m). */
    public const MAX_JSON_BYTES = 12_582_912;

    public static function render(Throwable $e): Response
    {
        $problem = self::toProblem($e) ?? new Problem(500, ProblemCode::INTERNAL);

        return self::response($problem);
    }

    public static function response(Problem $problem): Response
    {
        $response = new Response(Json::encode($problem->body()), $problem->status, [
            'Content-Type' => 'application/problem+json; charset=utf-8',
        ]);
        foreach ($problem->headers as $name => $value) {
            $response->headers->set($name, $value);
        }
        $response->headers->set('X-Backend', 'laravel');
        try {
            $id = app(RequestContext::class)->requestId();
            if ($id !== null) {
                $response->headers->set('X-Request-Id', $id);
            }
        } catch (Throwable) {
            // No container (very early failure): X-Request-Id is added by RequestContextMw when the response passes it.
        }

        return $response;
    }

    /** The problem a throwable stands for; null = unexpected (500 INTERNAL). */
    public static function toProblem(Throwable $e): ?Problem
    {
        if ($e instanceof Problem) {
            return $e;
        }
        if (self::isBackendUnavailable($e)) {
            return new Problem(503, ProblemCode::BACKEND_UNAVAILABLE);
        }
        if ($e instanceof JsonException) {
            return Problem::validation(['_root' => ['validation.invalid']]);
        }
        if ($e instanceof PostTooLargeException) {
            return self::tooLarge();
        }
        if ($e instanceof ModelNotFoundException) {
            return new Problem(404, ProblemCode::NOT_FOUND);
        }
        if ($e instanceof AuthenticationException) {
            return new Problem(401, ProblemCode::UNAUTHORIZED);
        }
        // Laravel's validator is not used (L7); should one throw, its messages never reach the client.
        if ($e instanceof ValidationException) {
            return Problem::validation(['_root' => ['validation.invalid']]);
        }
        // ContractGate is the only source of 405: a router 405 means "this method's route is not implemented yet" on a
        // contract path whose method the contract does declare — the operation does not exist yet, 404 (port notes).
        if ($e instanceof MethodNotAllowedHttpException) {
            return new Problem(404, ProblemCode::NOT_FOUND);
        }
        if ($e instanceof HttpExceptionInterface) {
            $status = $e->getStatusCode();

            return match (true) {
                $status === 401 => new Problem(401, ProblemCode::UNAUTHORIZED),
                $status === 403 => new Problem(403, ProblemCode::FORBIDDEN),
                $status === 404 => new Problem(404, ProblemCode::NOT_FOUND),
                $status === 413 => self::tooLarge(),
                $status === 415 => new Problem(415, ProblemCode::UNSUPPORTED_MEDIA_TYPE,
                    params: ['allowed' => ['application/json']]),
                $status === 429 => new Problem(429, ProblemCode::RATE_LIMITED),
                $status >= 400 && $status < 500 => Problem::validation(['_root' => ['validation.invalid']]),
                $status === 503 => new Problem(503, ProblemCode::BACKEND_UNAVAILABLE),
                default => null,
            };
        }

        return null;
    }

    public static function tooLarge(): Problem
    {
        return new Problem(413, ProblemCode::FILE_TOO_LARGE, params: ['maxBytes' => self::MAX_JSON_BYTES]);
    }

    /**
     * P61: no DB slot/connection in time (BackendUnavailable), a connection failure (SQLSTATE class 08), or a statement
     * or lock wait past the session's statement_timeout (57014) / lock_timeout (55P03) — the infrastructure is
     * unavailable, not the request wrong. Searched along the exception chain (Laravel wraps PDO errors in
     * QueryException).
     */
    private static function isBackendUnavailable(Throwable $e): bool
    {
        for ($x = $e; $x !== null; $x = $x->getPrevious()) {
            if ($x instanceof BackendUnavailable) {
                return true;
            }
            $state = self::sqlState($x);
            if ($state !== null && ($state === '57014' || $state === '55P03' || str_starts_with($state, '08'))) {
                return true;
            }
        }

        return false;
    }

    /** SQLSTATE of a PDO error (`errorInfo[0]`), or null. */
    public static function sqlState(Throwable $e): ?string
    {
        $info = null;
        if ($e instanceof PDOException) { // QueryException extends PDOException
            $info = $e->errorInfo;
        }
        $state = is_array($info) ? ($info[0] ?? null) : null;
        if (! is_string($state) && $e instanceof PDOException && is_string($e->getCode())) {
            $state = $e->getCode();
        }

        return is_string($state) && $state !== '' ? $state : null;
    }
}
