<?php

namespace App\Infrastructure\Import;

/**
 * An import file read (R58; Express sheet.ts `Sheet`): the header (row 1) and the non-empty data rows with their
 * numbers (CSV: the record number; XLSX: the sheet row number; skipped empty rows are counted). `cells` is null for a
 * CSV record whose number of fields differs from the width the reader was bounded to (its fields are not kept);
 * `padShort` — XLSX: a row narrower than the header is padded with empty cells (a sheet stores no empty cells).
 */
final class Sheet
{
    /**
     * @param  list<string|Cell>|null  $header
     * @param  list<array{number: int, cells: list<string|Cell>|null}>  $rows
     */
    public function __construct(
        public readonly ?array $header,
        public readonly array $rows,
        public readonly bool $padShort,
    ) {}
}
