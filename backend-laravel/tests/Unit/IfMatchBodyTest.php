<?php

/*
 * If-Match (components/parameters.yaml#/IfMatch, P35, P36) and Body::parse (the wire mass format, merged parameter
 * errors, deferred duplicates) — Express http/if-match.ts and http/body.ts.
 */

use App\Http\IfMatch;
use App\Http\Problem\Problem;
use App\Http\Validation\Body;
use App\Http\Validation\Schemas\BatchSchemas;
use Illuminate\Http\Request;
use Tests\TestCase;

uses(TestCase::class);

function ifMatchOf(?string $v): Request
{
    $r = Request::create('/');
    if ($v !== null) {
        $r->headers->set('If-Match', $v);
    }

    return $r;
}

it('reads If-Match: required, a bare 1–10 digit integer, at least 1', function (?string $raw, ?int $version, ?string $key) {
    $errors = [];
    expect(IfMatch::read(ifMatchOf($raw), $errors))->toBe($version);
    expect($errors)->toBe($key === null ? [] : ['If-Match' => [$key]]);
})->with([
    [null, null, 'validation.required'], ['', null, 'validation.required'], ['3', 3, null], ['W/"3"', null, 'validation.type'],
    ['"3"', null, 'validation.type'], ['0', null, 'validation.min'], ['00', null, 'validation.min'], ['-1', null, 'validation.type'],
    ['12345678901', null, 'validation.type'], ['3 ', null, 'validation.type'], ['1.0', null, 'validation.type'],
]);

it('compares If-Match with the locked row: 409 VERSION_CONFLICT {currentVersion}', function () {
    IfMatch::check(4, 4);
    try {
        IfMatch::check(3, 4);
        $this->fail('no conflict');
    } catch (Problem $p) {
        expect($p->status)->toBe(409);
        expect($p->params)->toBe(['currentVersion' => 4]);
    }
});

it('a mass is exactly three decimals on the wire (mass.format), zero is positive-checked, extra errors merge', function () {
    $base = ['fieldId' => '00000000-0000-4000-8000-000000000001', 'productId' => '00000000-0000-4000-8000-000000000002',
        'harvestedAt' => '2026-10-01T00:00:00Z'];
    $errors = function (array $body, array $extra = []): array {
        try {
            Body::parse(BatchSchemas::batchCreate(), json_decode(json_encode($body)), ['massKg'], $extra);

            return [];
        } catch (Problem $p) {
            return $p->errors;
        }
    };
    expect($errors([...$base, 'massKg' => '12']))->toBe(['massKg' => ['validation.mass.format']]);
    expect($errors([...$base, 'massKg' => '12.5']))->toBe(['massKg' => ['validation.mass.format']]);
    expect($errors([...$base, 'massKg' => '0.000']))->toBe(['massKg' => ['validation.positive']]);
    expect($errors([...$base, 'massKg' => '1.000']))->toBe([]);
    expect($errors([...$base, 'massKg' => '1.000'], ['If-Match' => ['validation.required']]))->toBe(['If-Match' => ['validation.required']]);
    expect(BatchSchemas::parseCreate(json_decode(json_encode([...$base, 'massKg' => '7.250']))))->toMatchArray(['massKg' => '7.250']);
});
