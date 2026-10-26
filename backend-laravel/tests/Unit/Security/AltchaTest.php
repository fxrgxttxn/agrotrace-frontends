<?php

/*
 * ALTCHA (P40, M7): every case of the shared vector contracts/rules/altcha.json (the key, the challenge, the
 * signature, each verdict at its nowMs), plus the JSON.parse semantics json_decode does not give by itself: `-0`,
 * a key spelled with escapes, duplicated `number`, `number` nested elsewhere, unsafe integers, lone surrogates,
 * invalid UTF-8 and deep nesting in extra widget fields, non-canonical base64 — never an exception.
 */

use App\Contract\RulesRepo;
use App\Security\Altcha;
use Tests\TestCase;

uses(TestCase::class);

function altchaVector(): array
{
    return RulesRepo::json('altcha');
}

/** base64 of a JSON text with the vector's members; $number is the raw token, $extra raw members appended. */
function altchaPayload(string $number = '12345', string $extra = '', ?string $numberKey = null): string
{
    $v = altchaVector();
    $key = $numberKey ?? '"number"';

    return base64_encode('{"algorithm":"SHA-256","challenge":"'.$v['challenge'].'",'.$key.':'.$number
        .',"salt":"'.$v['salt'].'","signature":"'.$v['signature'].'"'.$extra.'}');
}

const ALTCHA_NOW = 1790243700000;

it('derives the vector key, challenge and signature', function () {
    $v = altchaVector();
    expect(Altcha::key($v['jwtSecret']))->toBe($v['key'])
        ->and(hash('sha256', $v['salt'].$v['number']))->toBe($v['challenge'])
        ->and(hash_hmac('sha256', $v['challenge'], $v['key']))->toBe($v['signature']);
});

it('gives every vector case its verdict', function () {
    $v = altchaVector();
    foreach ($v['cases'] as $case) {
        $sig = Altcha::verify($v['key'], $case['payload'], $case['nowMs']);
        expect($sig !== null)->toBe($case['valid'], $case['name']);
        if ($case['valid']) {
            expect($sig)->toBe(json_decode(base64_decode($case['payload']), true)['signature']);
        }
    }
    expect(count($v['cases']))->toBeGreaterThan(10);
});

it('checks number by its source token and the last top-level member', function (string $payload, bool $valid) {
    expect(Altcha::verify(altchaVector()['key'], $payload, ALTCHA_NOW) !== null)->toBe($valid);
})->with([
    'plain' => [fn () => altchaPayload(), true],
    '-0 (json_decode gives 0)' => [fn () => altchaPayload('-0'), false],
    'minus' => [fn () => altchaPayload('-12345'), false],
    'leading zero is not JSON' => [fn () => altchaPayload('012345'), false],
    '12345.0 (a float in PHP, an integer in JS)' => [fn () => altchaPayload('12345.0'), false],
    '1.2345e4' => [fn () => altchaPayload('1.2345e4'), false],
    'key spelled number' => [fn () => altchaPayload('12345', '', '"\\u006eumber"'), true],
    'key spelled number with a fraction' => [fn () => altchaPayload('12345.0', '', '"\\u006eumber"'), false],
    'duplicate: the last one wins (right)' => [fn () => altchaPayload('1', ',"number":12345'), true],
    'duplicate: the last one wins (wrong)' => [fn () => altchaPayload('12345', ',"number":1'), false],
    'duplicate: the last one is -0' => [fn () => altchaPayload('12345', ',"num\\u0062er":-0'), false],
    'duplicate: the last one a string' => [fn () => altchaPayload('12345', ',"number":"12345"'), false],
    'nested number does not count' => [fn () => altchaPayload('12345', ',"x":{"number":-0},"y":[{"number":1.5}]'), true],
    'number named inside a string value' => [fn () => altchaPayload('12345', ',"x":"\\",\\"number\\":-0"'), true],
    'unsafe integer 2^53+1' => [fn () => altchaPayload('9007199254740993'), false],
    '1e400' => [fn () => altchaPayload('1e400'), false],
    '5000 digits' => [fn () => altchaPayload(str_repeat('9', 5000)), false],
    'NaN is not JSON' => [fn () => altchaPayload('NaN'), false],
    'null' => [fn () => altchaPayload('null'), false],
]);

it('reads extra widget fields as JSON.parse does', function (string $extra, bool $valid) {
    expect(Altcha::verify(altchaVector()['key'], altchaPayload('12345', $extra), ALTCHA_NOW) !== null)->toBe($valid);
})->with([
    'lone high surrogate' => [',"took":"\\ud800"', true],
    'lone low surrogate in a key' => [',"\\udc00":1', true],
    'a surrogate pair' => [',"e":"\\ud83d\\ude00"', true],
    'an escaped backslash before u' => [',"e":"\\\\ud800"', true],
    'invalid UTF-8' => [",\"took\":\"\xff\xfe\"", true],
    'nesting 1000 deep' => [',"deep":'.str_repeat('[', 1000).str_repeat(']', 1000), true],
    'broken JSON' => [',"took":', false],
]);

it('refuses malformed payloads without throwing', function (string $payload) {
    expect(Altcha::verify(altchaVector()['key'], $payload, ALTCHA_NOW))->toBeNull();
})->with([
    'empty' => [''],
    'whitespace inside' => [substr(altchaPayload(), 0, 8).' '.substr(altchaPayload(), 9)],
    'trailing newline' => [altchaPayload()."\n"],
    'non-canonical tail bits' => ['eyJhIjoxfR=='],
    'a BOM before the object' => [base64_encode("\xEF\xBB\xBF".base64_decode(altchaPayload()))],
    'a JSON string' => [base64_encode('"x"')],
    'an empty object' => [base64_encode('{}')],
    'expires with a trailing newline' => [base64_encode(str_replace('1790244000', '1790244000\\n', base64_decode(altchaPayload())))],
    'invalid UTF-8 only' => [base64_encode("\xff\xff\xff\xff")],
]);

it('issues challenges it verifies once solved; maxnumber 100000, expiry now + 600 s', function () {
    $key = Altcha::key('a-secret-of-at-least-32-characters!!');
    $now = 1790243700123;
    $c = Altcha::challenge($key, $now);
    expect(array_keys($c))->toBe(['algorithm', 'challenge', 'salt', 'signature', 'maxnumber'])
        ->and($c['maxnumber'])->toBe(100000)
        ->and($c['salt'])->toMatch('/\A[0-9a-f]{24}\?expires=1790244300\z/')
        ->and($c['signature'])->toBe(hash_hmac('sha256', $c['challenge'], $key));
    $n = 0;
    while (hash('sha256', $c['salt'].$n) !== $c['challenge']) {
        $n++;
    }
    expect($n)->toBeLessThanOrEqual(100000);
    $payload = base64_encode(json_encode(['algorithm' => 'SHA-256', 'challenge' => $c['challenge'], 'number' => $n,
        'salt' => $c['salt'], 'signature' => $c['signature']]));
    expect(Altcha::verify($key, $payload, $now))->toBe($c['signature'])
        ->and(Altcha::verify($key, $payload, 1790244300001))->toBeNull()
        ->and(Altcha::verify(Altcha::key('another-secret-of-at-least-32-chars!!'), $payload, $now))->toBeNull();
});
