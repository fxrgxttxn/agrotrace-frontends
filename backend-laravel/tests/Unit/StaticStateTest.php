<?php

/*
 * Octane keeps one application per worker thread across requests (L3, Review Focus 4): a static property or a
 * `static $x` local in app/ outlives the request and would leak one request's state into the next. Per-worker state
 * lives in container singletons (Contract, RulesRepo, DbSlots — immutable after boot or released per request), per
 * request state in scoped bindings (RequestContext, TxState). The only static state allowed is listed below, each
 * with its reason.
 */

use Tests\Support\SourceScan;
use Tests\TestCase;

uses(TestCase::class);

/**
 * The variables declared static in these tokens (code only): static properties (any modifiers and type) and
 * `static $x` locals — not `static function`, `static fn`, `static::`, `new static` or a `: static` return type.
 *
 * @param  list<PhpToken>  $tokens
 * @return list<string>
 */
function staticVariables(array $tokens): array
{
    $out = [];
    foreach ($tokens as $i => $t) {
        if (! $t->is(T_STATIC) || ($tokens[$i - 1] ?? null)?->is([T_NEW, T_DOUBLE_COLON]) === true) {
            continue;
        }
        for ($j = $i + 1; isset($tokens[$j]); $j++) {
            $n = $tokens[$j];
            if ($n->is(T_VARIABLE)) {
                $out[] = $n->text;

                break;
            }
            // A property type (`?array`, `int|string`, `Foo\Bar`, DNF parentheses) continues; anything else ends.
            if (! $n->is([T_STRING, T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED, T_ARRAY, T_CALLABLE]) && ! in_array($n->text, ['?', '|', '&', '(', ')'], true)) {
                break;
            }
        }
    }

    return $out;
}

it('has no static state in app/ but the listed exceptions', function () {
    $found = [];
    foreach (SourceScan::appFiles() as $file) {
        foreach (staticVariables(SourceScan::code($file)) as $var) {
            $found[] = "{$file} {$var}";
        }
    }
    expect($found)->toBe([
        // SvgDom::jsTrim: `static $set` — the code point set of the constant JS_SPACE, built once; never written
        // again and the same for every request (P18).
        'app/Infrastructure/Svg/SvgDom.php $set',
    ]);
});

it('finds static properties and static locals, nothing else (the scan itself works)', function () {
    $code = array_values(array_filter(PhpToken::tokenize('<?php final class Probe {'
        .' private static ?array $cache = null; public static int|string $n = 1; protected static (A&B)|null $dnf;'
        .' public static function f(): static { static $memo = []; $g = static fn ($x) => new static; $h = static function () {};'
        .' return static::$cache; } }'), fn (PhpToken $t) => ! $t->isIgnorable()));
    expect(staticVariables($code))->toBe(['$cache', '$n', '$dnf', '$memo']);
});
