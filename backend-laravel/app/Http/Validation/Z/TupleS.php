<?php

namespace App\Http\Validation\Z;

/**
 * ZodTuple (Zod 3.25, no rest): a JSON array; fewer items than the tuple → `validation.minItems` and aborts; more →
 * `validation.maxItems` (dirty) and the extra items are not parsed; then every item at `[i]` (an aborted item aborts).
 */
final class TupleS extends Schema
{
    /** @param  list<Schema>  $items */
    public function __construct(private readonly array $items) {}

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if (! is_array($value) || ! array_is_list($value)) {
            return self::typeIssue($value, $path, $issues);
        }
        $n = count($this->items);
        if (count($value) < $n) {
            $issues->add($path, 'validation.minItems');

            return [self::ABORTED, null];
        }
        $status = self::VALID;
        if (count($value) > $n) {
            $issues->add($path, 'validation.maxItems');
            $status = self::DIRTY;
        }
        $out = [];
        $aborted = false;
        foreach ($this->items as $i => $schema) {
            [$s, $v] = $schema->run($value[$i], [...$path, $i], $issues);
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
