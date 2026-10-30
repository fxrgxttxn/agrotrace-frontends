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
 * The PHP tokens of $file (optionally the slice between two markers) without comments and whitespace, as [token name
 * or the character, text]; a string literal stays as one `T_STR` placeholder (its text dropped), so `'0.1' + 1` is
 * not read as a unary plus.
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
        if (in_array($name, ['T_COMMENT', 'T_DOC_COMMENT', 'T_WHITESPACE'], true)) {
            continue;
        }
        if (in_array($name, ['T_CONSTANT_ENCAPSED_STRING', 'T_ENCAPSED_AND_WHITESPACE'], true)) {
            $out[] = ['T_STR', ''];

            continue;
        }
        $out[] = [$name, is_array($t) ? $t[1] : $t];
    }

    return $out;
}

/** Functions whose result is an integer (an operand of `+`/`-` the guard accepts). */
const INT_FUNCTIONS = ['count', 'strlen', 'mb_strlen', 'strspn', 'strcspn'];

/** Functions that write their arguments by reference: the 0-based index of the first out-parameter. */
const BYREF_FROM_ARG = ['preg_match' => 2, 'preg_match_all' => 2, 'parse_str' => 1, 'exec' => 1, 'sscanf' => 2,
    'settype' => 0, 'str_replace' => 3, 'str_ireplace' => 3, 'preg_replace' => 4, 'preg_replace_callback' => 4,
    'array_push' => 0, 'array_pop' => 0, 'array_shift' => 0, 'sort' => 0, 'usort' => 0];

/**
 * Variables of $tokens known to hold integers: `int`/`?int` typed parameters and properties, and variables assigned
 * an `(int)` cast, a lone integer literal or an INT_FUNCTIONS call — and ONLY such (T11 review M4): one other
 * assignment anywhere in the scanned slice (`$k = $t->massKg`, `$k .= …`, `$k /= …`, a `foreach … as $k` /
 * `=> $k` target, a `[$k, …] =` / `list($k) =` destructuring; and, T13 review M1, every other compound assignment
 * (`*=`, `<<=`, `|=`, …), a reference `&$k`, an out-parameter of BYREF_FROM_ARG) makes the variable not an integer. Names are judged
 * per slice, not per function scope: a name reused for a non-integer elsewhere in the file is refused everywhere.
 *
 * @param  list<array{0: string, 1: string}>  $tokens
 * @return array<string, true>
 */
