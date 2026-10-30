<?php

namespace App\Http\Validation\Z;

final class NullableS extends Schema
{
    public function __construct(public readonly Schema $inner) {}

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if ($value === null) {
            return [self::VALID, null];
        }

        return $this->inner->run($value, $path, $issues);
    }
}
