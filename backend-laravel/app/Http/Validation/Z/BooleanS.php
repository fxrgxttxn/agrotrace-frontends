<?php

namespace App\Http\Validation\Z;

final class BooleanS extends Schema
{
    public function run(mixed $value, array $path, Issues $issues): array
    {
        if (! is_bool($value)) {
            return self::typeIssue($value, $path, $issues);
        }

        return [self::VALID, $value];
    }
}