function intVariables(array $tokens): array
{
    $vars = [];
    $other = [];
    $inForeach = false;
    $brackets = [];
    foreach ($tokens as $i => [$name, $text]) {
        if ($name === 'T_FOREACH') {
            $inForeach = true;
        }
        if ($name === 'T_AS' && $inForeach) {
            // Every variable between `as` and the closing `)` of the foreach is assigned an element or a key.
            for ($j = $i + 1, $depth = 0; isset($tokens[$j]); $j++) {
                $depth += $tokens[$j][0] === '(' ? 1 : ($tokens[$j][0] === ')' ? -1 : 0);
                if ($depth < 0) {
                    break;
                }
                if ($tokens[$j][0] === 'T_VARIABLE') {
                    $other[$tokens[$j][1]] = true;
                }
            }
            $inForeach = false;
        }
        // Destructuring: `[ … ] =` and `list( … ) =` assign every variable inside.
        // A `[` after an operand is an index (`$a[$i] = …` assigns an element), elsewhere an array literal.
        if ($name === '[') {
            $literal = ! in_array($tokens[$i - 1][0] ?? '', ['T_VARIABLE', 'T_STRING', ']', ')', '}'], true);
            $brackets[] = $literal ? $i : null;
        }
        if ($name === 'T_LIST' && ($tokens[$i + 1][0] ?? '') === '(') {
            $listAt = $i;
        }
        $assigned = ($tokens[$i + 1][0] ?? '') === '=';
        $from = null;
        if ($name === ']' && $brackets !== []) {
            $from = array_pop($brackets);
        } elseif ($name === ')' && isset($listAt) && $assigned) {
            $from = $listAt;
            unset($listAt);
        }
        if ($from !== null && $assigned) {
            for ($j = $from + 1; $j < $i; $j++) {
                if ($tokens[$j][0] === 'T_VARIABLE') {
                    $other[$tokens[$j][1]] = true;
                }
            }
        }
        // Out-parameters of the by-reference functions (T13 review M1): every variable from that argument on.
        if ($name === 'T_STRING' && isset(BYREF_FROM_ARG[strtolower($text)]) && ($tokens[$i + 1][0] ?? '') === '(') {
            $arg = 0;
            for ($j = $i + 2, $depth = 0; isset($tokens[$j]); $j++) {
                $t = $tokens[$j][0];
                $depth += in_array($t, ['(', '['], true) ? 1 : (in_array($t, [')', ']'], true) ? -1 : 0);
                if ($depth < 0) {
                    break;
                }
                if ($t === ',' && $depth === 0) {
                    $arg++;
                }
                if ($t === 'T_VARIABLE' && $arg >= BYREF_FROM_ARG[strtolower($text)]) {
                    $other[$tokens[$j][1]] = true;
                }
            }
        }
        if ($name !== 'T_VARIABLE') {
            continue;
        }
        $prev = $tokens[$i - 1] ?? ['', ''];
        if ($prev[0] === 'T_STRING' && strtolower($prev[1]) === 'int') {
            $vars[$text] = true;
        }
        // A reference (`&$k`: `use (&$k)`, `foreach (… as &$k)`, a by-reference parameter, `=& $k`) can be written
        // through anywhere.
        if ($prev[0] === 'T_AMPERSAND_FOLLOWED_BY_VAR_OR_VARARG') {
            $other[$text] = true;
        }
        $op = $tokens[$i + 1][0] ?? '';
        if (in_array($op, ['T_CONCAT_EQUAL', 'T_DIV_EQUAL', 'T_POW_EQUAL', 'T_MOD_EQUAL', 'T_COALESCE_EQUAL',
            'T_MUL_EQUAL', 'T_SL_EQUAL', 'T_SR_EQUAL', 'T_OR_EQUAL', 'T_AND_EQUAL', 'T_XOR_EQUAL'], true)) {
            $other[$text] = true;
        }
        // `$a->b = …` and `$a[…] = …` assign a property or an element, not the variable.
        if ($op !== '=' || in_array($prev[0], ['T_OBJECT_OPERATOR', 'T_NULLSAFE_OBJECT_OPERATOR', 'T_DOUBLE_COLON'], true)) {
            continue;
        }
        [$n1, $t1] = $tokens[$i + 2] ?? ['', ''];
        $n2 = $tokens[$i + 3][0] ?? '';
        if ($n1 === 'T_INT_CAST' || ($n1 === 'T_LNUMBER' && $n2 === ';')
            || ($n1 === 'T_STRING' && in_array(strtolower($t1), INT_FUNCTIONS, true) && $n2 === '(')) {
            $vars[$text] = true;
        } else {
            $other[$text] = true;
        }
    }
    $vars = array_diff_key($vars, $other);

    return $vars;
}

/**
 * Whether the operand ending just before $i (left of an operator) is an integer: an integer literal, an int variable,
 * a `(int)`-cast variable or property chain (`(int) $t->version`), or an INT_FUNCTIONS call or `(int)`-cast group.
 *
 * @param  list<array{0: string, 1: string}>  $tokens
 * @param  array<string, true>  $ints
 */
function intOperandBefore(array $tokens, int $i, array $ints): bool
{
    [$name, $text] = $tokens[$i - 1] ?? ['', ''];
    if ($name === 'T_LNUMBER') {
        return true;
    }
    if ($name === ')') {
        $depth = 0;
        for ($j = $i - 1; $j > 0; $j--) {
            $depth += $tokens[$j][0] === ')' ? 1 : ($tokens[$j][0] === '(' ? -1 : 0);
            if ($depth === 0) {
                break;
            }
        }
        $fn = $tokens[$j - 1] ?? ['', ''];

        return ($fn[0] === 'T_STRING' && in_array(strtolower($fn[1]), INT_FUNCTIONS, true)) || $fn[0] === 'T_INT_CAST';
    }
    $start = $i - 1;
    while ($start > 1 && in_array($tokens[$start][0], ['T_STRING', 'T_VARIABLE'], true)
        && in_array($tokens[$start - 1][0], ['T_OBJECT_OPERATOR', 'T_NULLSAFE_OBJECT_OPERATOR'], true)) {
        $start -= 2;
    }
    if (($tokens[$start][0] ?? '') !== 'T_VARIABLE') {
        return false;
    }
    if (($tokens[$start - 1][0] ?? '') === 'T_INT_CAST') {
        return true;
    }

    return $start === $i - 1 && isset($ints[$text]);
}

