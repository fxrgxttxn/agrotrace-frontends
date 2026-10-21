<?php

namespace App\Infrastructure\Dadata;

/** A DaData party lookup: `found` (name, address), `notFound` or `unavailable`. */
final class DadataResult
{
    private function __construct(
        public readonly string $status,
        public readonly ?string $name = null,
        public readonly ?string $address = null,
    ) {}

    public static function found(string $name, ?string $address): self
    {
        return new self('found', $name, $address);
    }

    public static function notFound(): self
    {
        return new self('notFound');
    }

    public static function unavailable(): self
    {
        return new self('unavailable');
    }
}
