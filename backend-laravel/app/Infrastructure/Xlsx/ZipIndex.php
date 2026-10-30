<?php

namespace App\Infrastructure\Xlsx;

/** The inflated, CRC-checked entries of an archive, by name (Zip::open). */
final class ZipIndex
{
    /** @param  array<string, string>  $parts */
    public function __construct(public readonly array $parts) {}

    public function part(string $name): ?string
    {
        return $this->parts[$name] ?? null;
    }
}
