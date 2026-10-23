<?php

/*
 * ProcessingRequest (packages/validation/src/processing.ts) with Express's wire mass check, and the one deliberate
 * difference from Zod's noDuplicate: valid uuids in another letter case are the same input (step-1 duplicate) — Express
 * answers 500 there; strings that are not uuids compare raw, so their 400 bodies match Express's. Output products may
 * repeat. The BR-04 path never touches a float.
 */

use App\Http\Problem\Problem;
use App\Http\Validation\Schemas\ProcessingSchemas;
use App\Support\Json;
use Tests\TestCase;

uses(TestCase::class);

const PROC_ID = '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c';

/** @return array<string, list<string>>|array{ok: mixed} */
function processingParse(array $body): array
{
    try {
        return ['ok' => ProcessingSchemas::parse(Json::decode(json_encode($body)))];
    } catch (Problem $p) {
        return $p->errors ?? [];
    }
}

it('a valid uuid repeated in another letter case is validation.duplicate at the later index', function () {
    expect(processingParse([
        'inputs' => [['batchId' => PROC_ID, 'massUsedKg' => '1.000'], ['batchId' => strtoupper(PROC_ID), 'massUsedKg' => '2.000']],
        'outputs' => [['productId' => PROC_ID, 'massKg' => '1.000']],
    ]))->toBe(['inputs[1].batchId' => ['validation.duplicate']]);
});

it('strings that are not uuids compare raw (Express parity): only validation.uuid', function () {
    expect(processingParse([
        'inputs' => [['batchId' => 'abc', 'massUsedKg' => '1.000'], ['batchId' => 'ABC', 'massUsedKg' => '1.000']],
        'outputs' => [['productId' => PROC_ID, 'massKg' => '1.000']],
    ]))->toBe(['inputs[0].batchId' => ['validation.uuid'], 'inputs[1].batchId' => ['validation.uuid']]);
});

it('output products may repeat; masses keep their wire form', function () {
    $r = processingParse([
        'inputs' => [['batchId' => PROC_ID, 'massUsedKg' => '10.000']],
        'outputs' => [['productId' => PROC_ID, 'massKg' => '1.000'], ['productId' => strtoupper(PROC_ID), 'massKg' => '2.500']],
    ]);
    expect(json_decode(Json::encode($r['ok']), true))->toBe([
        'inputs' => [['batchId' => PROC_ID, 'massUsedKg' => '10.000']],
        'outputs' => [['productId' => PROC_ID, 'massKg' => '1.000'], ['productId' => strtoupper(PROC_ID), 'massKg' => '2.500']],
    ]);
});

it('no float on the processing / mass balance path', function (string $file, ?string $from, ?string $to) {
    $src = (string) file_get_contents(base_path($file));
    if ($from !== null) {
        $src = explode($to, explode($from, $src, 2)[1], 2)[0];
    }
    // Comments are dropped: the doc text "floor(g·…)" names the bcmath integer division.
    $src = (string) preg_replace('~/\*.*?\*/|//[^\n]*~s', '', $src);
    expect(preg_match('/\(float\)|floatval\(|\bround\(|\bfloor\(|\bceil\(|\bintdiv\(|\bfmod\(/', $src))->toBe(0);
})->with([
    ['app/Actions/Processing/ProcessBatches.php', null, null],
    ['app/Domain/Rules.php', 'function checkMassBalance', 'function canUseAsInput'],
    ['app/Domain/Decimal.php', null, null],
]);
