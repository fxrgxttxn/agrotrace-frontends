<?php

namespace App\Actions\Reports;

/**
 * One report (downloadReport): the PDF title (`AgroTrace — <title>`), the file name without the extension, the period
 * line (`Период: <from> — <to> (UTC)` or `Отзыв: <id>`) and its sheets, spooled (ReportSpool) — each a name, a header
 * and rows of cells.
 *
 * Cells (Express modules/reports/sheets.ts): `['text', ?string]` — a string; `['int', ?int]` — a count (format `0`);
 * `['mass', ?string]` — kg as the stored decimal string (a number with format `0.000`); `['dec2', ?string]` —
 * percents and `Hours` (a number with format `0.00`); a null value — an empty cell.
 */
final class ReportData
{
    public function __construct(
        public readonly string $title,
        public readonly string $fileBase,
        public readonly string $periodLine,
        public readonly ReportSpool $spool,
    ) {}

    /** Whether some sheet holds more than $maxRows data rows (`validation.report.tooManyRows`). */
    public function tooManyRows(int $maxRows): bool
    {
        foreach ($this->spool->counts() as $n) {
            if ($n > $maxRows) {
                return true;
            }
        }

        return false;
    }
}
