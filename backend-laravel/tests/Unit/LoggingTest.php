<?php

/*
 * Logs (contract «Мониторинг», Global Constraints): JSON lines on stdout with `backend` and `requestId` — the
 * request's X-Request-Id; in the worker the handled envelope's requestId (audit and outbox rows of the handler stay
 * system ones, RequestContext::beginEvent). The access log writes the path without its query string, so an SSE
 * `access_token` or a signed link's `sig`/`exp` never reach a log line (R88 M1).
 */

use App\Support\Logging\JsonLineFormatter;
use App\Support\RequestContext;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Event;
use Monolog\Level;
use Monolog\LogRecord;
use Tests\TestCase;

uses(TestCase::class);

function logLine(string $msg, array $context = []): array
{
    $line = (new JsonLineFormatter)->format(new LogRecord(new DateTimeImmutable, 'app', Level::Info, $msg, $context));
    expect($line)->toEndWith("\n")->and(substr_count($line, "\n"))->toBe(1);

    return json_decode($line, true, flags: JSON_THROW_ON_ERROR);
}

it('a request log line carries backend and the request id', function () {
    app(RequestContext::class)->begin('req-1', '10.0.0.7');
    expect(logLine('hello', ['n' => 1]))->toMatchArray(['level' => 'info', 'backend' => 'laravel', 'requestId' => 'req-1', 'msg' => 'hello', 'n' => 1]);
});

it('a worker handler logs the envelope requestId, its own request id stays null', function () {
    $ctx = app(RequestContext::class);
    $ctx->beginEvent('env-7');
    expect(logLine('handled'))->toMatchArray(['backend' => 'laravel', 'requestId' => 'env-7']);
    expect($ctx->requestId())->toBeNull(); // what audit rows and enqueued events read: system (null)
});

it('secrets never reach a log line', function () {
    expect(logLine('x', ['access_token' => 'jwt', 'sig' => 'abc', 'nested' => ['password' => 'p']]))
        ->toMatchArray(['access_token' => '***', 'sig' => '***', 'nested' => ['password' => '***']]);
});

it('the access log writes the path without the query string (access_token, sig, exp)', function () {
    $lines = [];
    Event::listen(MessageLogged::class, function (MessageLogged $e) use (&$lines) {
        if ($e->message === 'request') {
            $lines[] = $e->context;
        }
    });
    $this->raw('GET', '/api/v1/events/stream?access_token=secret.jwt.value');
    $this->raw('GET', '/api/v1/files/0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e?sig=deadbeef&exp=1999999999');
    expect(array_column($lines, 'path'))->toBe([
        '/api/v1/events/stream',
        '/api/v1/files/0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    ]);
    expect(json_encode($lines))->not->toContain('secret.jwt.value')->not->toContain('deadbeef')->not->toContain('1999999999');
});
