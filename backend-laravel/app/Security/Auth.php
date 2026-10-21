<?php

namespace App\Security;

use App\Support\RequestContext;
use Illuminate\Http\Request;
use LogicException;

/** The request's principal (set by the Operation middleware) and Bearer parsing. */
final class Auth
{
    private const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

    public static function principal(): Principal
    {
        return app(RequestContext::class)->principal()
            ?? throw new LogicException('Auth::principal(): the route has no Bearer guard');
    }

    /** The principal of a valid Bearer token, or null (no header, a malformed or invalid token) — never 401. */
    public static function bearer(Request $request): ?Principal
    {
        $header = $request->headers->get('Authorization');
        $token = is_string($header) ? self::bearerToken($header) : null;

        return $token === null ? null : Jwt::tryVerify($token);
    }

    /** `Bearer <b64url>.<b64url>.<b64url>` (scheme case-insensitive, one space), as Express's /^Bearer (…)$/i. */
    public static function bearerToken(string $header): ?string
    {
        if (strlen($header) < 8 || strncasecmp($header, 'Bearer ', 7) !== 0) {
            return null;
        }
        $token = substr($header, 7);
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }
        foreach ($parts as $part) {
            if ($part === '' || strspn($part, self::B64URL) !== strlen($part)) {
                return null;
            }
        }

        return $token;
    }
}
