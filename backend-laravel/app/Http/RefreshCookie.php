<?php

namespace App\Http;

use Symfony\Component\HttpFoundation\Cookie;

/**
 * The `at_refresh` cookie (R32, R40) written exactly as Express writes it — `at_refresh=<token>; Max-Age=1209600;
 * Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict`, and on deletion `at_refresh=; Max-Age=0; …` with the same
 * attributes. Symfony's own serialization would add `expires=` and turn an empty value into `deleted`, so the string
 * form is overridden; Laravel's cookie encryption is not in the middleware stack.
 */
final class RefreshCookie extends Cookie
{
    public const NAME = 'at_refresh';

    public const MAX_AGE = 1209600;

    private const ATTRS = 'Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict';

    public static function set(string $token): self
    {
        return new self(self::NAME, $token, time() + self::MAX_AGE, '/api/v1/auth', null, true, true, true, self::SAMESITE_STRICT);
    }

    public static function clear(): self
    {
        return new self(self::NAME, '', 1, '/api/v1/auth', null, true, true, true, self::SAMESITE_STRICT);
    }

    public function __toString(): string
    {
        $value = (string) $this->getValue();

        return self::NAME.'='.$value.'; Max-Age='.($value === '' ? 0 : self::MAX_AGE).'; '.self::ATTRS;
    }

    /** The `at_refresh` value of a raw Cookie header (the first one), or null — no URL-decoding, as Express. */
    public static function fromHeader(?string $header): ?string
    {
        if ($header === null || $header === '') {
            return null;
        }
        foreach (explode(';', $header) as $part) {
            $eq = strpos($part, '=');
            if ($eq !== false && $eq > 0 && trim(substr($part, 0, $eq)) === self::NAME) {
                $v = trim(substr($part, $eq + 1));

                return $v !== '' ? $v : null;
            }
        }

        return null;
    }
}
