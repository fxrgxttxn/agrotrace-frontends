<?php

namespace App\Security;

/**
 * ALTCHA proof of work for the public complaint form (contract getCaptchaChallenge / createPublicComplaint, P40, M7;
 * Express infra/altcha.ts line by line), shared by the three backends so a challenge issued by one is accepted by any:
 *
 *   key       = hex(HMAC-SHA256(JWT_SECRET, "agrotrace:altcha:v1"))  (used as the HMAC key string, UTF-8)
 *   salt      = 24 hex chars + "?expires=" + Unix seconds (issue time + 600)
 *   challenge = sha256hex(salt + number), number ∈ [0, maxnumber] secret
 *   signature = hex(HMAC-SHA256(key, challenge))
 *
 * A solution is canonical padded standard base64 (RFC 4648 §4) of a JSON object read with JSON.parse semantics: the
 * last duplicate key wins, invalid UTF-8 inside strings becomes U+FFFD — one per invalid byte, where Buffer#toString
 * (WHATWG) emits one per maximal subpart, so the count may differ; that cannot change a verdict for a server-issued
 * challenge, whose salt is ASCII and bound by the signature (T11 review M1) — a lone surrogate escape is a string
 * character (its UTF-8 is U+FFFD's, as Node encodes it), any nesting depth. `number` is checked against its source
 * text — the last top-level member named `number` (escapes in keys expanded), as the JSON.parse reviver's
 * `context.source` gives it — because json_decode turns `-0` into 0 and `12345.0` into a float. Replay protection
 * (`altcha-used:{signature}`) is the caller's (shared Redis, R82). Malformed input is null, never an exception.
 */
final class Altcha
{
    public const TTL_SEC = 600;

    public const MAX_NUMBER = 100_000;

    private const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

    private const HEX64 = '/\A[0-9a-f]{64}\z/';

    public static function key(string $jwtSecret): string
    {
        return hash_hmac('sha256', 'agrotrace:altcha:v1', $jwtSecret);
    }

    /** @return array{algorithm: 'SHA-256', challenge: string, salt: string, signature: string, maxnumber: int} */
    public static function challenge(string $key, int $nowMs): array
    {
        $expires = intdiv($nowMs, 1000) + self::TTL_SEC;
        $salt = bin2hex(random_bytes(12))."?expires={$expires}";
        $challenge = hash('sha256', $salt.random_int(0, self::MAX_NUMBER));

        return [
            'algorithm' => 'SHA-256',
            'challenge' => $challenge,
            'salt' => $salt,
            'signature' => hash_hmac('sha256', $challenge, $key),
            'maxnumber' => self::MAX_NUMBER,
        ];
    }

    /** The signature of a valid, unexpired solution (its replay key), or null. */
    public static function verify(string $key, string $payload, int $nowMs): ?string
    {
        if (strlen($payload) % 4 !== 0 || preg_match('#\A[A-Za-z0-9+/]*={0,2}\z#', $payload) !== 1) {
            return null;
        }
        $bytes = base64_decode($payload, true);
        if ($bytes === false || base64_encode($bytes) !== $payload) {
            return null;
        }
        $v = self::parseObject($bytes);
        if ($v === null) {
            return null;
        }
        [$fields, $numberSource] = $v;
        $algorithm = $fields['algorithm'] ?? null;
        $challenge = $fields['challenge'] ?? null;
        $number = $fields['number'] ?? null;
        $salt = $fields['salt'] ?? null;
        $signature = $fields['signature'] ?? null;
        if ($algorithm !== 'SHA-256' || ! is_string($salt) || ! is_string($challenge)) {
            return null;
        }
        if (! is_string($signature) || preg_match(self::HEX64, $signature) !== 1 || preg_match(self::HEX64, $challenge) !== 1) {
            return null;
        }
        if (! is_int($number) || $number < 0 || $number > self::MAX_SAFE_INTEGER) {
            return null;
        }
        // `number` is written as plain decimal digits (no sign, fraction, exponent or leading zero).
        if ($numberSource === null || preg_match('/\A(0|[1-9][0-9]*)\z/', $numberSource) !== 1) {
            return null;
        }
        if (preg_match('/[?&]expires=([0-9]{1,12})(?:&|\z)/', $salt, $m) !== 1 || (int) $m[1] * 1000 < $nowMs) {
            return null;
        }
        if (hash('sha256', $salt.$number) !== $challenge) {
            return null;
        }
        if (! hash_equals(hash_hmac('sha256', $challenge, $key), $signature)) {
            return null;
        }

        return $signature;
    }

