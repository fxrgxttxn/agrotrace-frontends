<?php

/*
 * The Idempotency-Key middleware (R48, R53; Express http/idempotency.ts) on the in-memory store: the key pattern, the
 * fingerprint (raw bytes, raw path, no query), 2xx stored and replayed exactly once more without running the
 * operation, 4xx/5xx and crashes released, REUSED, IN_PROGRESS + Retry-After, a key expired between SET NX and GET
 * claimed again, and a client that goes away settles nothing (the pending mark stays to its TTL).
 */

use App\Http\Idempotency\IdemStore;
use App\Http\Middleware\Idempotency;
use App\Http\Middleware\JsonBody;
use App\Http\Problem\Problem;
use App\Http\Responses;
use App\Octane\EndOfRequest;
use App\Security\Principal;
use App\Support\RequestContext;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Tests\Support\MemoryIdemStore;
use Tests\TestCase;

uses(TestCase::class);

const IDEM_USER = '11111111-1111-4111-8111-111111111111';

beforeEach(function () {
    $this->store = new MemoryIdemStore;
    $this->app->instance(IdemStore::class, $this->store);
    app(RequestContext::class)->setPrincipal(new Principal(IDEM_USER, '22222222-2222-4222-8222-222222222222', ['FARMER'], false));
    $this->runs = 0;
});

function idemRequest(?string $key, string $raw = '{"a":1}', string $uri = '/api/v1/waybills?x=1', string $method = 'POST'): Request
{
    $r = Request::create('/api/v1/waybills', $method, [], [], [], [], $raw);
    $r->server->set('REQUEST_URI', $uri);
    if ($key !== null) {
        $r->headers->set('Idempotency-Key', $key);
    }
    $r->attributes->set(JsonBody::ATTR_RAW, $raw);

    return $r;
}

function idemRun(Request $r, Closure $next): Response
{
    return app(Idempotency::class)->handle($r, $next);
}

function idemProblem(Closure $fn): Problem
{
    try {
        $fn();
    } catch (Problem $p) {
        return $p;
    }
    throw new RuntimeException('no problem thrown');
}

it('the key must match ^[A-Za-z0-9_-]{8,128}$: else 400 INVALID_IDEMPOTENCY_KEY before anything is stored', function (?string $key) {
    $p = idemProblem(fn () => idemRun(idemRequest($key), fn () => Responses::json([])));
    expect($p->status)->toBe(400);
    expect($p->problemCode->value)->toBe('INVALID_IDEMPOTENCY_KEY');
    expect($this->store->calls)->toBe([]);
})->with([null, '', 'short', str_repeat('a', 129), "abcdefgh\n", 'abc defgh', 'абвгдежз']);

it('fingerprint: sha256 of "{METHOD} {raw path}\n" + the raw body bytes, the query string ignored', function () {
    $fp = Idempotency::fingerprint(idemRequest('k', ' {"a": 1} ', '/api/v1/waybills/ABC/send?q=1'));
    expect($fp)->toBe(hash('sha256', "POST /api/v1/waybills/ABC/send\n {\"a\": 1} "));
    $none = Request::create('/api/v1/x', 'POST');
    $none->server->set('REQUEST_URI', '/api/v1/x');
    expect(Idempotency::fingerprint($none))->toBe(hash('sha256', "POST /api/v1/x\n"));
});

it('a 2xx is stored (decoded body, objects kept) and replayed exactly once more without running the operation', function () {
    $next = function () {
        $this->runs++;

        return Responses::json(['id' => 'w1', 'meta' => new stdClass, 'items' => []], 201);
    };
    $first = idemRun(idemRequest('key-0001'), $next);
    expect($first->getStatusCode())->toBe(201);
    expect($first->headers->has('Idempotent-Replayed'))->toBeFalse();
    $key = 'idem:'.IDEM_USER.':key-0001';
    expect(json_decode($this->store->records[$key], true))->toMatchArray(['state' => 'done', 'status' => 201]);
    expect($this->store->records[$key])->toContain('"body":{"id":"w1","meta":{},"items":[]}');

    $again = idemRun(idemRequest('key-0001'), $next);
    expect($this->runs)->toBe(1);
    expect($again->getStatusCode())->toBe(201);
    expect($again->headers->get('Idempotent-Replayed'))->toBe('true');
    expect($again->headers->get('Content-Type'))->toBe('application/json; charset=utf-8');
    expect($again->getContent())->toBe('{"id":"w1","meta":{},"items":[]}');
});

