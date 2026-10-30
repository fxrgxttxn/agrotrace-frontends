<?php

namespace App\Http\Validation\Z;

/** ZodNumber: a JSON number; `int()` (a float with a fraction is `validation.type`), `min`, `max` (inclusive). */
final class NumberS extends Schema
{
    /** @var list<array{0: string, 1: int|float|null, 2: string}> */
    private array $checks = [];

    public function int(): self
    {
        return $this->with(['int', null, 'validation.type']);
    }

    public function min(int|float $n, string $message = 'validation.min'): self
    {
        return $this->with(['min', $n, $message]);
    }

    public function max(int|float $n, string $message = 'validation.max'): self
    {
        return $this->with(['max', $n, $message]);
    }

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if (! is_int($value) && ! is_float($value)) {
            return self::typeIssue($value, $path, $issues);
        }
        $status = self::VALID;
        foreach ($this->checks as [$kind, $arg, $message]) {
            $ok = match ($kind) {
                'int' => is_int($value) || (is_finite($value) && floor($value) === $value),
                'min' => $value >= $arg,
                default => $value <= $arg,
            };
            if (! $ok) {
                $issues->add($path, $message);
                $status = self::DIRTY;
            }
        }

        return [$status, is_float($value) && floor($value) === $value && abs($value) < 2 ** 53 ? (int) $value : $value];
    }

    /** @param  array{0: string, 1: int|float|null, 2: string}  $check */
    private function with(array $check): self
    {
        $copy = clone $this;
        $copy->checks[] = $check;

        return $copy;
    }
}
