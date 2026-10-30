<?php

namespace App\Http;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use Illuminate\Http\Request;

/**
 * `If-Match` (components/parameters.yaml#/IfMatch; Express http/if-match.ts): the entity's current `version` as a bare
 * integer (no quotes, no `W/`), required. Read with the other parameters (400 VALIDATION under `errors["If-Match"]`):
 * missing or empty → `validation.required`, not 1–10 decimal digits → `validation.type`, below 1 → `validation.min`;
 * an operation with a body reports them in the same 400 as the body's schema errors (P36: `read` + Body::parse
 * `$extraErrors`). The comparison is a compare-and-set against the LOCKED row (R47): `check` inside the transaction.
 */
final class IfMatch
{
    public const HEADER = 'If-Match';

    /**
     * The header's version, or null with its errors added to $errors (not thrown — merged with the body's errors).
     *
     * @param  array<string, list<string>>  $errors
     */
    public static function read(Request $request, array &$errors): ?int
    {
        $raw = $request->headers->get(self::HEADER);
        if ($raw === null || $raw === '') {
            $errors[self::HEADER] = ['validation.required'];

            return null;
        }
        if (strlen($raw) > 10 || ! ctype_digit($raw)) {
            $errors[self::HEADER] = ['validation.type'];

            return null;
        }
        if ((int) $raw < 1) {
            $errors[self::HEADER] = ['validation.min'];

            return null;
        }

        return (int) $raw;
    }

    /** The version, or the 400 at once (operations without a body). */
    public static function version(Request $request): int
    {
        $errors = [];
        $v = self::read($request, $errors);
        if ($v === null) {
            throw Problem::validation($errors);
        }

        return $v;
    }

    /** 409 VERSION_CONFLICT `{currentVersion}` when the locked row's version differs from `If-Match`. */
    public static function check(int $expected, int $current): void
    {
        if ($expected !== $current) {
            throw new Problem(409, ProblemCode::VERSION_CONFLICT, params: ['currentVersion' => $current]);
        }
    }
}