    /**
     * The decoded top-level JSON object and the source text of its `number` member (null when absent), or null when
     * the text is not JSON or not an object.
     *
     * @return array{0: array<array-key, mixed>, 1: ?string}|null
     */
    public static function parseObject(string $text): ?array
    {
        $flags = JSON_INVALID_UTF8_SUBSTITUTE;
        $depth = max(2, strlen($text) + 2);
        $decoded = json_decode($text, true, $depth, $flags);
        if (json_last_error() === JSON_ERROR_UTF16) {
            $text = self::replaceLoneSurrogates($text);
            $decoded = json_decode($text, true, $depth, $flags);
        }
        if (json_last_error() !== JSON_ERROR_NONE || ! is_array($decoded)) {
            return null;
        }
        $start = strspn($text, " \t\n\r");
        if (($text[$start] ?? '') !== '{') {
            return null; // a JSON array
        }

        return [$decoded, self::topLevelNumberSource($text, $start)];
    }

    /**
     * Every `\uD800`–`\uDFFF` escape that is not half of a high-low pair becomes `�` (what Node's UTF-8 encoding
     * of that JavaScript string gives); other escapes are kept (`\\` is consumed as one escape).
     */
    private static function replaceLoneSurrogates(string $text): string
    {
        return (string) preg_replace_callback(
            '/\\\\u[dD][89abAB][0-9a-fA-F]{2}\\\\u[dD][c-fC-F][0-9a-fA-F]{2}|(\\\\u[dD][89a-fA-F][0-9a-fA-F]{2})|\\\\./s',
            fn (array $m): string => isset($m[1]) ? '\\ufffd' : $m[0],
            $text,
        );
    }

    /**
     * The source text of the value of the last member of the top-level object whose key decodes to `number`; '' when
     * that value is not a number token; null when there is no such member. $text is valid JSON starting with `{` at
     * $start.
     */
    private static function topLevelNumberSource(string $text, int $start): ?string
    {
        $n = strlen($text);
        $depth = 0;
        $expectKey = false;
        $source = null;
        for ($i = $start; $i < $n; $i++) {
            $c = $text[$i];
            if ($c === '"') {
                $end = self::stringEnd($text, $i);
                if ($depth === 1 && $expectKey) {
                    $expectKey = false;
                    $key = json_decode(substr($text, $i, $end - $i + 1));
                    $i = $end + 1;
                    $i += strspn($text, " \t\n\r", $i);
                    $i++; // ':'
                    $i += strspn($text, " \t\n\r", $i);
                    if ($key === 'number') {
                        $source = preg_match('/\G-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/', $text, $m, 0, $i) === 1 ? $m[0] : '';
                    }
                    $i--; // the loop's $i++ lands on the value

                    continue;
                }
                $i = $end;
            } elseif ($c === '{' || $c === '[') {
                $depth++;
                $expectKey = $c === '{' && $depth === 1;
            } elseif ($c === '}' || $c === ']') {
                $depth--;
            } elseif ($c === ',' && $depth === 1) {
                $expectKey = true;
            }
        }

        return $source;
    }

    /** The offset of the closing quote of the JSON string opening at $i. */
    private static function stringEnd(string $text, int $i): int
    {
        $n = strlen($text);
        for ($j = $i + 1; $j < $n; $j++) {
            if ($text[$j] === '\\') {
                $j++;
            } elseif ($text[$j] === '"') {
                return $j;
            }
        }

        return $n - 1;
    }
}
