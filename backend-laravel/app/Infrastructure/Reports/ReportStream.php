<?php

namespace App\Infrastructure\Reports;

use Generator;
use RuntimeException;

/**
 * The report job as the sandbox child reads it (resources/sandbox/report-render.php; written by
 * App\Actions\Reports\ReportsActions and ReportSpool): JSON lines — the job head (format, titles, instant, font
 * directory), then per sheet a `{"sheet": name, "header": […]}` line and its rows, one `[[type, value], …]` line each.
 * Rows are decoded one at a time, as the renderer asks for them (review I1: the whole report is never one decoded
 * structure in the child either).
 */
final class ReportStream
{
    private ?string $pending = null;

    /** @param  resource  $in */
    public function __construct(private $in) {}

    /** @return array<string, mixed> the job head (the first line) */
    public function head(): array
    {
        $line = $this->next();
        if ($line === null) {
            throw new RuntimeException('the report job is empty');
        }
        $head = json_decode($line, true, 16, JSON_THROW_ON_ERROR);
        if (! is_array($head)) {
            throw new RuntimeException('the report job head is not an object');
        }

        return $head;
    }

    /**
     * The sheets in order, each with a lazy generator of its rows (to be read before the next sheet; rows left unread
     * are skipped).
     *
     * @return Generator<int, array{name: string, header: list<string>, rows: Generator<int, list<array{0: string, 1: string|int|null}>>}>
     */
    public function sheets(): Generator
    {
        while (($line = $this->next()) !== null) {
            if (! str_starts_with($line, '{')) {
                continue; // a row of the previous sheet its renderer did not read
            }
            $d = json_decode($line, true, 16, JSON_THROW_ON_ERROR);
            yield ['name' => (string) $d['sheet'], 'header' => array_map('strval', $d['header']), 'rows' => $this->rows()];
        }
    }

    /** @return Generator<int, list<array{0: string, 1: string|int|null}>> */
    private function rows(): Generator
    {
        while (($line = $this->next()) !== null) {
            if (str_starts_with($line, '{')) {
                $this->pending = $line;

                return;
            }
            yield json_decode($line, true, 16, JSON_THROW_ON_ERROR);
        }
    }

    private function next(): ?string
    {
        if ($this->pending !== null) {
            [$line, $this->pending] = [$this->pending, null];

            return $line;
        }
        $line = fgets($this->in);
        if ($line === false || $line === "\n" || $line === '') {
            return null;
        }

        return rtrim($line, "\n");
    }
}