/**
 * Whether the operand starting at $i (right of an operator) is an integer: an integer literal, an int variable (not
 * followed by `->`, `[` or `(`), a `(int)` cast, or an INT_FUNCTIONS call.
 *
 * @param  list<array{0: string, 1: string}>  $tokens
 * @param  array<string, true>  $ints
 */
function intOperandAt(array $tokens, int $i, array $ints): bool
{
    [$name, $text] = $tokens[$i] ?? ['', ''];
    $after = $tokens[$i + 1][0] ?? '';

    return $name === 'T_LNUMBER' || $name === 'T_INT_CAST'
        || ($name === 'T_VARIABLE' && isset($ints[$text]) && ! in_array($after, ['T_OBJECT_OPERATOR', 'T_NULLSAFE_OBJECT_OPERATOR', '[', '('], true))
        || ($name === 'T_STRING' && in_array(strtolower($text), INT_FUNCTIONS, true) && $after === '(');
}

/**
 * The float guard (T8 review M3, T9 review M3, T10 review M1): what it refuses in $tokens, in order.
 * - (float), (double) — T_DOUBLE_CAST — and `(real)`; float literals (T_DNUMBER);
 * - the float functions, called plainly or fully qualified (`round(`, `\round(`);
 * - `+`, `-`, `+=`, `-=`, `++`, `--` unless every operand is known to be an integer (intOperandBefore/At: a literal,
 *   an `int` variable, an `(int)` cast, `count(…)`): PHP turns a decimal string into a float under them
 *   (`'0.1' + $m`, `$mass + 1`) — decimals go through bcmath (Decimal) only; a unary minus needs an integer operand;
 * - with $noMulDiv: `/`, `*`, `**`, `/=`, `*=`, `**=` (the mass path is bcmath only).
 *
 * @param  list<array{0: string, 1: string}>  $tokens
 * @return list<string>
 */
function floatGuard(array $tokens, bool $noMulDiv): array
{
    $floatFns = ['floatval', 'doubleval', 'round', 'floor', 'ceil', 'intdiv', 'fmod', 'fdiv', 'pow', 'sqrt'];
    $operandEnd = ['T_VARIABLE', 'T_LNUMBER', 'T_DNUMBER', 'T_STR', 'T_STRING', ')', ']', '}', '"'];
    $ints = intVariables($tokens);
    $bad = [];
    foreach ($tokens as $i => [$name, $text]) {
        $prev = $tokens[$i - 1][0] ?? '';
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
        $ok = match ($name) {
            '+', '-' => in_array($prev, $operandEnd, true)
                ? intOperandBefore($tokens, $i, $ints) && intOperandAt($tokens, $i + 1, $ints)
                : intOperandAt($tokens, $i + 1, $ints),
            'T_PLUS_EQUAL', 'T_MINUS_EQUAL' => intOperandBefore($tokens, $i, $ints) && intOperandAt($tokens, $i + 1, $ints),
            'T_INC', 'T_DEC' => $prev === 'T_VARIABLE' ? intOperandBefore($tokens, $i, $ints) : intOperandAt($tokens, $i + 1, $ints),
            default => true,
        };
        if (! $ok) {
            $bad[] = $text;
        }
        if ($noMulDiv && in_array($name, ['/', '*', 'T_POW', 'T_DIV_EQUAL', 'T_MUL_EQUAL', 'T_POW_EQUAL'], true)) {
            $bad[] = $text;
        }
    }

    return $bad;
}

