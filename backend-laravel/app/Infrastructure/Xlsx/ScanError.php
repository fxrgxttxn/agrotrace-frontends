<?php

namespace App\Infrastructure\Xlsx;

use RuntimeException;

/** The XLSX pre-scan refused a part: not namespace-well-formed or not SpreadsheetML (`malformed`), or a limit (`tooLarge`). */
final class ScanError extends RuntimeException
{
    public function __construct(public readonly string $kind)
    {
        parent::__construct("xlsx scan: {$kind}");
    }
}
