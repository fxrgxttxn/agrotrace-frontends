<?php

namespace App\Domain;

use App\Http\Validation\Ecma;

/**
 * BR-11 (@agrotrace/domain idempotency.ts): the key must match `^[A-Za-z0-9_-]{8,128}$` — with ECMA semantics, so a
 * key with a trailing "\n" is invalid (PCRE's `$` would accept it without the `D` flag, R2/R21).
 */
final class Idempotency
{
    public const KEY_PATTERN = '^[A-Za-z0-9_-]{8,128}$';

    /**
     * @param  array{key: string, stored: array{fingerprint: string}|null, fingerprint: string}  $i
     * @return array{decision: 'INVALID_KEY'|'EXECUTE'|'REPLAY'|'CONFLICT'}
     */
    public static function decision(array $i): array
    {
        if (! Ecma::test(Ecma::compile(self::KEY_PATTERN), $i['key'])) {
            return ['decision' => 'INVALID_KEY'];
        }
        if ($i['stored'] === null) {
            return ['decision' => 'EXECUTE'];
        }

        return ['decision' => $i['stored']['fingerprint'] === $i['fingerprint'] ? 'REPLAY' : 'CONFLICT'];
    }
}
