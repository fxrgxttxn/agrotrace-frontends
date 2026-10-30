<?php

/*
 * Ecma::compile (Global Constraints, R24 note, R21): the regular expressions of the contract and packages/validation
 * run with JavaScript semantics. The white-space cases are JavaScript's own `\s` (ECMA-262 WhiteSpace +
 * LineTerminator), checked character by character against what V8 answers for /\s/.
 */

use App\Http\Validation\Ecma;
use Tests\TestCase;

uses(TestCase::class);

const JS_WHITESPACE = [
    "\t", "\n", "\u{0B}", "\f", "\r", ' ', "\u{A0}", "\u{1680}", "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}",
    "\u{2004}", "\u{2005}", "\u{2006}", "\u{2007}", "\u{2008}", "\u{2009}", "\u{200A}", "\u{2028}", "\u{2029}",
    "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
];

it('NameString `\S`: a visible character passes, white space alone does not', function () {
    $p = Ecma::compile('\S');
    expect(Ecma::test($p, 'ab'))->toBeTrue();
    expect(Ecma::test($p, '  x  '))->toBeTrue(); // a search, not a full match
    foreach (["\u{00A0}", "\u{FEFF}", "\u{2028}", "  \t", "\u{3000}\u{A0}", ''] as $s) {
        expect(Ecma::test($p, $s))->toBeFalse(json_encode($s));
    }
});

it('`\s` is exactly JavaScript white space', function () {
    $s = Ecma::compile('^\s$');
    foreach (JS_WHITESPACE as $ws) {
        expect(Ecma::test($s, $ws))->toBeTrue(json_encode($ws));
    }
    // Not white space in JavaScript (PCRE's \s with UCP would take some): U+0085 NEL, U+180E, U+200B, U+2060.
    foreach (["\u{85}", "\u{180E}", "\u{200B}", "\u{2060}", 'a', '0'] as $other) {
        expect(Ecma::test($s, $other))->toBeFalse(json_encode($other));
    }
});

it('`$` does not match before a trailing newline (D flag)', function () {
    $p = Ecma::compile('^[A-Za-z0-9_-]{8,128}$');
    expect(Ecma::test($p, 'abcd1234'))->toBeTrue();
    expect(Ecma::test($p, "abcd1234\n"))->toBeFalse();
    expect(Ecma::test(Ecma::compile('^\d{6}$'), "123456\n"))->toBeFalse();
});

it('`\d` and `\w` are ASCII only; `.` stops at line terminators', function () {
    expect(Ecma::test(Ecma::compile('^\d$'), '٣'))->toBeFalse(); // ARABIC-INDIC DIGIT THREE
    expect(Ecma::test(Ecma::compile('^\d$'), '7'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^\D$'), '٣'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^\w+$'), 'abc_09'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^\w+$'), 'абв'))->toBeFalse();
    expect(Ecma::test(Ecma::compile('^\W$'), 'ж'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^.$'), 'ж'))->toBeTrue(); // one code point, not one byte
    expect(Ecma::test(Ecma::compile('^.$'), "\u{1F600}"))->toBeTrue();
    foreach (["\n", "\r", "\u{2028}", "\u{2029}"] as $lt) {
        expect(Ecma::test(Ecma::compile('^.$'), $lt))->toBeFalse(json_encode($lt));
    }
});

it('`pattern` is a search: no implicit anchors', function () {
    expect(Ecma::test(Ecma::compile('\d{3}'), 'ab123cd'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^\d{3}'), 'ab123cd'))->toBeFalse();
});

it('compiles the contract patterns with classes, lookaheads, escapes and the delimiter', function () {
    expect(Ecma::test(Ecma::compile('^(?!0+\.000$)\d{1,9}\.\d{3}$'), '0.000'))->toBeFalse();
    expect(Ecma::test(Ecma::compile('^(?!0+\.000$)\d{1,9}\.\d{3}$'), '0.001'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^\+[1-9]\d{6,14}$'), '+79991234567'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^[0-9A-Z-]{1,8}$'), 'RU-MOW'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^/api/v1/files/[0-9a-f]{8}$'), '/api/v1/files/0123abcd'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^a~b$'), 'a~b'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^[~]$'), '~'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^[\s,]+$'), " ,\u{A0}"))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^[\d.]+$'), '1.5'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^é$'), 'é'))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^\u{1F600}$'), "\u{1F600}"))->toBeTrue();
    expect(Ecma::test(Ecma::compile('^[a-z]+(-[a-z]+)*$'), 'version-conflict'))->toBeTrue();
});

it('never matches a subject that is not UTF-8, and refuses what it cannot translate', function () {
    expect(Ecma::test(Ecma::compile('.'), "\xFF"))->toBeFalse();
    expect(fn () => Ecma::compile('[\S]'))->toThrow(InvalidArgumentException::class);
    expect(fn () => Ecma::compile('[abc'))->toThrow(InvalidArgumentException::class);
    expect(fn () => Ecma::compile('abc\\'))->toThrow(InvalidArgumentException::class);
});
