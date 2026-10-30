<?php

namespace App\Infrastructure\Xlsx;

use RuntimeException;

/** The reading of a workbook ends with `tooLarge`, `unsupported` or `tooManyRows` (Express xlsx-read.ts `Stop`). */
final class XlsxStop extends RuntimeException
{
    public function __construct(public readonly string $kind)
    {
        parent::__construct($kind);
    }
}
