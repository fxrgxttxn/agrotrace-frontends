<?php

/*
 * ContractGate (P3, P8, I1, I2): strict, case-sensitive matching of the RAW request path against the contract —
 * `//`, a malformed `%`-escape, another case and a trailing `/` are not contract paths (404); an undeclared method,
 * OPTIONS included, is 405 with the contract's Allow; HEAD is GET; a declared but unimplemented operation is 404.
 */

use App\Contract\Contract;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

uses(TestCase::class);

function problemOf($res): array
{
    expect($res->headers->get('Content-Type'))->toStartWith('application/problem+json');
    expect($res->headers->get('X-Backend'))->toBe('laravel');

    return json_decode($res->getContent(), true);
}

it('lets a contract path with a declared method through (GET /health/live → 200)', function () {
    $res = $this->raw('GET', '/api/v1/health/live');
    $res->assertStatus(200);
    expect($res->getContent())->toBe('{"status":"ok"}');
    expect($res->headers->get('X-Backend'))->toBe('laravel');
});

it('answers 404 for an empty segment anywhere, before or after /api/v1', function (string $raw, string $method) {
    $res = $this->raw($method, $raw);
    $res->assertStatus(404);
    expect(problemOf($res))->toMatchArray(['code' => 'NOT_FOUND', 'type' => '/problems/not-found', 'status' => 404]);
})->with([
    '//api/v1/health/live', '/api/v1//health/live', '/api/v1/health//live', '/api/v1/health/live//',
    '/api/v1///health/live', '/api/v1//docs',
])->with(['GET', 'OPTIONS', 'DELETE']);

it('answers 404 for another case and a trailing slash (P8)', function (string $raw) {
    $res = $this->raw('GET', $raw);
    $res->assertStatus(404);
    expect(problemOf($res)['code'])->toBe('NOT_FOUND');
})->with(['/api/v1/Health/live', '/api/v1/health/LIVE', '/api/v1/health/live/', '/api/v1/health/ready/', '/API/v1/health/live']);

it('answers 404, never 500, for a malformed percent-escape (fix round 1 I2)', function (string $raw) {
    $res = $this->raw('GET', $raw);
    $res->assertStatus(404);
    expect(problemOf($res)['code'])->toBe('NOT_FOUND');
})->with(['/api/v1/docs/%zz', '/api/v1/docs/%E0%A4%A', '/api/v1/health/%zz', '/api/v1/batches/%zz', '/api/v1/batches/%zz/documents', '/api/v1/batches/%FF']);

it('answers 405 with the contract Allow for an undeclared method, OPTIONS included (P3, I1)', function (string $method, string $raw, string $allow) {
    $res = $this->raw($method, $raw);
    $res->assertStatus(405);
    expect(problemOf($res))->toMatchArray(['code' => 'METHOD_NOT_ALLOWED', 'type' => '/problems/method-not-allowed', 'status' => 405]);
    expect($res->headers->get('Allow'))->toBe($allow);
})->with([
    ['OPTIONS', '/api/v1/health/live', 'GET'],
    ['OPTIONS', '/api/v1/auth/login', 'POST'],
    ['DELETE', '/api/v1/health/live', 'GET'],
    ['PUT', '/api/v1/health/live', 'GET'],
    ['POST', '/api/v1/health/ready', 'GET'],
    ['GET', '/api/v1/auth/login', 'POST'],
    ['PATCH', '/api/v1/batches/8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e', 'GET'],
]);

it('answers OPTIONS on a path outside the contract with 404, not with a CORS answer', function (string $raw) {
    $res = $this->raw('OPTIONS', $raw, ['Origin' => 'http://evil.example', 'Access-Control-Request-Method' => 'GET']);
    $res->assertStatus(404);
    expect($res->headers->has('Access-Control-Allow-Origin'))->toBeFalse();
})->with(['/api/v1/docs', '/api/v1/no/such/path']);

it('treats HEAD as GET', function () {
    $this->raw('HEAD', '/api/v1/health/live')->assertStatus(200);
    $res = $this->raw('HEAD', '/api/v1/auth/login');
    $res->assertStatus(405);
    expect($res->headers->get('Allow'))->toBe('POST');
});

it('answers 404 for a declared operation that has no route yet', function () {
    $res = $this->raw('GET', '/api/v1/fields');
    $res->assertStatus(404);
    expect(problemOf($res)['code'])->toBe('NOT_FOUND');
});

it('answers 404 for paths outside the contract and outside /api/v1', function (string $method, string $raw) {
    $res = $this->raw($method, $raw);
    $res->assertStatus(404);
    expect(problemOf($res)['code'])->toBe('NOT_FOUND');
})->with([
    ['GET', '/api/v1/no/such/path'], ['POST', '/api/v1/no/such/path'], ['GET', '/api/v1/health'],
    ['GET', '/api/v1/health/live/extra'], ['GET', '/nope'], ['GET', '/'], ['POST', '/api/v1/docs'],
    ['GET', '/metrics'], ['GET', '/api/v1/docs/a/b'],
]);

it('ignores the method override of Symfony (X-HTTP-Method-Override, _method)', function () {
    $res = $this->raw('POST', '/api/v1/health/live?_method=GET', ['X-HTTP-Method-Override' => 'GET']);
    $res->assertStatus(405);
    expect($res->headers->get('Allow'))->toBe('GET');
});

