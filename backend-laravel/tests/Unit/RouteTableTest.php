<?php

/*
 * The Laravel route table IS the contract (L10 — in place of §8.3's "generated schema ↔ contract" comparison, which a
 * hand-written route table has no generator for): every operation of contracts/openapi.yaml has exactly one route,
 * named by its operationId, with the contract's method and path; no other named route exists. The only routes outside
 * the contract are Swagger UI's (unnamed, GET /api/v1/docs…), as in Express.
 */

use App\Contract\Contract;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

uses(TestCase::class);

it('has one route per contract operation: method, path and name = operationId (92 operations)', function () {
    $contract = app(Contract::class);
    $expected = [];
    foreach ($contract->operationIds() as $id) {
        $op = $contract->operation($id);
        $expected[$id] = $op['method'].' api/v1'.$op['path'];
    }
    $actual = [];
    $unnamed = [];
    foreach (Route::getRoutes()->getRoutes() as $route) {
        $methods = array_values(array_diff($route->methods(), ['HEAD']));
        $line = implode('|', $methods).' '.$route->uri();
        if ($route->getName() === null) {
            $unnamed[] = $line;

            continue;
        }
        expect($actual)->not->toHaveKey($route->getName());
        $actual[$route->getName()] = $line;
    }
    ksort($expected);
    ksort($actual);

    expect(count($expected))->toBe(92);
    expect($actual)->toBe($expected);
    sort($unnamed);
    expect($unnamed)->toBe([
        'GET api/v1/docs',
        'GET api/v1/docs/init.js',
        'GET api/v1/docs/openapi.json',
        'GET api/v1/docs/{asset}',
    ]);
});

it('every operation route carries the contract guard of its own operation', function () {
    foreach (Route::getRoutes()->getRoutes() as $route) {
        $name = $route->getName();
        if ($name === null || in_array($name, ['getHealthLive', 'getHealthReady'], true)) {
            continue;
        }
        expect($route->middleware())->toContain("operation:{$name}");
    }
});
