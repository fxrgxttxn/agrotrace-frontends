<?php

/*
 * FieldInput (GeoJSON Polygon) and TreatmentInput against the shared Zod schemas: tests/Fixtures/zod/field-input.json
 * holds bodies and what packages/validation (Zod 3) + Express's parseFieldInput answer for them (generated with tsx in
 * the tools container). Pins D12: an empty ring is minItems (never a 500), an open ring is reported at
 * `errors.geometry`, other geometry errors keep their paths; tuple semantics (fewer items abort, more are dirty).
 */

use App\Http\Problem\Problem;
use App\Http\Validation\Schemas\FieldSchemas;
use App\Support\Json;
use Tests\TestCase;

uses(TestCase::class);

function zodFixture(): array
{
    return json_decode((string) file_get_contents(__DIR__.'/../Fixtures/zod/field-input.json'), true);
}

it('FieldInput answers what Zod answers', function (string $case) {
    $f = zodFixture();
    $expected = $f['out'][$case];
    $body = Json::decode(json_encode($f['cases'][$case]));
    try {
        $got = ['ok' => FieldSchemas::parseField($body)];
    } catch (Problem $p) {
        $got = ['errors' => $p->errors];
    }
    expect(json_decode(Json::encode($got), true))->toBe($expected);
})->with(array_keys(zodFixture()['cases']));

it('TreatmentInput answers what Zod answers', function (string $case, array $body) {
    $expected = zodFixture()['out'][$case];
    $r = FieldSchemas::treatmentInput()->safeParse(Json::decode(json_encode($body)));
    $got = $r['ok'] ? ['ok' => $r['value']] : ['errors' => $r['issues']->fieldErrors()];
    expect(json_decode(Json::encode($got), true))->toBe($expected);
})->with(function () {
    $tb = ['substanceId' => '00000000-0000-4000-8000-000000000000', 'dose' => '1.000', 'doseUnit' => 'л/га', 'appliedAt' => '2026-01-01T10:00:00Z'];

    return [
        'tOk' => ['tOk', $tb],
        'tNoSeconds' => ['tNoSeconds', [...$tb, 'appliedAt' => '2026-01-01T10:00Z']],
        'tNanos' => ['tNanos', [...$tb, 'appliedAt' => '2026-01-01T10:00:00.123456789Z']],
        'tOffset' => ['tOffset', [...$tb, 'appliedAt' => '2026-01-01T10:00:00+03:00']],
        'tFeb30' => ['tFeb30', [...$tb, 'appliedAt' => '2026-02-30T10:00:00Z']],
        'tZeroDose' => ['tZeroDose', [...$tb, 'dose' => '0.000', 'doseUnit' => 'kg']],
    ];
});