it('matches literal segments before parameters and decodes parameters', function () {
    $c = app(Contract::class);
    expect($c->match('GET', '/api/v1/users/me'))->toBeNull(); // no such template: `me` is no literal here
    $m = $c->match('GET', '/api/v1/batches/8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e');
    expect($m->operationId)->toBe('getBatch');
    expect($m->template)->toBe('/batches/{id}');
    expect($m->params)->toBe(['id' => '8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e']);
    expect($c->match('GET', '/api/v1/batches/a%20b')->params)->toBe(['id' => 'a b']);
    expect($c->methodsFor('/api/v1/nope'))->toBeNull();
    expect($c->methodsFor('/api/v1/health/live'))->toBe(['GET']);
    expect($c->operation('getHealthLive')['method'])->toBe('GET');
});

it('prefers a literal template over a parameter one at the same position, whatever the order of `paths`', function () {
    $c = new Contract(json_encode(['openapi' => '3.1.0', 'paths' => [
        '/a/{x}' => ['get' => ['operationId' => 'getAnyA'], 'delete' => ['operationId' => 'deleteA']],
        '/a/b' => ['get' => ['operationId' => 'getAB'], 'post' => ['operationId' => 'postAB']],
    ]]));
    expect($c->match('GET', '/api/v1/a/b')->operationId)->toBe('getAB');
    expect($c->match('GET', '/api/v1/a/c')->operationId)->toBe('getAnyA');
    expect($c->match('DELETE', '/api/v1/a/b')->operationId)->toBe('deleteA');
    // Allow: the union in document order, as Express's method guard.
    expect($c->methodsFor('/api/v1/a/b'))->toBe(['GET', 'DELETE', 'POST']);
    expect($c->match('GET', '/api/v1/a/%zz'))->toBeNull();
    expect($c->methodsFor('/api/v1/a/%zz'))->toBe(['GET', 'DELETE']);
});

it('dispatches the operation ContractGate matched on the raw path, not Laravel\'s decoded match (review I1)', function () {
    // Registered so that Laravel's own matching (decoded path, registration order) would pick the wrong one.
    Route::get('/api/v1/fields/{id}/treatments', fn (string $id) => response()->json(['op' => 'listFieldTreatments', 'id' => $id]))
        ->name('listFieldTreatments');
    Route::get('/api/v1/fields/{id}', fn (string $id) => response()->json(['op' => 'getField', 'id' => $id]))
        ->name('getField');
    Route::post('/api/v1/dictionaries/{name}/import', fn () => response()->json(['op' => 'importDictionary']))
        ->name('importDictionary');
    Route::put('/api/v1/dictionaries/{name}/{id}', fn (string $name, string $id) => response()->json(['op' => 'updateDictionaryEntry', 'id' => $id]))
        ->name('updateDictionaryEntry');

    // `%2F` is inside one segment: Express (raw-path routing) takes getField with id "<id>/treatments".
    $res = $this->raw('GET', '/api/v1/fields/abc%2Ftreatments');
    $res->assertStatus(200);
    expect($res->json())->toBe(['op' => 'getField', 'id' => 'abc/treatments']);
    expect($this->raw('GET', '/api/v1/fields/abc/treatments')->json())->toBe(['op' => 'listFieldTreatments', 'id' => 'abc']);

    // A percent-encoded literal is not the literal: `imp%6Frt` is an {id}, so POST is not declared there.
    $res = $this->raw('POST', '/api/v1/dictionaries/products/imp%6Frt');
    $res->assertStatus(405);
    expect($res->headers->get('Allow'))->toBe('PUT, DELETE');
    expect($this->raw('PUT', '/api/v1/dictionaries/products/imp%6Frt')->json())
        ->toBe(['op' => 'updateDictionaryEntry', 'id' => 'import']);
    expect($this->raw('POST', '/api/v1/dictionaries/products/import')->json())->toBe(['op' => 'importDictionary']);
});

it('answers 404 for a declared operation whose route has another name (no fallback to Laravel matching)', function () {
    Route::get('/api/v1/fields', fn () => 'wrong')->name('notListFields');
    $this->raw('GET', '/api/v1/fields')->assertStatus(404);
});

it('answers a malformed %-escape as Express does: method check first, then 404 (review I2)', function () {
    // The HAProxy front forwards the path re-encoded (`%` → `%25`) with the original in X-Agrotrace-Raw-Path.
    $front = fn (string $method, string $raw) => $this->raw($method, str_replace('%', '%25', $raw), ['X-Agrotrace-Raw-Path' => $raw]);
    foreach (['POST', 'OPTIONS', 'DELETE'] as $method) {
        $res = $front($method, '/api/v1/batches/%zz');
        $res->assertStatus(405);
        expect($res->headers->get('Allow'))->toBe('GET');
    }
    $front('GET', '/api/v1/batches/%zz')->assertStatus(404);
    $front('HEAD', '/api/v1/batches/%zz/documents')->assertStatus(404);
    $front('POST', '/api/v1/no/%zz')->assertStatus(404);
    $front('OPTIONS', '/api/v1/no/%zz')->assertStatus(404);
    $front('GET', '/api/v1/docs/%zz')->assertStatus(404);
    $front('GET', '/api/v1/health/%E0%A4%A')->assertStatus(404);
});

it('sends no Cache-Control unless the operation sets one (review M2)', function () {
    expect($this->raw('GET', '/api/v1/health/live')->headers->has('Cache-Control'))->toBeFalse();
    expect($this->raw('GET', '/api/v1/no/such')->headers->has('Cache-Control'))->toBeFalse();
    expect($this->raw('GET', '/api/v1/docs/init.js')->headers->get('Cache-Control'))->toContain('no-cache');
});
