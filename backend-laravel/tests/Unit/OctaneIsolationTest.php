<?php

/*
 * Review Focus 4: under Octane one application serves many requests. Two requests in a row through a real
 * Laravel\Octane\Worker (the same sandboxing FrankenPHP's worker does) must not share the request id, the principal,
 * the collected event ids or the after-response callbacks — and the DB slot the first took must be free again
 * (DB_SLOTS=1 here: the second request could not connect otherwise).
 */

use App\Infrastructure\Db\BackendUnavailable;
use App\Infrastructure\Db\DbSlots;
use App\Security\Principal;
use App\Support\RequestContext;
use Illuminate\Container\Container;
use Illuminate\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Facade;
use Laravel\Octane\ApplicationFactory;
use Laravel\Octane\Contracts\Client;
use Laravel\Octane\OctaneResponse;
use Laravel\Octane\RequestContext as OctaneContext;
use Laravel\Octane\Worker;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

final class CapturingClient implements Client
{
    /** @var list<Response> */
    public array $responses = [];

    public function marshalRequest(OctaneContext $context): array
    {
        throw new LogicException('not used');
    }

    public function respond(OctaneContext $context, OctaneResponse $response): void
    {
        $this->responses[] = $response->response;
    }

    public function error(Throwable $e, Application $app, Request $request, OctaneContext $context): void
    {
        throw $e;
    }
}

function setEnv(string $k, ?string $v): void
{
    if ($v === null) {
        putenv($k);
        unset($_ENV[$k], $_SERVER[$k]);
    } else {
        putenv("{$k}={$v}");
        $_ENV[$k] = $_SERVER[$k] = $v;
    }
}

it('gives every request a fresh context and frees the DB slot at the end of the request', function () {
    $this->requireDatabase();
    $dir = sys_get_temp_dir().'/at-slots-'.bin2hex(random_bytes(4));
    $env = ['DB_SLOTS_ENABLED' => 'true', 'DB_SLOTS' => '1', 'DB_SLOTS_DIR' => $dir,
        'APP_DATABASE_URL' => getenv('TEST_APP_DATABASE_URL')];
    $saved = [];
    foreach ($env as $k => $v) {
        $saved[$k] = getenv($k) === false ? null : getenv($k);
        setEnv($k, $v);
    }
    $testApp = $this->app;
    $after = [];
    try {
        $client = new CapturingClient;
        $worker = new Worker(new ApplicationFactory(base_path()), $client);
        $worker->boot();
        $app = $worker->application();
        $app->make('router')->get('/api/v1/me', function () use (&$after) {
            $ctx = app(RequestContext::class);
            $seen = [
                'requestId' => $ctx->requestId(),
                'principal' => $ctx->principal()?->userId,
                'eventIds' => $ctx->eventIds(),
                'afterResponse' => count($ctx->takeAfterResponse()),
            ];
            $ctx->setPrincipal(new Principal('11111111-1111-4111-8111-111111111111', 'org', ['FARMER'], true));
            $ctx->addEventId('event-of-'.$ctx->requestId());
            $ctx->afterResponse(function () use (&$after, $ctx) {
                $after[] = $ctx->requestId();
            });
            $seen['db'] = DB::selectOne('SELECT 1 AS one')->one;
            $seen['slotHeld'] = app(DbSlots::class)->held();

            return response()->json($seen);
        });

        $send = function (string $id) use ($worker, $client) {
            $r = Request::create('/api/v1/me', 'GET', server: ['HTTP_X_REQUEST_ID' => $id, 'REMOTE_ADDR' => '10.0.0.9']);
            $worker->handle($r, new OctaneContext);

            return json_decode(end($client->responses)->getContent(), true);
        };

        $first = $send('req-one');
        expect($first)->toBe(['requestId' => 'req-one', 'principal' => null, 'eventIds' => [], 'afterResponse' => 0, 'db' => 1, 'slotHeld' => true]);
        expect($app->make(DbSlots::class)->held())->toBeFalse();

        $second = $send('req-two');
        expect($second)->toBe(['requestId' => 'req-two', 'principal' => null, 'eventIds' => [], 'afterResponse' => 0, 'db' => 1, 'slotHeld' => true]);
        expect($after)->toBe(['req-one', 'req-two']);
        expect($app->make(DbSlots::class)->held())->toBeFalse();

        // The slot file is free for anyone else now.
        $h = fopen("{$dir}/slot-0", 'c');
        expect(flock($h, LOCK_EX | LOCK_NB))->toBeTrue();
        fclose($h);
        $worker->terminate();
    } finally {
        foreach ($saved as $k => $v) {
            setEnv($k, $v);
        }
        Container::setInstance($testApp);
        Facade::clearResolvedInstances();
        Facade::setFacadeApplication($testApp);
        @array_map('unlink', glob("{$dir}/*") ?: []);
        @rmdir($dir);
    }
});

it('frees the slot when the connection fails, and waits at most the timeout for one', function () {
    $dir = sys_get_temp_dir().'/at-slots-'.bin2hex(random_bytes(4));
    $a = new DbSlots(1, $dir, true);
    $b = new DbSlots(1, $dir, true);
    $a->acquire(1.0);
    $a->acquire(1.0); // held: a no-op
    $t = microtime(true);
    expect(fn () => $b->acquire(0.3))->toThrow(BackendUnavailable::class);
    expect(microtime(true) - $t)->toBeLessThan(1.0);
    $a->release();
    $b->acquire(0.3);
    expect($b->held())->toBeTrue();
    $b->release();
    expect((new DbSlots(1, $dir, false))->held())->toBeFalse();
    @array_map('unlink', glob("{$dir}/*") ?: []);
    @rmdir($dir);
});
