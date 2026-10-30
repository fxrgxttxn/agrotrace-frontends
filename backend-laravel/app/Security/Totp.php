<?php

namespace App\Security;

use ParagonIE\ConstantTime\Base32;
use PragmaRX\Google2FA\Google2FA;
use Throwable;

/**
 * TOTP (R35, L12): RFC 6238, SHA1, 6 digits, 30 s step, ±1 step accepted (pragmarx/google2fa). `verify` returns the
 * time step the code belongs to, so the caller can refuse a step already accepted for the user
 * (`totp-used:{userId}:{step}`, R82).
 */
final class Totp
{
    public const STEP_SEC = 30;

    public const ISSUER = 'AgroTrace';

    /** A new Base32 secret: 20 random bytes → 32 characters (contract pattern ^[A-Z2-7]{16,64}$). */
    public static function newSecret(): string
    {
        return Base32::encodeUpperUnpadded(random_bytes(20));
    }

    /** The accepted step (±1 around $nowSec) of $code, or null. */
    public static function verify(string $secret, string $code, int $nowSec): ?int
    {
        $g = new Google2FA;
        // Any Base32 secret of the contract's pattern (otplib does not require a power-of-two length).
        $g->setEnforceGoogleAuthenticatorCompatibility(false);
        $now = intdiv($nowSec, self::STEP_SEC);
        try {
            // oldTimestamp = now − 2: every step of the ±1 window is "newer", and the matching step is returned.
            $step = $g->verifyKeyNewer($secret, $code, $now - 2, 1, $now);
        } catch (Throwable) {
            return null;
        }

        return is_int($step) ? $step : null;
    }

    /** `otpauth://totp/AgroTrace:<email>?secret=…&period=30&digits=6&algorithm=SHA1&issuer=AgroTrace` (otplib's keyuri). */
    public static function otpauthUrl(string $email, string $secret): string
    {
        $label = rawurlencode(self::ISSUER).':'.rawurlencode($email);

        return 'otpauth://totp/'.$label.'?secret='.rawurlencode($secret)
            .'&period='.self::STEP_SEC.'&digits=6&algorithm=SHA1&issuer='.rawurlencode(self::ISSUER);
    }
}
