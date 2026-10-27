<?php

namespace App\Actions\Reports;

/**
 * The contents of one report (downloadReport), plain data the sandbox renders (resources/sandbox/report-render.php):
 * the PDF title (`AgroTrace — <title>`), the file name without the extension, the period line (`Период: <from> —
 * <to> (UTC)` or `Отзыв: <id>`) and the sheets `{name, header: list<string>, rows: list<list<[type, value]>>}`.
 *
 * Cells (Express modules/reports/sheets.ts): `['text', ?string]` — a string; `['int', ?int]` — a count (format `0`);
 * `['mass', ?string]` — kg as the stored decimal string (a number with format `0.000`); `['dec2', ?string]` —
 * percents and `Hours` (a number with format `0.00`); a null value — an empty cell.
 */
final class ReportData
{
    /** @param  list<array{name: string, header: list<string>, rows: list<list<array{0: string, 1: string|int|null}>>}>  $sheets */
    public function __construct(
        public readonly string $title,
        public readonly string $fileBase,
        public readonly string $periodLine,
        public readonly array $sheets,
    ) {}

    /** Whether some sheet holds more than $maxRows data rows (`validation.report.tooManyRows`). */
    public function tooManyRows(int $maxRows): bool
    {
        foreach ($this->sheets as $s) {
            if (count($s['rows']) > $maxRows) {
                return true;
            }
        }

        return false;
    }
}
