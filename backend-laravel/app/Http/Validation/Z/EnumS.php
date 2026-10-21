<?php

namespace App\Http\Validation\Z;

/** ZodEnum (strings) and ZodLiteral (one value): a value outside the set is `validation.enum` and aborts. */
final class EnumS extends Schema
{
    /** @param  list<string|int|bool>  $values */
    public function __construct(public readonly array $values, private readonly bool $literal = false) {}

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if (! $this->literal && ! is_string($value)) {
            return self::typeIssue($value, $path, $issues);
        }
        if (! in_array($value, $this->values, true)) {
            $issues->add($path, 'validation.enum');

            return [self::ABORTED, null];
        }

        return [self::VALID, $value];
    }
}
