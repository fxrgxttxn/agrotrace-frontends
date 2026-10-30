<?php

namespace App\Infrastructure\Import;

use App\Infrastructure\Sandbox\Lane;
use App\Infrastructure\Sandbox\LaneOptions;
use App\Infrastructure\Sandbox\LaneRefused;
use App\Infrastructure\Xlsx\XlsxScanner;
use App\Infrastructure\Xlsx\Zip;
use App\Infrastructure\Xlsx\ZipError;

/**
 * Reading an import file (importDictionary, R58; Express sheet.ts `readSheet`): the type is decided by the content,
 * never by the name or the part's Content-Type —
 * - a ZIP (`PK\x03\x04`) is an XLSX workbook. The request thread checks only the ZIP directory (stage 1: ≤ 64
 *   entries, declared ≤ 16 MiB per entry and ≤ 32 MiB in all, "not a workbook", the part caps); everything else runs
 *   in the sandbox (resources/sandbox/xlsx-read.php) behind two bounded lanes (≤ 64 KiB and larger files; 1 running +
 *   8 waiting per container, 10 s from enqueue, 256 MB). A limit, a full lane, the deadline or a child over its memory
 *   → 415 `{allowed, reason: workbook-too-large}`; a ZIP that is no readable workbook → 415 `{allowed}`;
 * - anything else is CSV (CsvReader).
 * The caller holds no DB slot meanwhile (P61).
 */
final class SheetReader
{
    public const SMALL_LANE_BYTES = 65536;

    public const WAITING = 8;

    public const DEADLINE_SEC = 10.0;

    public const MEMORY = '256M';

    /**
     * @param  int  $width  the number of columns the import expects (CSV records are bounded to it)
     * @param  null|callable(): bool  $clientGone
     */
    public static function read(string $bytes, int $width, ?callable $clientGone = null): Sheet
    {
        if (str_starts_with($bytes, "PK\x03\x04")) {
            return self::readXlsx($bytes, $clientGone);
        }

        return CsvReader::read($bytes, $width);
    }

    /** Stage 1 on the request thread: the ZIP directory (declared sizes) and the part caps; nothing is inflated. */
    public static function checkDirectory(string $bytes): void
    {
        try {
            $entries = Zip::directory($bytes);
        } catch (ZipError $e) {
            throw $e->kind === 'tooLarge' ? ImportProblems::tooLarge() : ImportProblems::unsupported();
        }
        $names = array_column($entries, 'name');
        if (! in_array('[Content_Types].xml', $names, true) || ! in_array('xl/workbook.xml', $names, true)) {
            throw ImportProblems::unsupported();
        }
        foreach ($entries as $e) {
            if ($e['size'] > (XlsxScanner::PART_CAPS[$e['name']] ?? PHP_INT_MAX)) {
                throw ImportProblems::tooLarge();
            }
        }
    }

    /** @param  null|callable(): bool  $clientGone */
    private static function readXlsx(string $bytes, ?callable $clientGone): Sheet
    {
        self::checkDirectory($bytes);
        $lane = strlen($bytes) <= self::SMALL_LANE_BYTES ? 'xlsx-small' : 'xlsx-large';
        try {
            $out = Lane::run(
                base_path('resources/sandbox/xlsx-read.php'),
                $bytes,
                new LaneOptions($lane, self::WAITING, self::DEADLINE_SEC, self::MEMORY),
                $clientGone,
            );
        } catch (LaneRefused $e) {
            // too-complex (busy, deadline, a crashed child) → too large; aborted → nobody reads the answer.
            throw $e->reason === 'too-complex' ? ImportProblems::tooLarge() : ImportProblems::unsupported();
        }
        $r = json_decode($out, true);
        if (! is_array($r) || ($r['ok'] ?? false) !== true) {
            $kind = is_array($r) ? ($r['kind'] ?? '') : '';
            throw match ($kind) {
                'tooLarge' => ImportProblems::tooLarge(),
                'tooManyRows' => ImportProblems::tooManyRows(),
                default => ImportProblems::unsupported(),
            };
        }
        $cells = fn (array $list): array => array_map(
            fn (mixed $c): string|Cell => $c === null ? Cell::Invalid : ($c === 1 ? Cell::TooLong : (string) $c),
            $list,
        );

        return new Sheet(
            is_array($r['header']) ? $cells($r['header']) : null,
            array_map(fn (array $row) => ['number' => (int) $row['number'], 'cells' => $cells($row['cells'])], $r['rows']),
            true,
        );
    }
}
