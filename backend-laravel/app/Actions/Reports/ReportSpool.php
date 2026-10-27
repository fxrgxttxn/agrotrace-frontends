<?php

namespace App\Actions\Reports;

use RuntimeException;

/**
 * The rows of a report on their way to the renderer (review I1 of Task 13): JSON lines in a temporary stream (memory up
 * to 1 MiB, then a temporary file PHP removes with the stream) — `{"sheet": name, "header": […]}` opens a sheet, every
 * other line is one row of `[type, value]` cells (ReportData). The request thread never holds a whole report: rows are
 * written as they are fetched (Sheets, a server-side cursor in chunks) and the stream is copied to the child's stdin
 * after the DB slot was released (P61). The child reads it with App\Infrastructure\Reports\ReportStream.
 */
final class ReportSpool
{
    /** @var resource */
    private $stream;

    /** @var list<int> data rows per sheet */
    private array $counts = [];

    public function __construct()
    {
        $s = fopen('php://temp/maxmemory:'.(1 << 20), 'w+b');
        if ($s === false) {
            throw new RuntimeException('no temporary stream for the report rows');
        }
        $this->stream = $s;
    }

    /** @param  list<string>  $header */
    public function sheet(string $name, array $header): void
    {
        $this->line(['sheet' => $name, 'header' => $header]);
        $this->counts[] = 0;
    }

    /** @param  list<array{0: string, 1: string|int|null}>  $cells */
    public function row(array $cells): void
    {
        $this->line($cells);
        $this->counts[count($this->counts) - 1]++;
    }

    /** @return list<int> */
    public function counts(): array
    {
        return $this->counts;
    }

    /**
     * The spooled lines from the start (the caller reads it to EOF).
     *
     * @return resource
     */
    public function stream()
    {
        rewind($this->stream);

        return $this->stream;
    }

    public function close(): void
    {
        if (is_resource($this->stream)) {
            fclose($this->stream);
        }
    }

    public function __destruct()
    {
        $this->close();
    }

    private function line(mixed $value): void
    {
        $json = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";
        if (fwrite($this->stream, $json) !== strlen($json)) {
            throw new RuntimeException('cannot spool the report rows');
        }
    }
}
