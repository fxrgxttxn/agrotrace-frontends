<?php

/*
 * Renderer (Review Focus 6): every exception class becomes an `application/problem+json` body of the contract's
 * `Problem` schema — type /problems/<kebab(code)>, status = HTTP status, X-Backend — never Laravel's HTML, its
 * `message`/`errors` JSON or a trace. ProblemCode carries exactly the contract's codes.
 */

use App\Contract\Contract;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Problem\Renderer;
use App\Infrastructure\Db\BackendUnavailable;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Database\QueryException;
use Illuminate\Http\Exceptions\PostTooLargeException;
use Illuminate\Support\Facades\Route;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Tests\TestCase;

uses(TestCase::class);

function pdoError(string $state): PDOException
{
    $e = new PDOException("SQLSTATE[{$state}]: injected");
    $e->errorInfo = [$state, 7, 'injected'];

    return $e;
}

it('has exactly the ProblemCode values of the contract', function () {
    $enum = app(Contract::class)->doc()['components']['schemas']['ProblemCode']['enum'];
    expect(array_map(fn (ProblemCode $c) => $c->value, ProblemCode::cases()))->toBe($enum);
    expect(ProblemCode::VERSION_CONFLICT->type())->toBe('/problems/version-conflict');
    expect(ProblemCode::NO_LAB_AVAILABLE->type())->toBe('/problems/no-lab-available');
    expect(ProblemCode::METHOD_NOT_ALLOWED->title())->toBe('Method not allowed');
});

/** Thrown inside a route, rendered by the application's exception handler, as a client receives it. */
function renderedThrough(Throwable $e): array
{
    Route::get('/api/v1/me', fn () => throw $e)->name('getMe'); // a declared operation, so ContractGate lets it reach the route
    app('router')->getRoutes()->refreshNameLookups(); // re-registered within one test
    $res = test()->raw('GET', '/api/v1/me', ['X-Request-Id' => 'render-1']);
    expect($res->headers->get('Content-Type'))->toBe('application/problem+json; charset=utf-8');
    expect($res->headers->get('X-Backend'))->toBe('laravel');
    expect($res->headers->get('X-Request-Id'))->toBe('render-1');
    $body = json_decode($res->getContent(), true);
    expect($body['status'])->toBe($res->getStatusCode());
    expect($body['type'])->toBe('/problems/'.str_replace('_', '-', strtolower($body['code'])));
    expect(array_diff(array_keys($body), ['type', 'title', 'status', 'code', 'detail', 'rule', 'params', 'errors']))->toBe([]);
    expect($res->getContent())->not->toContain('#0 ')->not->toContain('vendor/');

    return [$res->getStatusCode(), $body, $res];
}

it('renders every exception class as the contract problem', function (Closure $make, int $status, string $code) {
    [$s, $body] = renderedThrough($make());
    expect($s)->toBe($status);
    expect($body['code'])->toBe($code);
})->with([
    'Problem' => [fn () => new Problem(422, ProblemCode::BUSINESS_RULE, rule: 'BR-01', params: ['until' => '2026-09-24']), 422, 'BUSINESS_RULE'],
    'validation Problem' => [fn () => Problem::validation(['items[0].massKg' => ['validation.required']]), 400, 'VALIDATION'],
    'unknown RuntimeException' => [fn () => new RuntimeException('secret internals'), 500, 'INTERNAL'],
    'TypeError' => [fn () => new TypeError('bad'), 500, 'INTERNAL'],
    'JsonException' => [fn () => new JsonException('Syntax error'), 400, 'VALIDATION'],
    'ModelNotFound' => [fn () => (new ModelNotFoundException)->setModel('App\\Models\\Batch'), 404, 'NOT_FOUND'],
    'NotFoundHttp' => [fn () => new NotFoundHttpException, 404, 'NOT_FOUND'],
    'MethodNotAllowedHttp (router)' => [fn () => new MethodNotAllowedHttpException(['GET']), 404, 'NOT_FOUND'],
    'PostTooLarge' => [fn () => new PostTooLargeException, 413, 'FILE_TOO_LARGE'],
    'HttpException 415' => [fn () => new HttpException(415), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    'HttpException 400' => [fn () => new HttpException(400, 'bad request'), 400, 'VALIDATION'],
    'TooManyRequests' => [fn () => new TooManyRequestsHttpException, 429, 'RATE_LIMITED'],
    'AuthenticationException' => [fn () => new AuthenticationException, 401, 'UNAUTHORIZED'],
    'AuthorizationException' => [fn () => new AuthorizationException, 403, 'FORBIDDEN'],
    'ValidationException' => [fn () => ValidationException::withMessages(['x' => 'y']), 400, 'VALIDATION'],
    'BackendUnavailable (no DB slot)' => [fn () => new BackendUnavailable('no slot'), 503, 'BACKEND_UNAVAILABLE'],
    'statement_timeout 57014' => [fn () => new QueryException('pgsql', 'select 1', [], pdoError('57014')), 503, 'BACKEND_UNAVAILABLE'],
    'lock_timeout 55P03' => [fn () => new QueryException('pgsql', 'select 1', [], pdoError('55P03')), 503, 'BACKEND_UNAVAILABLE'],
    'connection failure 08006' => [fn () => new QueryException('pgsql', 'select 1', [], pdoError('08006')), 503, 'BACKEND_UNAVAILABLE'],
    'other SQL error 23505' => [fn () => new QueryException('pgsql', 'insert', [], pdoError('23505')), 500, 'INTERNAL'],
]);

it('writes params and errors as JSON objects, also when empty, and keeps the extra headers', function () {
    [, $body, $res] = renderedThrough(new Problem(405, ProblemCode::METHOD_NOT_ALLOWED, params: [], headers: ['Allow' => 'GET']));
    expect($res->getContent())->toContain('"params":{}');
    expect($res->headers->get('Allow'))->toBe('GET');
    [, $body] = renderedThrough(Problem::validation(['_root' => ['validation.invalid']]));
    expect($body['errors'])->toBe(['_root' => ['validation.invalid']]);
});

it('gives a 500 no detail of the exception', function () {
    [, $body, $res] = renderedThrough(new LogicException('SELECT password_hash FROM users'));
    expect($body)->toBe(['type' => '/problems/internal', 'title' => 'Internal server error', 'status' => 500, 'code' => 'INTERNAL']);
    expect($res->getContent())->not->toContain('password_hash');
});

it('renders without a request too (Renderer::render)', function () {
    $res = Renderer::render(new BackendUnavailable('x'));
    expect($res->getStatusCode())->toBe(503);
    expect(json_decode($res->getContent(), true)['code'])->toBe('BACKEND_UNAVAILABLE');
    expect($res->headers->get('X-Backend'))->toBe('laravel');
});
