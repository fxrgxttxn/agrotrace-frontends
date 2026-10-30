<?php

namespace App\Http\Validation\Z;

use App\Http\Validation\Ecma;

/**
 * ZodString: a JSON string, then EVERY check in order (each failing one adds its issue; the value stays usable).
 * `min`/`max` count UTF-16 code units, as JavaScript's `.length` (packages/validation measures code points with its
 * own refinements, R36). Patterns are JavaScript regular expressions (Ecma), a search as RegExp#test is.
 */
final class StringS extends Schema
{
    /** Zod 3.25 `emailRegex`. */
    public const EMAIL = "^(?!\\.)(?!.*\\.\\.)([A-Z0-9_'+\\-\\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\\-]*\\.)+[A-Z]{2,}$";

    /** Zod 3.25 `uuidRegex`. */
    public const UUID = '^[0-9a-fA-F]{8}\\b-[0-9a-fA-F]{4}\\b-[0-9a-fA-F]{4}\\b-[0-9a-fA-F]{4}\\b-[0-9a-fA-F]{12}$';

    /** Zod 3.25 `datetimeRegex({offset: false, local: false})` (leap years included). */
    public const DATETIME = '^(?!0000-)((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?(Z)$';

    /** @var list<array{0: string, 1: mixed, 2: string}> kind, argument, message */
    private array $checks = [];

    public function min(int $n, string $message = 'validation.minLength'): self
    {
        return $this->with(['min', $n, $message]);
    }

    public function max(int $n, string $message = 'validation.maxLength'): self
    {
        return $this->with(['max', $n, $message]);
    }

    public function email(string $message = 'validation.invalid'): self
    {
        return $this->with(['regex', Ecma::compile(self::EMAIL, 'i'), $message]);
    }

    public function uuid(string $message = 'validation.invalid'): self
    {
        return $this->with(['regex', Ecma::compile(self::UUID, 'i'), $message]);
    }

    public function datetime(string $message = 'validation.invalid'): self
    {
        return $this->with(['regex', Ecma::compile(self::DATETIME), $message]);
    }

    /** A JavaScript regular expression source (no delimiters). */
    public function regex(string $jsPattern, string $message = 'validation.invalid'): self
    {
        return $this->with(['regex', Ecma::compile($jsPattern), $message]);
    }

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if (! is_string($value)) {
            return self::typeIssue($value, $path, $issues);
        }
        $status = self::VALID;
        foreach ($this->checks as [$kind, $arg, $message]) {
            $ok = match ($kind) {
                'min' => self::jsLength($value) >= $arg,
                'max' => self::jsLength($value) <= $arg,
                default => Ecma::test($arg, $value),
            };
            if (! $ok) {
                $issues->add($path, $message);
                $status = self::DIRTY;
            }
        }

        return [$status, $value];
    }

    /** JavaScript `.length`: UTF-16 code units. */
    public static function jsLength(string $s): int
    {
        return intdiv(strlen((string) mb_convert_encoding($s, 'UTF-16LE', 'UTF-8')), 2);
    }

    /** R36: the length in Unicode code points. */
    public static function codePoints(string $s): int
    {
        return mb_strlen($s, 'UTF-8');
    }

    /** @param  array{0: string, 1: mixed, 2: string}  $check */
    private function with(array $check): self
    {
        $copy = clone $this;
        $copy->checks[] = $check;

        return $copy;
    }
}
