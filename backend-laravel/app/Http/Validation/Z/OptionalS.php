<?php

namespace App\Http\Validation\Z;

final class OptionalS extends Schema
{
    public function __construct(public readonly Schema $inner) {}

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if ($value === Missing::Undefined) {
            return [self::VALID, Missing::Undefined];
        }

        return $this->inner->run($value, $path, $issues);
    }
}
