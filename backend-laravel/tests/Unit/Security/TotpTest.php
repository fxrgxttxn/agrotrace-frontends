<?php

/*
 * TOTP (R35, L12): RFC 6238 SHA1 vectors (secret "12345678901234567890", the 6-digit tail of the 8-digit values),
 * ±1 step accepted and the matching step returned (the `totp-used:{userId}:{step}` key), ±2 refused; the otpauth URL
 * in otplib's keyuri form.
 */

use App\Security\Totp;
use ParagonIE\ConstantTime\Base32;

const RFC6238_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32("12345678901234567890")

it('accepts the RFC 6238 vectors at their own time and returns the step', function (int $time, string $code) {
    expect(Totp::verify(RFC6238_SECRET, $code, $time))->toBe(intdiv($time, 30));
})->with([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
]);

it('accepts the step before and after, returning the matching step; ±2 and garbage are refused', function () {
    $t = 1234567890; // step 41152263
    $step = intdiv($t, 30);
    expect(Totp::verify(RFC6238_SECRET, '005924', $t + 30))->toBe($step); // the code of step-1 seen one step later
    expect(Totp::verify(RFC6238_SECRET, '005924', $t - 30))->toBe($step); // … and one step earlier
    expect(Totp::verify(RFC6238_SECRET, '005924', $t + 60))->toBeNull();
    expect(Totp::verify(RFC6238_SECRET, '005924', $t - 60))->toBeNull();
    expect(Totp::verify(RFC6238_SECRET, '000000', $t))->toBeNull();
    expect(Totp::verify('not base32!', '005924', $t))->toBeNull();
});

it('draws 32-character Base32 secrets of 20 random bytes', function () {
    $s = Totp::newSecret();
    expect($s)->toMatch('/^[A-Z2-7]{32}$/');
    expect(strlen(Base32::decodeUpper($s)))->toBe(20);
    expect(Totp::newSecret())->not->toBe($s);
});

it('builds the otpauth URL as otplib does', function () {
    expect(Totp::otpauthUrl('a.b+c@agrotrace.test', 'JBSWY3DPEHPK3PXP'))->toBe(
        'otpauth://totp/AgroTrace:a.b%2Bc%40agrotrace.test?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&algorithm=SHA1&issuer=AgroTrace',
    );
});
