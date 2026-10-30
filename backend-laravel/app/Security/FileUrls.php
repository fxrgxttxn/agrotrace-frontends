<?php

namespace App\Security;

/**
 * File URLs (contract `SignedFileUrl`/`PublicFileUrl`, R28/R34/R39/R88 M2): logos and product images are public
 * (`/api/v1/public/files/{id}`); avatars, lab protocols, QR and reports are signed —
 * `fileUrlKey = HMAC-SHA256(JWT_SECRET, "agrotrace:file-url:v1")`, `sig = hex(HMAC-SHA256(fileUrlKey, "{id}:{exp}"))`,
 * `exp` = now + 3600 (Unix seconds, decimal without leading zeros). The recipe of every backend: a URL signed by one is
 * served by any other.
 */
final class FileUrls
{
    public const TTL_SEC = 3600;

    public const PUBLIC_KINDS = ['LOGO', 'PRODUCT_IMAGE'];

    public static function key(?string $secret = null): string
    {
        return hash_hmac('sha256', 'agrotrace:file-url:v1', $secret ?? (string) config('agrotrace.jwt_secret'), true);
    }

    public static function signature(string $fileId, int $exp, ?string $secret = null): string
    {
        return hash_hmac('sha256', strtolower($fileId).':'.$exp, self::key($secret));
    }

    /** `variant` is not part of the URL: the client adds or replaces `variant=96|480` freely. */
    public static function signed(string $fileId, ?string $variant = null, ?int $now = null): string
    {
        $exp = ($now ?? time()) + self::TTL_SEC;
        $url = '/api/v1/files/'.strtolower($fileId).'?exp='.$exp.'&sig='.self::signature($fileId, $exp);

        return $variant === null ? $url : $url.'&variant='.$variant;
    }

    public static function public(string $fileId): string
    {
        return '/api/v1/public/files/'.strtolower($fileId);
    }

    /** The URL of a FileRef: public for LOGO / PRODUCT_IMAGE, signed otherwise. */
    public static function forKind(string $kind, string $fileId): string
    {
        return in_array($kind, self::PUBLIC_KINDS, true) ? self::public($fileId) : self::signed($fileId);
    }

    /**
     * The signature check of downloadFile (P17): `exp` exactly `^[1-9]\d{0,11}$` and not in the past, `sig` 64 lower-case
     * hex digits, compared in constant time. The id is taken as written in the path (lower-cased for the message).
     */
    public static function verify(string $fileId, mixed $exp, mixed $sig, ?int $now = null): bool
    {
        if (! is_string($exp) || ! is_string($sig)) {
            return false;
        }
        if (strlen($exp) < 1 || strlen($exp) > 12 || ! ctype_digit($exp) || $exp[0] === '0') {
            return false;
        }
        if ((int) $exp < ($now ?? time())) {
            return false;
        }
        if (strlen($sig) !== 64 || strspn($sig, '0123456789abcdef') !== 64) {
            return false;
        }

        return hash_equals(self::signature($fileId, (int) $exp), $sig);
    }
}