it('no float on the processing / mass balance / lab result / recall / rating / complaint paths (T8 review M3, T9 review M3)', function (string $file, ?string $from, ?string $to, bool $noMulDiv) {
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
    // Task 11: the complaint operations (integer paging) and the public page (lab summary counts).
    ['app/Actions/Complaints/ComplaintsActions.php', null, null, false],
    ['app/Actions/Public/PublicBatchBuilder.php', null, null, true],
    // Task 13: the dashboards (shares and hours through Decimal), the report sheets and the download (T11 review M4).
    ['app/Actions/Analytics/Dashboard.php', null, null, true],
    ['app/Actions/Reports/Sheets.php', null, null, true],
    ['app/Actions/Reports/ReportsActions.php', null, null, true],
]);

it('the float guard refuses every form it must, and only those (T9 review M3, T10 review M1)', function () {
    $file = 'storage/framework/float-guard-probe-'.bin2hex(random_bytes(4)).'.php';
    file_put_contents(base_path($file), <<<'PHP'
        <?php
        $a = (double) $x; $a2 = (float) $x;
        $b = $g * $keep / 10000; $b2 = $g ** 2; $b3 /= $d; $b4 *= $d; $b5 **= 2;
        $c = 1.5; $c2 = 1e3;
        $d = round($e); $d2 = \round($e); $d3 = \floatval($e); $d4 = floor($e); $d5 = \intdiv($e, 2);
        $f = '0.1' + $m; $f2 = $m - $n; $f3 += $m; $f4 -= $m; $f5++; --$f6;
        // an integer literal beside a decimal string does not make it an integer (T10 review M1)
        $g = $mass + 1; $g2 = 1 - $mass; $g3 = $t->massKg + 1; $g4 = '0.5' + 1; $g5 = -$mass; $g6 = $rows[0] + 1; $g7 = $mass += 1;
        // allowed: operands known to be integers, a method or static call named like a float function
        function probe(int $page, ?int $size): void {}
        $v = (int) $t->version; $n = count($xs); $k = 0;
        $ok = $v + 1; $ok2 = $page - 1; $ok3 = 1 + $n; $ok4 = -1; $ok5 = $o->round($x); $ok6 = Decimal::floor($x);
        $ok7 = (int) $t->version + 1; $ok8 = count($xs) - 1; $ok9 = $size + $page; $k++; $ok10 = 1 + (int) $x; $ok11 = strlen($s) - $k;
        // refused: a variable once an integer, assigned anything else anywhere in the slice (T11 review M4)
        $z = 0; $z = $t->massKg; $bad = $z + 1; $q = 1; foreach ($rows as $q) {} $bad2 = $q - 1; $w = 1; [$w] = $pair; $bad3 = $w + 1;
        $u = 2; $u .= $m; $bad4 = $u - 1; $ix = 0; $list[$ix] = $m; $ok12 = $ix + 1;
        // refused too: compound assignments, by-reference out-parameters and references (T13 review M1)
        $y1 = 1; $y1 &= $mask; $bad5 = $y1 + 1; $y2 = 1; preg_match($re, $s, $y2); $bad6 = $y2 - 1;
        $y3 = 1; $fn = function () use (&$y3) {}; $bad7 = $y3 + 1; $y4 = 1; $y4 <<= 1; $bad8 = $y4 + 1; $y5 = 1; $y5 |= $x; $bad9 = $y5 - 1;
        PHP);
    try {
        $plusMinus = ['+', '-', '+=', '-=', '++', '--', '+', '-', '+', '+', '-', '+', '+=', '+', '-', '+', '-', '+', '-', '+', '+', '-'];
        expect(floatGuard(codeTokens($file), true))->toBe([
            '(double)', '(float)',
            '*', '/', '**', '/=', '*=', '**=',
            '1.5', '1e3',
            'round', '\round', '\floatval', 'floor', '\intdiv',
            ...$plusMinus,
        ]);
        // Without the mass-path flag, * / ** and their assignments pass; everything else is still refused.
        expect(floatGuard(codeTokens($file), false))->toBe([
            '(double)', '(float)', '1.5', '1e3',
            'round', '\round', '\floatval', 'floor', '\intdiv',
            ...$plusMinus,
        ]);
        // `*=` outside a mass-path file passes itself, but leaves no integer behind (T13 review M1).
        file_put_contents(base_path($file), '<?php $k = 1; $k *= $mass; $r = $k + 1; $j = 2; $ok = $j + 1;');
        expect(floatGuard(codeTokens($file), false))->toBe(['+']);
    } finally {
        unlink(base_path($file));
    }
});
