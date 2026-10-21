<?php

namespace App\Http\Validation\Z;

use App\Http\Problem\Problem;
use stdClass;

/**
 * A port of the Zod 3 parse semantics packages/validation relies on (L7) — so a body gets exactly the 400 errors the
 * shared Zod schemas give it in Express:
 * - every node returns a status: `valid`, `dirty` (issues, value still usable — refinements outside still run) or
 *   `aborted` (a type error, a bad enum value…: the enclosing object/array aborts, its refinements are skipped);
 * - string checks all run (each failing one adds its issue); refinements run unless the inner schema aborted;
 *   transforms only on a valid inner value;
 * - the error map of packages/validation/src/common.ts: missing → `validation.required`, wrong type →
 *   `validation.type`, enum/literal → `validation.enum`, unknown key → `validation.unknownField` (one per key, after
 *   the shape's own issues), too small/big → minLength/maxLength, minItems/maxItems, min/max.
 * Input is the JSON decoded with objects as stdClass; an absent property is Missing::Undefined. Output: associative
 * arrays for objects (absent optional keys left out), lists for arrays.
 */
abstract class Schema
{
    public const VALID = 'valid';

    public const DIRTY = 'dirty';

    public const ABORTED = 'aborted';

    /**
     * @param  list<string|int>  $path
     * @return array{0: string, 1: mixed} status and value
     */
    abstract public function run(mixed $value, array $path, Issues $issues): array;

    public function optional(): OptionalS
    {
        return new OptionalS($this);
    }

    public function nullable(): NullableS
    {
        return new NullableS($this);
    }

    /** `.refine(check, message)`; $message may be a callable of the value (Zod's message function). */
    public function refine(callable $check, string|callable $message): Effects
    {
        return Effects::refinement($this, function (mixed $v, array $path, Issues $issues) use ($check, $message): bool {
            if ($check($v)) {
                return true;
            }
            $issues->add($path, is_string($message) ? $message : $message($v));

            return false;
        });
    }

    /** `.superRefine((value, ctx) => …)`: $fn(value, add(message, pathSuffix = [])). */
    public function superRefine(callable $fn): Effects
    {
        return Effects::refinement($this, function (mixed $v, array $path, Issues $issues) use ($fn): bool {
            $ok = true;
            $fn($v, function (string $message, array $suffix = []) use ($path, $issues, &$ok): void {
                $issues->add([...$path, ...$suffix], $message);
                $ok = false;
            });

            return $ok;
        });
    }

    public function transform(callable $fn): Effects
    {
        return Effects::transformation($this, $fn);
    }

    /**
     * The parsed value, or the issues.
     *
     * @return array{ok: bool, value: mixed, issues: Issues}
     */
    public function safeParse(mixed $value): array
    {
        $issues = new Issues;
        [$status, $out] = $this->run($value, [], $issues);
        $ok = $status === self::VALID && $issues->empty();

        return ['ok' => $ok, 'value' => $ok ? $out : null, 'issues' => $issues];
    }

    /** The parsed value; 400 VALIDATION with the field errors otherwise. */
    public function parse(mixed $value): mixed
    {
        $r = $this->safeParse($value);
        if (! $r['ok']) {
            throw Problem::validation($r['issues']->fieldErrors());
        }

        return $r['value'];
    }

    /**
     * @param  list<string|int>  $path
     * @return array{0: string, 1: null}
     */
    protected static function typeIssue(mixed $value, array $path, Issues $issues): array
    {
        $issues->add($path, $value === Missing::Undefined ? 'validation.required' : 'validation.type');

        return [self::ABORTED, null];
    }

    /** JSON Schema / Zod parsed type of a decoded JSON value. */
    public static function isObject(mixed $v): bool
    {
        return $v instanceof stdClass;
    }
}
