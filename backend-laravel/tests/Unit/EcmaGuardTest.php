<?php

/*
 * Regular expressions over input data (Global Constraints, R21, R24): a pattern of the contract or of
 * packages/validation becomes PCRE only through App\Http\Validation\Ecma::compile (JavaScript semantics, flags `uD`).
 * Every other preg_* call in app/ uses a literal pattern (or a class constant) that states its mode explicitly — `u`
 * (UTF-8 code points) or `D` (`$` is the very end) — or is one of the internal scanners listed below with its reason.
 */

use Tests\Support\SourceScan;
use Tests\TestCase;

uses(TestCase::class);

/**
 * Every preg_* call of the tokens whose pattern is neither Ecma::compile(…) nor a literal/constant with `u` or `D`:
 * the source text of its pattern argument.
 *
 * @param  list<PhpToken>  $tokens
 * @param  callable(string): ?string  $constant  `self::NAME` / `Class::NAME` → its value (null: unknown)
 * @return list<string>
 */
function unguardedPatterns(array $tokens, callable $constant): array
{
    $out = [];
    foreach ($tokens as $i => $t) {
        if (! $t->is(T_STRING) || ! preg_match('/^preg_(match|match_all|replace|replace_callback|replace_callback_array|split|grep|filter)$/D', $t->text)
            || ($tokens[$i + 1]->text ?? '') !== '(' || ($tokens[$i - 1] ?? null)?->is([T_FUNCTION, T_OBJECT_OPERATOR, T_DOUBLE_COLON]) === true) {
            continue;
        }
        $arg = [];
        $depth = 0;
        for ($j = $i + 2; isset($tokens[$j]); $j++) {
            $x = $tokens[$j]->text;
            if ($depth === 0 && ($x === ',' || $x === ')')) {
                break;
            }
            $depth += in_array($x, ['(', '[', '{'], true) ? 1 : (in_array($x, [')', ']', '}'], true) ? -1 : 0);
            $arg[] = $tokens[$j];
        }
        $text = implode('', array_map(fn (PhpToken $a) => $a->text, $arg));
        if (str_starts_with($text, 'Ecma::compile(')) {
            continue;
        }
        $value = null;
        if (count($arg) === 1 && $arg[0]->is(T_CONSTANT_ENCAPSED_STRING)) {
            $value = eval('return '.$arg[0]->text.';');
        } elseif (count($arg) === 3 && $arg[1]->is(T_DOUBLE_COLON) && $arg[2]->is(T_STRING)) {
            $value = $constant($arg[0]->text.'::'.$arg[2]->text);
        }
        if (is_string($value) && $value !== '' && preg_match('/[uD]/', substr($value, strrpos($value, $value[0]) + 1))) {
            continue;
        }
        $out[] = $text;
    }

    return $out;
}

/** The namespace and class of a file's tokens → a resolver of `self::NAME` / `Short::NAME` (a `use`d class). */
function constantResolver(array $tokens): callable
{
    $ns = '';
    $class = null;
    $uses = [];
    foreach ($tokens as $i => $t) {
        if ($t->is(T_NAMESPACE)) {
            $ns = $tokens[$i + 1]->text;
        } elseif ($t->is(T_USE) && ($tokens[$i + 1] ?? null)?->is([T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED]) === true) {
            $name = ltrim($tokens[$i + 1]->text, '\\');
            $uses[substr($name, strrpos($name, '\\') + 1)] = $name;
        } elseif ($class === null && $t->is([T_CLASS, T_ENUM, T_TRAIT, T_INTERFACE]) && ($tokens[$i + 1] ?? null)?->is(T_STRING) === true) {
            $class = $ns.'\\'.$tokens[$i + 1]->text;
        }
    }

    return function (string $ref) use ($class, $uses, $ns): ?string {
        [$owner, $name] = explode('::', $ref, 2);
        $fqcn = $owner === 'self' || $owner === 'static' ? $class : ($uses[$owner] ?? $ns.'\\'.$owner);
        if ($fqcn === null || ! (class_exists($fqcn) || interface_exists($fqcn) || enum_exists($fqcn))) {
            return null;
        }
        $value = (new ReflectionClassConstant($fqcn, $name))->getValue();

        return is_string($value) ? $value : null;
    };
}