it('a 4xx or 5xx answer of the owner releases the key: the same request executes again', function (int $status) {
    $next = function () use ($status) {
        $this->runs++;

        return Responses::json(['code' => 'X'], $this->runs === 1 ? $status : 200);
    };
    expect(idemRun(idemRequest('key-0002'), $next)->getStatusCode())->toBe($status);
    expect($this->store->records)->toBe([]);
    expect(idemRun(idemRequest('key-0002'), $next)->getStatusCode())->toBe(200);
    expect($this->runs)->toBe(2);
})->with([400, 409, 422, 500, 503]);

it('a crash of the owner (an exception out of the handler) releases the key and propagates', function () {
    expect(fn () => idemRun(idemRequest('key-0003'), fn () => throw new LogicException('boom')))->toThrow(LogicException::class);
    expect($this->store->records)->toBe([]);
    expect($this->store->calls)->toContain('release idem:'.IDEM_USER.':key-0003');
});

it('the same key with another request → 409 IDEMPOTENCY_KEY_REUSED; the record is not touched', function () {
    idemRun(idemRequest('key-0004'), fn () => Responses::json(['ok' => true], 201));
    $before = $this->store->records;
    foreach ([idemRequest('key-0004', '{"a":2}'), idemRequest('key-0004', '{"a":1}', '/api/v1/batches/x/documents/vsd/retry')] as $r) {
        $p = idemProblem(fn () => idemRun($r, fn () => Responses::json([])));
        expect([$p->status, $p->problemCode->value])->toBe([409, 'IDEMPOTENCY_KEY_REUSED']);
    }
    expect($this->store->records)->toBe($before);
});

it('a pending record → 409 IN_PROGRESS + Retry-After: 1; a client that goes away settles nothing (pending to its TTL)', function () {
    $key = 'idem:'.IDEM_USER.':key-0005';
    $inner = null;
    $next = function () use ($key, &$inner) {
        $this->runs++;
        // While the owner runs: a retry is IN_PROGRESS, and the end-of-request hooks (what runs when a client is
        // gone and the request is torn down) do not free the key.
        $inner = idemProblem(fn () => idemRun(idemRequest('key-0005'), fn () => Responses::json([])));
        EndOfRequest::finish(app());
        expect($this->store->state($key))->toBe('pending');

        return Responses::json(['ok' => true]);
    };
    idemRun(idemRequest('key-0005'), $next);
    expect([$inner->status, $inner->problemCode->value, $inner->headers])->toBe([409, 'IDEMPOTENCY_KEY_IN_PROGRESS', ['Retry-After' => '1']]);
    expect($this->store->state($key))->toBe('done');

    // An owner that never answered: its pending mark stays, every retry is IN_PROGRESS, nothing releases it.
    $this->store->records['idem:'.IDEM_USER.':key-0006'] = json_encode(['fingerprint' => Idempotency::fingerprint(idemRequest('key-0006')), 'state' => 'pending']);
    $p = idemProblem(fn () => idemRun(idemRequest('key-0006'), fn () => Responses::json([])));
    expect($p->problemCode->value)->toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    expect($this->store->state('idem:'.IDEM_USER.':key-0006'))->toBe('pending');
    expect($this->runs)->toBe(1);
});

it('a key that expired between SET NX and GET is claimed once more', function () {
    $this->store->records['idem:'.IDEM_USER.':key-0007'] = json_encode(['fingerprint' => 'old', 'state' => 'pending']);
    $this->store->expireAfterFailedClaim = true;
    $res = idemRun(idemRequest('key-0007'), fn () => Responses::json(['ok' => true]));
    expect($res->getStatusCode())->toBe(200);
    expect($this->store->state('idem:'.IDEM_USER.':key-0007'))->toBe('done');
});

it('a done record of any backend replays its body; without a status as 200; a malformed record is no record', function () {
    $fp = Idempotency::fingerprint(idemRequest('key-0008'));
    $this->store->records['idem:'.IDEM_USER.':key-0008'] = json_encode(['fingerprint' => $fp, 'state' => 'done', 'body' => ['note' => 'stored elsewhere']]);
    $res = idemRun(idemRequest('key-0008'), fn () => throw new LogicException('must not run'));
    expect([$res->getStatusCode(), $res->getContent()])->toBe([200, '{"note":"stored elsewhere"}']);

    $this->store->records['idem:'.IDEM_USER.':key-0009'] = '[1,2]';
    $this->store->expireAfterFailedClaim = true;
    expect(idemRun(idemRequest('key-0009'), fn () => Responses::json(['ran' => true]))->getContent())->toBe('{"ran":true}');
});
