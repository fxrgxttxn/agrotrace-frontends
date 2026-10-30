<?php

namespace App\Infrastructure\Xlsx;

/**
 * Stages 2–3 of the XLSX import (contract importDictionary, P23–P28; Express xlsx-read.ts `minimalWorkbook` and
 * xlsx-scan.ts), framework-free — it runs in the sandbox child:
 * - the part caps on the inflated parts (`xl/workbook.xml`, its relationships, `xl/styles.xml` ≤ 1 MiB), "not a
 *   workbook" (no `[Content_Types].xml`, workbook part or its relationships);
 * - the first sheet: the first `<sheet>` of the workbook part whatever its type, its relationship target per OPC;
 *   missing, external, not a worksheet, or no such part → unsupported;
 * - the linear pre-scan of the first sheet, then of the shared strings (SpreadsheetML rules, `r` rules, limits).
 * Part text is strict UTF-8 (a leading BOM dropped, as TextDecoder does).
 */
final class XlsxScanner
{
    public const SPREADSHEETML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

    public const STRICT_SPREADSHEETML = 'http://purl.oclc.org/ooxml/spreadsheetml/main';

    private const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

    private const PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

    public const PART_CAPS = [
        'xl/workbook.xml' => 1048576,
        'xl/_rels/workbook.xml.rels' => 1048576,
        'xl/styles.xml' => 1048576,
    ];

    public const MAX_ROWS = 20000;

    public const MAX_CELLS_PER_ROW = 64;

    public const MAX_STRINGS = 200000;

    public const MAX_RUNS = 200000;

    public const MAX_ROW_NUMBER = 1048576;

    /** @throws XlsxStop */
    public static function scan(ZipIndex $zip): FirstSheet
    {
        foreach ($zip->parts as $name => $data) {
            if (strlen($data) > (self::PART_CAPS[$name] ?? PHP_INT_MAX)) {
                throw new XlsxStop('tooLarge');
            }
        }
        $workbook = $zip->part('xl/workbook.xml');
        $rels = $zip->part('xl/_rels/workbook.xml.rels');
        if ($zip->part('[Content_Types].xml') === null || $workbook === null || $rels === null) {
            throw new XlsxStop('unsupported');
        }
        try {
            $workbookText = self::utf8($workbook);
            $relsText = self::utf8($rels);
            $path = self::firstSheetPath($workbookText, $relsText);
            $sheet = $path !== null ? $zip->part($path) : null;
            if ($sheet === null) {
                throw new XlsxStop('unsupported');
            }
            $sheetText = self::utf8($sheet);
            self::prescanSheet($sheetText);
            $sst = $zip->part('xl/sharedStrings.xml');
            $sstText = $sst !== null ? self::utf8($sst) : null;
            if ($sstText !== null) {
                self::prescanSharedStrings($sstText);
            }
        } catch (ScanError $e) {
            throw new XlsxStop($e->kind === 'tooLarge' ? 'tooLarge' : 'unsupported');
        }

        return new FirstSheet($workbookText, $relsText, $sheetText, $sstText, $zip->part('xl/styles.xml'));
    }

    /** Strict UTF-8, a leading BOM dropped; otherwise unsupported. */
    public static function utf8(string $b): string
    {
        if (! mb_check_encoding($b, 'UTF-8')) {
            throw new XlsxStop('unsupported');
        }

        return str_starts_with($b, "\xEF\xBB\xBF") ? substr($b, 3) : $b;
    }

    /**
     * The SpreadsheetML rules of one part (P26, P27), run on every tag; returns whether the tag is a SpreadsheetML
     * element the caller should look at (other namespaces — `x14:`, `xm:`, `mc:` … — are ignored): the root is $root,
     * unprefixed, declaring the Transitional main namespace as its default; no element declares another default
     * namespace; no element of the main (or Strict) namespace carries a prefix.
     *
     * @return callable(bool, string, bool, string, ?string): bool
     */
    public static function guard(string $root): callable
    {
        $first = true;

        return function (bool $end, string $name, bool $prefixed, string $ns, ?string $defaultNs) use (&$first, $root): bool {
            if (! $end && $first) {
                $first = false;
                if ($name !== $root || $prefixed || $defaultNs !== self::SPREADSHEETML) {
                    throw new ScanError('malformed');
                }

                return true;
            }
            if (! $end && $defaultNs !== null && $defaultNs !== self::SPREADSHEETML) {
                throw new ScanError('malformed');
            }
            if ($ns === self::SPREADSHEETML || $ns === self::STRICT_SPREADSHEETML) {
                if ($prefixed) {
                    throw new ScanError('malformed');
                }

                return true;
            }

            return false;
        };
    }

    /** A relationship target of `xl/workbook.xml` per OPC (absolute, or relative to `xl/` with `.`/`..`). */
    public static function resolveTarget(string $target): ?string
    {
        $absolute = str_starts_with($target, '/');
        $parts = $absolute ? [] : ['xl'];
        foreach (explode('/', $absolute ? substr($target, 1) : $target) as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            if ($seg === '..') {
                if ($parts === []) {
                    return null;
                }
                array_pop($parts);
            } else {
                $parts[] = $seg;
            }
        }

        return $parts === [] ? null : implode('/', $parts);
    }

