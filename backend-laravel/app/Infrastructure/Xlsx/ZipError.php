<?php

namespace App\Infrastructure\Xlsx;

use RuntimeException;

/** An archive breaks a limit (`tooLarge`) or is not a readable ZIP (`invalid`). */
final class ZipError extends RuntimeException
{
    public function __construct(public readonly string $kind)
    {
        parent::__construct("zip: {$kind}");
    }
}
