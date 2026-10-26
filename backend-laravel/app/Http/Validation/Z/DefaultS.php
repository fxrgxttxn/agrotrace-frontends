<?php

namespace App\Http\Validation\Z;

/** ZodDefault: an absent value becomes $default (no check); anything else goes to the inner schema. */
final class DefaultS extends Schema
{
    public function __construct(private readonly Schema $inner, private readonly mixed $default) {}

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if ($value === Missing::Undefined) {
            return [self::VALID, $this->default];
        }

        return $this->inner->run($value, $path, $issues);
    }
}
