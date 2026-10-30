<?php

namespace App\Infrastructure\Import;

use App\Http\Problem\Problem;

/**
 * The CSV side of importDictionary (R58; Express sheet.ts `parseCsv`/`toSheet`): UTF-8 (one leading BOM skipped),
 * `;` separators, RFC 4180 quotes — a field is quoted when it starts with `"` (inside, `""` is a quote; separators and
 * line breaks are data); a quote inside an unquoted field is an ordinary character; after a closing quote only `;` or
 * a record end may follow; a quote left open → 400 format. A record ends at LF or CRLF (a lone CR is data); the final
 * line break starts no record. A NUL byte → 415; invalid UTF-8 → 400 format.
 *
 * Bounded: the whole file is parsed (a format error anywhere wins over tooManyRows, as in Express), but a record keeps
 * at most `$width + 1` fields — a 5 MiB record of tiny fields is counted, never materialized — and only the first
 * 10 000 non-empty data rows are kept (the 10 001st → 400 tooManyRows once the file is parsed). Runs of empty fields
 * past the bound are skipped with one `strspn`.
 */
final class CsvReader
{
    public const MAX_DATA_ROWS = 10000;

    /** @throws Problem */
    public static function read(string $bytes, ?int $width = null): Sheet
    {
        if (str_contains($bytes, "\0")) {
            throw ImportProblems::unsupported();
        }
        if (! mb_check_encoding($bytes, 'UTF-8')) {
            throw ImportProblems::badFormat();
        }
        $text = str_starts_with($bytes, "\xEF\xBB\xBF") ? substr($bytes, 3) : $bytes;
        $cap = $width === null ? PHP_INT_MAX : $width + 1;
        $n = strlen($text);
        $header = null;
        $rows = [];
        $tooMany = false;
        if ($n === 0) {
            return new Sheet(null, [], false);
        }
        $record = 0;
        $i = 0;
        for (; ;) {
            // One record starting at $i.
            $fields = [];
            $count = 0;
            $empty = true;
            for (; ;) {
                if ($text[$i] === '"') {
                    $value = '';
                    $j = $i + 1;
                    for (; ;) {
                        $q = strpos($text, '"', $j);
                        if ($q === false) {
                            throw ImportProblems::badFormat();
                        }
                        $value .= substr($text, $j, $q - $j);
                        if ($q + 1 < $n && $text[$q + 1] === '"') {
                            $value .= '"';
                            $j = $q + 2;
                        } else {
                            $j = $q + 1;
                            break;
                        }
                    }
                    $i = $j;
                    if ($i < $n && $text[$i] !== ';' && $text[$i] !== "\n" && ! ($text[$i] === "\r" && $i + 1 < $n && $text[$i + 1] === "\n")) {
                        throw ImportProblems::badFormat();
                    }
                } else {
                    $j = $i;
                    for (; ;) {
                        $j += strcspn($text, ";\n\r", $j);
                        if ($j < $n && $text[$j] === "\r" && ! ($j + 1 < $n && $text[$j + 1] === "\n")) {
                            $j++; // a lone CR is data

                            continue;
                        }
                        break;
                    }
                    $value = substr($text, $i, $j - $i);
                    $i = $j;
                }
                $count++;
                if ($value !== '') {
                    $empty = false;
                }
                if ($count <= $cap) {
                    $fields[] = $value;
                }
                if ($i >= $n) {
                    break;
                }
                if ($text[$i] === ';') {
                    $i++;
                    if ($count >= $cap && $i < $n && $text[$i] === ';') {
                        // Past the bound: a run of separators is a run of empty fields.
                        $k = strspn($text, ';', $i);
                        $count += $k;
                        $i += $k;
                    }
                    if ($i >= $n) {
                        // A trailing separator: one more empty field ends the file.
                        $count++;
                        if ($count <= $cap) {
                            $fields[] = '';
                        }
                        break;
                    }

                    continue;
                }
                $i += $text[$i] === "\r" ? 2 : 1;
                break;
            }
            $record++;
            if ($record === 1) {
                $header = $fields;
            } elseif (! $empty) {
                if (count($rows) === self::MAX_DATA_ROWS) {
                    $tooMany = true;
                } elseif (! $tooMany) {
                    $rows[] = ['number' => $record, 'cells' => $width === null || $count === $width ? $fields : null];
                }
            }
            if ($i >= $n) {
                break;
            }
        }
        if ($tooMany) {
            throw ImportProblems::tooManyRows();
        }

        return new Sheet($header, $rows, false);
    }
}
