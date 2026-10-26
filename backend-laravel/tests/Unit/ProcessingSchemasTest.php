<?php

/*
 * ProcessingRequest (packages/validation/src/processing.ts) with Express's wire mass check, and the one deliberate
 * difference from Zod's noDuplicate: valid uuids in another letter case are the same input (step-1 duplicate) — Express
 * answers 500 there; strings that are not uuids compare raw, so their 400 bodies match Express's. Output products may
 * repeat. The BR-04 and BR-02 paths never touch a float (a token guard, T8 review M3).
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

/**
 * The PHP tokens of $file (optionally the slice between two markers) without comments and string literals, as
 * [token name or the character, text].
 *
 * @return list<array{0: string, 1: string}>
 */
function codeTokens(string $file, ?string $from = null, ?string $to = null): array
{
    $src = (string) file_get_contents(base_path($file));
    if ($from !== null && $to !== null) {
        $src = '<?php '.explode($to, explode($from, $src, 2)[1], 2)[0];
    }
    $out = [];
    foreach (token_get_all($src) as $t) {
        $name = is_array($t) ? token_name($t[0]) : $t;
        if (in_array($name, ['T_COMMENT', 'T_DOC_COMMENT', 'T_WHITESPACE', 'T_CONSTANT_ENCAPSED_STRING', 'T_ENCAPSED_AND_WHITESPACE'], true)) {
            continue;
        }
        $out[] = [$name, is_array($t) ? $t[1] : $t];
    }

    return $out;
}

it('no float on the processing / mass balance / lab result path (T8 review M3)', function (string $file, ?string $from, ?string $to, bool $noArithmetic) {
    $bad = [];
    $prev = '';
    foreach (codeTokens($file, $from, $to) as [$name, $text]) {
        // `(real)` no longer compiles on PHP 8, but is refused all the same.
        if ($name === 'T_STRING' && strtolower($text) === 'real' && $prev === '(') {
            $bad[] = '(real)';
        }
        $prev = $name;
        // (float), (double): T_DOUBLE_CAST; float literals; the float functions.
        if ($name === 'T_DOUBLE_CAST' || $name === 'T_DNUMBER'
            || ($name === 'T_STRING' && in_array(strtolower($text), ['floatval', 'doubleval', 'round', 'floor', 'ceil', 'intdiv', 'fmod', 'fdiv', 'pow', 'sqrt'], true))) {
            $bad[] = $text;
        }
        // Plain / and * (and **, /=, *=, **=) on the mass path: bcmath only there.
        if ($noArithmetic && in_array($name, ['/', '*', 'T_POW', 'T_DIV_EQUAL', 'T_MUL_EQUAL', 'T_POW_EQUAL'], true)) {
            $bad[] = $text;
        }
    }
    expect($bad)->toBe([]);
})->with([
    ['app/Actions/Processing/ProcessBatches.php', null, null, true],
    ['app/Domain/Rules.php', 'function checkMassBalance', 'function canUseAsInput', true],
    ['app/Domain/Rules.php', 'function concludeLabTest', 'function requiresLabTest', true],
    ['app/Domain/Decimal.php', null, null, true],
    // The lab: BR-02 comparisons through Decimal::compare (the list's paging arithmetic is integer).
    ['app/Actions/Lab/LabActions.php', null, null, false],
    ['app/Actions/Lab/LabView.php', null, null, true],
    ['app/Actions/Recalls/Engine.php', null, null, true],
]);

it('the float guard sees what it must refuse', function () {
    $file = 'storage/framework/float-guard-probe.php';
    file_put_contents(base_path($file), '<?php $a = (double) $x; $b = $g * $keep / 10000; $c = 1.5; $d = round($e);');
    try {
        $names = array_column(codeTokens($file), 0);
        expect($names)->toContain('T_DOUBLE_CAST', 'T_DNUMBER', '*', '/');
    } finally {
        unlink(base_path($file));
    }
});
