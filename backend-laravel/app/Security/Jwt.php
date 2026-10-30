<?php

namespace App\Security;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Validation\Ecma;
use Firebase\JWT\JWT as FirebaseJwt;
use Firebase\JWT\Key;
use Illuminate\Support\Str;
use stdClass;
use Throwable;

/**
 * Access tokens (contract `AccessToken`, P12, L12): JWT HS256 with the shared JWT_SECRET, 15 minutes, claims `sub`,
 * `org`, `roles`, `org_admin`, `exp`, `iat`, `jti` — a token issued by any backend is accepted by any other.
 *
 * The header is checked by hand BEFORE the signature: `alg` exactly HS256 (`none`, HS384/HS512, RS256 over the HMAC
 * secret… are refused) and no `crit` (jose rejects an unknown critical parameter; this backend understands none).
 * firebase/php-jwt then verifies the signature and `exp`/`nbf`/`iat`; the claim types are checked as Express does:
 * `sub`/`org` UUIDs, `roles` a non-empty array of RoleCode, `org_admin` boolean, `exp`/`iat` integers, `jti` a string.
 */
final class Jwt
{
    public const TTL_SEC = 900;

    private const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    /** @param  list<string>  $roles */
    public static function issue(string $userId, string $orgId, array $roles, bool $orgAdmin, ?int $now = null): string
    {
        $iat = $now ?? time();

        return FirebaseJwt::encode([
            'org' => $orgId,
            'roles' => $roles,
            'org_admin' => $orgAdmin,
            'sub' => $userId,
            'iat' => $iat,
            'exp' => $iat + self::TTL_SEC,
            'jti' => (string) Str::uuid(),
        ], self::secret(), 'HS256', null, ['alg' => 'HS256', 'typ' => 'JWT']);
    }

    /** The principal of a valid token; 401 UNAUTHORIZED for anything else. */
    public static function verify(string $token): Principal
    {
        return self::tryVerify($token) ?? throw new Problem(401, ProblemCode::UNAUTHORIZED);
    }

    /** The principal of a valid token, or null — never throws. */
    public static function tryVerify(string $token, ?int $now = null): ?Principal
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }
        $header = self::segment($parts[0]);
        if (! $header instanceof stdClass || ($header->alg ?? null) !== 'HS256' || property_exists($header, 'crit')) {
            return null;
        }
        $previous = FirebaseJwt::$timestamp;
        try {
            FirebaseJwt::$timestamp = $now;
            $claims = FirebaseJwt::decode($token, new Key(self::secret(), 'HS256'));
        } catch (Throwable) {
            return null;
        } finally {
            FirebaseJwt::$timestamp = $previous;
        }
        // The raw payload, not firebase's decoding: types are judged on the JSON as sent (an `exp` of 900.5 is no
        // integer even though PHP would compare it fine).
        $raw = self::segment($parts[1]);
        if (! $raw instanceof stdClass) {
            return null;
        }
        $sub = $raw->sub ?? null;
        $org = $raw->org ?? null;
        $roles = $raw->roles ?? null;
        $orgAdmin = $raw->org_admin ?? null;
        $exp = $raw->exp ?? null;
        $iat = $raw->iat ?? null;
        $jti = $raw->jti ?? null;
        if (! is_string($sub) || ! self::isUuid($sub) || ! is_string($org) || ! self::isUuid($org)) {
            return null;
        }
        if (! is_bool($orgAdmin) || ! is_string($jti) || ! is_int($exp) || ! is_int($iat)) {
            return null;
        }
        if (! is_array($roles) || $roles === []) {
            return null;
        }
        foreach ($roles as $r) {
            if (! is_string($r) || ! in_array($r, Principal::ROLES, true)) {
                return null;
            }
        }
        unset($claims);

        return new Principal($sub, $org, array_values($roles), $orgAdmin, $exp);
    }

    private static function segment(string $b64): mixed
    {
        $json = base64_decode(strtr($b64, '-_', '+/'), true);
        if ($json === false) {
            return null;
        }
        try {
            // Integers stay integers, `900.5` stays a float (JSON_BIGINT_AS_STRING: a huge number is no int either).
            return json_decode($json, false, 32, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        } catch (Throwable) {
            return null;
        }
    }

    private static function isUuid(string $s): bool
    {
        return Ecma::test(Ecma::compile(self::UUID, 'i'), $s);
    }

    private static function secret(): string
    {
        return (string) config('agrotrace.jwt_secret');
    }
}
