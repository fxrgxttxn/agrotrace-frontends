<?php

namespace App\Security;

/**
 * Opaque one-time tokens (R82): 32 random bytes, base64url without padding (43 characters) — refresh tokens,
 * password reset and invitation links; stored only as their sha256 (hex).
 */
final class OpaqueTokens
{
    public static function new(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function hash(string $token): string
    {
        return hash('sha256', $token);
    }
}
