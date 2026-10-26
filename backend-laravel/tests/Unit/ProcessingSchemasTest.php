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

/**
 * The float guard (T8 review M3, T9 review M3): what it refuses in $tokens, in order.
 * - (float), (double) — T_DOUBLE_CAST — and `(real)`; float literals (T_DNUMBER);
 * - the float functions, called plainly or fully qualified (`round(`, `\round(`);
 * - `+`, `-`, `+=`, `-=`, `++`, `--` unless one side is an integer literal (`$version + 1`, `$page - 1`): PHP turns a
 *   decimal string into a float under them (`'0.1' + $m`) — decimals go through bcmath (Decimal) only;
 * - with $noMulDiv: `/`, `*`, `**`, `/=`, `*=`, `**=` (the mass path is bcmath only).
 *
 * @param  list<array{0: string, 1: string}>  $tokens
 * @return list<string>
 */
function floatGuard(array $tokens, bool $noMulDiv): array
{
    $floatFns = ['floatval', 'doubleval', 'round', 'floor', 'ceil', 'intdiv', 'fmod', 'fdiv', 'pow', 'sqrt'];
    $bad = [];
    foreach ($tokens as $i => [$name, $text]) {
        $prev = $tokens[$i - 1][0] ?? '';
        $next = $tokens[$i + 1][0] ?? '';
        // `(real)` no longer compiles on PHP 8, but is refused all the same.
        if ($name === 'T_STRING' && strtolower($text) === 'real' && $prev === '(') {
            $bad[] = '(real)';
        }
        if ($name === 'T_DOUBLE_CAST' || $name === 'T_DNUMBER') {
            $bad[] = $text;
        }
        if (in_array($name, ['T_STRING', 'T_NAME_FULLY_QUALIFIED'], true) && in_array(strtolower(ltrim($text, '\\')), $floatFns, true)
            && ! in_array($prev, ['T_OBJECT_OPERATOR', 'T_NULLSAFE_OBJECT_OPERATOR', 'T_DOUBLE_COLON', 'T_FUNCTION'], true)) {
            $bad[] = $text;
        }
        if (in_array($name, ['+', '-', 'T_PLUS_EQUAL', 'T_MINUS_EQUAL', 'T_INC', 'T_DEC'], true)
            && $prev !== 'T_LNUMBER' && $next !== 'T_LNUMBER') {
            $bad[] = $text;
        }
        if ($noMulDiv && in_array($name, ['/', '*', 'T_POW', 'T_DIV_EQUAL', 'T_MUL_EQUAL', 'T_POW_EQUAL'], true)) {
            $bad[] = $text;
        }
    }

    return $bad;
}

it('no float on the processing / mass balance / lab result / recall / rating paths (T8 review M3, T9 review M3)', function (string $file, ?string $from, ?string $to, bool $noMulDiv) {
    expect(floatGuard(codeTokens($file, $from, $to), $noMulDiv))->toBe([]);
})->with([
    ['app/Actions/Processing/ProcessBatches.php', null, null, true],
    ['app/Domain/Rules.php', 'function checkMassBalance', 'function canUseAsInput', true],
    ['app/Domain/Rules.php', 'function concludeLabTest', 'function requiresLabTest', true],
    ['app/Domain/Decimal.php', null, null, true],
    // The lab: BR-02 comparisons through Decimal::compare (the list's paging arithmetic is integer).
    ['app/Actions/Lab/LabActions.php', null, null, false],
    ['app/Actions/Lab/LabView.php', null, null, true],
    ['app/Actions/Recalls/Engine.php', null, null, true],
    // Task 10: the recall views (massUsedKg as stored), the operations (integer paging), the overdue job, the rating.
    ['app/Actions/Recalls/RecallView.php', null, null, true],
    ['app/Actions/Recalls/RecallsActions.php', null, null, false],
    ['app/Scheduler/Jobs/RecallTaskOverdue.php', null, null, true],
    ['app/Actions/Rating/Rating.php', null, null, true],
]);

it('the float guard refuses every form it must, and only those (T9 review M3)', function () {
    $file = 'storage/framework/float-guard-probe-'.bin2hex(random_bytes(4)).'.php';
    file_put_contents(base_path($file), <<<'PHP'
        <?php
        $a = (double) $x; $a2 = (float) $x;
        $b = $g * $keep / 10000; $b2 = $g ** 2; $b3 /= $d; $b4 *= $d; $b5 **= 2;
        $c = 1.5; $c2 = 1e3;
        $d = round($e); $d2 = \round($e); $d3 = \floatval($e); $d4 = floor($e); $d5 = \intdiv($e, 2);
        $f = '0.1' + $m; $f2 = $m - $n; $f3 += $m; $f4 -= $m; $f5++; --$f6;
        // allowed: integer literals beside + and -, a method or static call named like a float function
        $ok = $version + 1; $ok2 = $page - 1; $ok3 = 1 + $n; $ok4 = -1; $ok5 = $o->round($x); $ok6 = Decimal::floor($x);
        PHP);
    try {
        expect(floatGuard(codeTokens($file), true))->toBe([
            '(double)', '(float)',
            '*', '/', '**', '/=', '*=', '**=',
            '1.5', '1e3',
            'round', '\round', '\floatval', 'floor', '\intdiv',
            '+', '-', '+=', '-=', '++', '--',
        ]);
        // Without the mass-path flag, * / ** and their assignments pass; everything else is still refused.
        expect(floatGuard(codeTokens($file), false))->toBe([
            '(double)', '(float)', '1.5', '1e3',
            'round', '\round', '\floatval', 'floor', '\intdiv',
            '+', '-', '+=', '-=', '++', '--',
        ]);
    } finally {
        unlink(base_path($file));
    }
});
