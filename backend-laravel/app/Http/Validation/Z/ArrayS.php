<?php

namespace App\Http\Validation\Z;

/** ZodArray: a JSON array; `min`/`max` (dirty), then every element at `[i]` (an aborted element aborts the array). */
final class ArrayS extends Schema
{
    /** @var array{0: int, 1: string}|null */
    private ?array $min = null;

    /** @var array{0: int, 1: string}|null */
    private ?array $max = null;

    public function __construct(private readonly Schema $element) {}

    public function min(int $n, string $message = 'validation.minItems'): self
    {
        $copy = clone $this;
        $copy->min = [$n, $message];

        return $copy;
    }

    public function max(int $n, string $message = 'validation.maxItems'): self
    {
        $copy = clone $this;
        $copy->max = [$n, $message];

        return $copy;
    }

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if (! is_array($value) || ! array_is_list($value)) {
            return self::typeIssue($value, $path, $issues);
        }
        $status = self::VALID;
        if ($this->min !== null && count($value) < $this->min[0]) {
            $issues->add($path, $this->min[1]);
            $status = self::DIRTY;
        }
        if ($this->max !== null && count($value) > $this->max[0]) {
            $issues->add($path, $this->max[1]);
            $status = self::DIRTY;
        }
        $out = [];
        $aborted = false;
        foreach ($value as $i => $item) {
            [$s, $v] = $this->element->run($item, [...$path, $i], $issues);
            if ($s === self::ABORTED) {
                $aborted = true;
            } elseif ($s === self::DIRTY) {
                $status = self::DIRTY;
            }
            $out[] = $v;
        }

        return $aborted ? [self::ABORTED, null] : [$status, $out];
    }
}
