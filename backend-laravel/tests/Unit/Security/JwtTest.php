<?php

/*
 * Access tokens (P12, L12): HS256 with the shared secret, `exp = iat + 900`, `jti`; every refusal of the contract
 * (alg none / HS512 / RS256 over the HMAC secret, `crit`, missing or mistyped claims, a foreign signature, expiry).
 */

use App\Http\Problem\Problem;
use App\Security\Jwt;
use Tests\TestCase;

uses(TestCase::class);

const JWT_TEST_SECRET = 'jwt_test_secret_of_at_least_32_bytes!!';

function b64u(string $s): string
{
    return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

/** A token over $payload with $header, HMAC-signed with the hash the header names (HS256 for anything else). */
function signTestJwt(array $payload, array $header = ['alg' => 'HS256', 'typ' => 'JWT'], string $secret = JWT_TEST_SECRET): string
{
    $head = b64u(json_encode($header));
    $body = b64u(json_encode($payload));
    if (($header['alg'] ?? null) === 'none') {
        return "{$head}.{$body}.";
    }
    $algo = ['HS512' => 'sha512', 'HS384' => 'sha384'][$header['alg']] ?? 'sha256';

    return "{$head}.{$body}.".b64u(hash_hmac($algo, "{$head}.{$body}", $secret, true));
}

beforeEach(fn () => config(['agrotrace.jwt_secret' => JWT_TEST_SECRET]));

function validClaims(): array
{
    $now = time();

    return [
        'sub' => '11111111-1111-4111-8111-111111111111',
        'org' => '22222222-2222-4222-8222-222222222222',
        'roles' => ['INSPECTOR'],
        'org_admin' => true,
        'iat' => $now,
        'exp' => $now + 900,
        'jti' => 'f9a1c2d3-0000-4000-8000-000000000001',
    ];
}

it('issues HS256 tokens with exp = iat + 900 and a jti, and verifies them', function () {
    $t = Jwt::issue('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', ['FARMER'], false);
    [$h, $p] = explode('.', $t);
    expect(json_decode(base64_decode(strtr($h, '-_', '+/')), true))->toBe(['typ' => 'JWT', 'alg' => 'HS256']);
    $claims = json_decode(base64_decode(strtr($p, '-_', '+/')), true);
    expect($claims['exp'] - $claims['iat'])->toBe(900);
    expect($claims['jti'])->toBeString();
    $principal = Jwt::verify($t);
    expect([$principal->userId, $principal->orgId, $principal->roles, $principal->orgAdmin, $principal->exp])
        ->toBe(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', ['FARMER'], false, $claims['exp']]);
    expect(Jwt::tryVerify(signTestJwt(validClaims())))->not->toBeNull();
});

it('refuses every forged or malformed token', function (Closure $make) {
    expect(Jwt::tryVerify($make()))->toBeNull();
    expect(fn () => Jwt::verify($make()))->toThrow(Problem::class);
})->with([
    'alg none' => fn () => signTestJwt(validClaims(), ['alg' => 'none', 'typ' => 'JWT']),
    'HS512' => fn () => signTestJwt(validClaims(), ['alg' => 'HS512', 'typ' => 'JWT']),
    'RS256 header, HMAC with the secret' => fn () => signTestJwt(validClaims(), ['alg' => 'RS256', 'typ' => 'JWT']),
    'crit' => fn () => signTestJwt(validClaims(), ['alg' => 'HS256', 'typ' => 'JWT', 'crit' => ['x-at'], 'x-at' => 1]),
    'foreign secret' => fn () => signTestJwt(validClaims(), secret: 'another_secret_of_at_least_32_bytes!!'),
    'expired' => fn () => signTestJwt(['iat' => time() - 1000, 'exp' => time() - 100] + validClaims()),
    'no sub' => fn () => signTestJwt(array_diff_key(validClaims(), ['sub' => 1])),
    'no org' => fn () => signTestJwt(array_diff_key(validClaims(), ['org' => 1])),
    'no exp' => fn () => signTestJwt(array_diff_key(validClaims(), ['exp' => 1])),
    'no iat' => fn () => signTestJwt(array_diff_key(validClaims(), ['iat' => 1])),
    'no jti' => fn () => signTestJwt(array_diff_key(validClaims(), ['jti' => 1])),
    'sub not a uuid' => fn () => signTestJwt(['sub' => 'admin'] + validClaims()),
    'org a number' => fn () => signTestJwt(['org' => 42] + validClaims()),
    'exp a float' => fn () => signTestJwt(['exp' => time() + 900.5] + validClaims()),
    'roles empty' => fn () => signTestJwt(['roles' => []] + validClaims()),
    'unknown role' => fn () => signTestJwt(['roles' => ['ROOT']] + validClaims()),
    'jti a number' => fn () => signTestJwt(['jti' => 7] + validClaims()),
    'org_admin a string' => fn () => signTestJwt(['org_admin' => 'true'] + validClaims()),
    'two segments' => fn () => 'a.b',
    'tampered payload' => function () {
        [$h, , $s] = explode('.', signTestJwt(validClaims()));

        return $h.'.'.b64u(json_encode(['roles' => ['ADMIN']] + validClaims())).'.'.$s;
    },
]);
