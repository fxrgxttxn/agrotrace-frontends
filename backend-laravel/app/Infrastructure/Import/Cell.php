<?php

namespace App\Infrastructure\Import;

/**
 * A cell the import reports whatever the column's rule: an XLSX cell of another type (date, boolean, error) —
 * `validation.pattern`; an XLSX cell over 1 000 characters (P25, its text never left the sandbox) — `validation.maxLength`.
 */
enum Cell
{
    case Invalid;
    case TooLong;

    public function message(): string
    {
        return $this === self::Invalid ? 'validation.pattern' : 'validation.maxLength';
    }
}