    /**
     * The archive path of the first sheet (P27); null when its relationship is missing, external or not a worksheet.
     * Both parts must be well-formed; the workbook part must be SpreadsheetML.
     */
    public static function firstSheetPath(string $workbook, string $rels): ?string
    {
        $rid = null;
        $found = false;
        $guard = self::guard('workbook');
        XmlScanner::scan($workbook, fn (string $name) => $name === 'sheet',
            function (bool $end, bool $sc, string $name, bool $prefixed, string $ns, ?string $dns, array $attrs) use ($guard, &$found, &$rid): void {
                if (! $guard($end, $name, $prefixed, $ns, $dns) || $end || $name !== 'sheet' || $found) {
                    return;
                }
                $found = true;
                $rid = $attrs['{'.self::R_NS.'}id'] ?? null;
            });
        if ($rid === null || $rid === '') {
            return null;
        }
        $target = null;
        XmlScanner::scan($rels, fn (string $name) => $name === 'Relationship',
            function (bool $end, bool $sc, string $name, bool $prefixed, string $ns, ?string $dns, array $attrs) use ($rid, &$target): void {
                if ($end || $name !== 'Relationship' || $ns !== self::PKG_NS || ($attrs['Id'] ?? null) !== $rid) {
                    return;
                }
                if (($attrs['Type'] ?? null) !== self::R_NS.'/worksheet' || ($attrs['TargetMode'] ?? null) === 'External') {
                    return;
                }
                $target = self::resolveTarget($attrs['Target'] ?? '');
            });

        return $target;
    }

    /** A row reference: a positive integer without sign, leading zero or fraction, ≤ 1 048 576; else null. */
    public static function rowNumber(string $s): ?int
    {
        $len = strlen($s);
        if ($len === 0 || $len > 7 || $s[0] === '0' || strspn($s, '0123456789') !== $len) {
            return null;
        }
        $n = (int) $s;

        return $n <= self::MAX_ROW_NUMBER ? $n : null;
    }

    /**
     * A cell reference: 1–3 upper-case letters, then its row number; no `$`, no space.
     *
     * @return array{0: int, 1: int}|null column, row
     */
    public static function cellRef(string $s): ?array
    {
        $k = strspn($s, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 0, 4);
        if ($k === 0 || $k > 3) {
            return null;
        }
        $col = 0;
        for ($i = 0; $i < $k; $i++) {
            $col = $col * 26 + (ord($s[$i]) - 64);
        }
        $row = self::rowNumber(substr($s, $k));

        return $row === null ? null : [$col, $row];
    }

    /**
     * The first sheet (P24–P27), in document order; the first violation wins, and on one element a malformed reference
     * wins over a limit: SpreadsheetML rules; every SpreadsheetML `<row>` has an unprefixed `r` (strictly increasing);
     * every `<c>` is inside a `<row>`, with an unprefixed `r` of that row, columns strictly increasing → else malformed;
     * ≤ 20 000 `<row>` (empty ones included), ≤ 64 `<c>` in a row, no cell beyond column 64 (BL) → else too large.
     */
    public static function prescanSheet(string $text): void
    {
        $rows = 0;
        $cells = 0;
        $inRow = false;
        $lastRow = 0;
        $lastCol = 0;
        $guard = self::guard('worksheet');
        XmlScanner::scan($text, fn (string $name) => $name === 'c' || $name === 'row',
            function (bool $end, bool $sc, string $name, bool $prefixed, string $ns, ?string $dns, array $attrs) use ($guard, &$rows, &$cells, &$inRow, &$lastRow, &$lastCol): void {
                if (! $guard($end, $name, $prefixed, $ns, $dns)) {
                    return;
                }
                if ($name === 'row') {
                    if ($end) {
                        $inRow = false;

                        return;
                    }
                    $r = self::rowNumber($attrs['r'] ?? '');
                    if ($r === null || $r <= $lastRow) {
                        throw new ScanError('malformed');
                    }
                    if (++$rows > self::MAX_ROWS) {
                        throw new ScanError('tooLarge');
                    }
                    $lastRow = $r;
                    $lastCol = 0;
                    $cells = 0;
                    $inRow = ! $sc;

                    return;
                }
                if ($name === 'c' && ! $end) {
                    $ref = self::cellRef($attrs['r'] ?? '');
                    if (! $inRow || $ref === null || $ref[1] !== $lastRow || $ref[0] <= $lastCol) {
                        throw new ScanError('malformed');
                    }
                    $lastCol = $ref[0];
                    if (++$cells > self::MAX_CELLS_PER_ROW || $ref[0] > self::MAX_CELLS_PER_ROW) {
                        throw new ScanError('tooLarge');
                    }
                }
            });
    }

    /** The shared strings: SpreadsheetML (root `sst`); ≤ 200 000 `<si>` and ≤ 200 000 rich-text runs `<r>`. */
    public static function prescanSharedStrings(string $text): void
    {
        $strings = 0;
        $runs = 0;
        $guard = self::guard('sst');
        XmlScanner::scan($text, fn () => false,
            function (bool $end, bool $sc, string $name, bool $prefixed, string $ns, ?string $dns) use ($guard, &$strings, &$runs): void {
                if (! $guard($end, $name, $prefixed, $ns, $dns) || $end) {
                    return;
                }
                if ($name === 'si' && ++$strings > self::MAX_STRINGS) {
                    throw new ScanError('tooLarge');
                }
                if ($name === 'r' && ++$runs > self::MAX_RUNS) {
                    throw new ScanError('tooLarge');
                }
            });
    }
}
