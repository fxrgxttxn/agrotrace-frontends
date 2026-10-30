<?php

/*
 * JavaScript number text and parsing (JsNumber): String(x) with its exponent forms, the XLSX import's numberText
 * (never an exponent), parseFloat/parseInt prefixes.
 */

use App\Support\JsNumber;

it('String(x) as JavaScript prints it', function (float|int $x, string $text) {
    expect(JsNumber::text($x))->toBe($text);
})->with([
    [1e21, '1e+21'], [1e20, '100000000000000000000'], [1e-7, '1e-7'], [1.5e-7, '1.5e-7'], [1e-6, '0.000001'],
    [0.1 + 0.2, '0.30000000000000004'], [-0.0, '0'], [0.0, '0'], [5, '5'], [-42, '-42'], [2.5, '2.5'],
    [123456789012345680000.0, '123456789012345680000'], [1.7976931348623157e308, '1.7976931348623157e+308'],
    [5e-324, '5e-324'], [-1.25e-10, '-1.25e-10'], [100.0, '100'],
]);

it('numberText: the same digits without an exponent', function (float $x, string $text) {
    expect(JsNumber::plain($x))->toBe($text);
})->with([
    [1e21, '1000000000000000000000'], [1e-7, '0.0000001'], [0.1, '0.1'], [2.0, '2'], [-0.0, '0'],
    [1.5e-10, '0.00000000015'], [0.1 + 0.2, '0.30000000000000004'], [-3.25, '-3.25'],
]);

it('parseFloat: the longest numeric prefix after JavaScript white space; null for NaN', function (string $s, ?float $x) {
    expect(JsNumber::parseFloat($s))->toBe($x);
})->with([
    ['1.50', 1.5], ['  7x', 7.0], ["\u{00A0}\u{3000}2", 2.0], ['.5', 0.5], ['5.', 5.0], ['1e3', 1000.0], ['1e', 1.0],
    ['-1.5E-2', -0.015], ['+3', 3.0], ['abc', null], ['', null], ['.', null], ['-', null], ['Infinity', INF],
    ['-Infinityx', -INF], ['0x10', 0.0],
]);

it('parseInt(s, 10)', function (string $s, ?int $n) {
    expect(JsNumber::parseInt($s))->toBe($n);
})->with([['12', 12], [' 3x', 3], ['-4', -4], ['x', null], ['', null], ['007', 7], ['1.9', 1]]);