it('turns input patterns into PCRE only through Ecma::compile; other patterns state u/D or are listed', function () {
    $found = [];
    foreach (SourceScan::appFiles() as $file) {
        $tokens = SourceScan::code($file);
        foreach (unguardedPatterns($tokens, constantResolver($tokens)) as $p) {
            $found[] = "{$file}: {$p}";
        }
    }
    expect($found)->toBe([
        // The public code of a path parameter: \A…\z (the strict anchors, like `D`), ASCII classes only.
        'app/Actions/Public/PublicActions.php: self::PUBLIC_CODE',
        'app/Actions/Public/PublicActions.php: self::PUBLIC_CODE',
        // decodeSegment: a search for a malformed %-escape in one raw path segment (bytes, no anchors).
        "app/Contract/Contract.php: '/%(?![0-9A-Fa-f]{2})/'",
        // /proc/net/tcp6 rows (kernel text, ASCII hex) rewritten to the IPv4 form.
        "app/Http/ClientConnection.php: '/\\b0{16}FFFF0000([0-9A-F]{8}):/'",
        // Ecma::test runs a pattern Ecma::compile produced (its only caller passes one).
        'app/Http/Validation/Ecma.php: $compiled',
        // Ecma's own scanner of a \u escape of the JavaScript source (ASCII hex at an offset, \G).
        "app/Http/Validation/Ecma.php: '/\\G\\{([0-9A-Fa-f]{1,6})\\}/'",
        "app/Http/Validation/Ecma.php: '/\\G[0-9A-Fa-f]{4}/'",
        // /etc/hosts and /etc/resolv.conf fields (system files, ASCII white space).
        "app/Infrastructure/Net/BoundedResolver.php: '/\\s+/'",
        "app/Infrastructure/Net/BoundedResolver.php: '/\\s+/'",
        "app/Infrastructure/Net/BoundedResolver.php: '/[#;]/'",
        // NotificationText: the ISO prefix of a datetime value the application wrote itself (anchored at the start).
        'app/Notifications/NotificationText.php: self::ISO_DATETIME',
        // Altcha: \A…\z anchors are the strict form (no trailing-newline match, like `D`); ASCII classes only.
        "app/Security/Altcha.php: '#\\A[A-Za-z0-9+/]*={0,2}\\z#'",
        'app/Security/Altcha.php: self::HEX64', // the signature
        'app/Security/Altcha.php: self::HEX64', // the challenge
        "app/Security/Altcha.php: '/\\A(0|[1-9][0-9]*)\\z/'",
        // Altcha: a `expires=` query parameter of the salt, a substring search of ASCII text.
        "app/Security/Altcha.php: '/[?&]expires=([0-9]{1,12})(?:&|\\z)/'",
        // Altcha: the JSON escapes of the payload (byte-level rewrite of `\uD8xx` lone surrogates, `s` flag).
        "app/Security/Altcha.php: '/\\\\\\\\u[dD][89abAB][0-9a-fA-F]{2}\\\\\\\\u[dD][c-fC-F][0-9a-fA-F]{2}|(\\\\\\\\u[dD][89a-fA-F][0-9a-fA-F]{2})|\\\\\\\\./s'",
        // Altcha: a JSON number at an offset (\G, ASCII).
        "app/Security/Altcha.php: '/\\G-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/'",
        // /proc/net/tcp rows of the client socket (kernel text).
        "app/Sse/ClientSocketIo.php: '/\\s+/'",
    ]);
});

it('accepts Ecma::compile and literals/constants with u or D, flags anything else (the scan itself works)', function () {
    $code = array_values(array_filter(PhpToken::tokenize('<?php
        preg_match(Ecma::compile($p), $s); preg_match(\'/^a$/D\', $s); preg_split(\'//u\', $s); preg_match(self::X, $s);
        preg_match(\'/^a$/\', $s); preg_replace($pattern, "", $s); preg_quote($s); $o->preg_match(\'/x/\');'),
        fn (PhpToken $t) => ! $t->isIgnorable()));
    expect(unguardedPatterns($code, fn (string $ref) => $ref === 'self::X' ? '/x/uD' : null))
        ->toBe(["'/^a$/'", '$pattern']);
});
