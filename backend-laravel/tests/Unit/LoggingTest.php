<?php

/*
 * Logs (contract «Мониторинг», Global Constraints): JSON lines on stdout with `backend` and `requestId` — the
 * request's X-Request-Id; in the worker the handled envelope's requestId (audit and outbox rows of the handler stay
 * system ones, RequestContext::beginEvent). The access log writes the path without its query string, so an SSE
 * `access_token` or a signed link's `sig`/`exp` never reach a log line (R88 M1).
 */

use App\Infrastructure\Db\PgConnection;
use App\Support\Logging\JsonLineFormatter;
use App\Support\RequestContext;
use Illuminate\Database\QueryException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Bootstrap\HandleExceptions;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Monolog\Handler\NullHandler;
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

it('a failed statement\'s QueryException carries the SQL with placeholders, never the bound values (final review M2)', function () {
    expect(DB::connection())->toBeInstanceOf(PgConnection::class);
    try {
        // Fails on the server (as a statement timeout would; the server's own text names no parameter) or, without
        // the stand DB, at connecting.
        DB::update('UPDATE users SET totp_secret = ? WHERE id = ? AND 1 / 0 = 1', ['JBSWY3DPEHPK3PXP', '00000000-0000-4000-8000-0000000000aa']);
        $this->fail('no QueryException');
    } catch (QueryException $e) {
        expect($e->getMessage())->not->toContain('JBSWY3DPEHPK3PXP')->not->toContain('0000000000aa')
            ->toContain('SQL: UPDATE users SET totp_secret = ? WHERE id = ? AND 1 / 0 = 1');
        // As the exception handler reports it: the message is the record's message, the exception its context.
        $line = (new JsonLineFormatter)->format(new LogRecord(new DateTimeImmutable, 'app', Level::Error, $e->getMessage(), ['exception' => $e]));
        expect($line)->not->toContain('JBSWY3DPEHPK3PXP')->not->toContain('0000000000aa');
    }
});

it('keeps the class, SQLSTATE and SQL of the exception it rewrites', function () {
    $pdo = new PDOException('SQLSTATE[23505]: Unique violation: 7 ERROR:  duplicate key');
    $pdo->errorInfo = ['23505', 7, 'duplicate key'];
    $e = PgConnection::withoutBindings(new UniqueConstraintViolationException('pgsql', 'INSERT INTO t (a) VALUES (?)', ['secret'], $pdo));
    expect($e)->toBeInstanceOf(UniqueConstraintViolationException::class)
        ->and($e->getSql())->toBe('INSERT INTO t (a) VALUES (?)')
        ->and($e->errorInfo)->toBe(['23505', 7, 'duplicate key'])
        ->and($e->getPrevious())->toBe($pdo)
        ->and($e->getMessage())->not->toContain('secret');
});

it('deprecations go to a channel the config file itself declares, silent (final review M3)', function () {
    $file = require config_path('logging.php');
    expect($file['channels']['deprecations']['handler'] ?? null)->toBe(NullHandler::class);
    $logged = [];
    Event::listen(MessageLogged::class, function (MessageLogged $e) use (&$logged) {
        $logged[] = $e->level.' '.$e->message;
    });
    // An Octane sandbox's config holds only what the files declare.
    config(['logging.channels' => $file['channels']]);
    app('log')->forgetChannel('deprecations');
    @trigger_error('TCPDF is deprecated', E_USER_DEPRECATED);
    app(HandleExceptions::class)->handleError(E_USER_DEPRECATED, 'TCPDF is deprecated', __FILE__, __LINE__);
    expect(array_filter($logged, fn ($l) => str_starts_with($l, 'emergency')))->toBe([]);
});
