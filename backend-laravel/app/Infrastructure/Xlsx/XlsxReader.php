<?php

namespace App\Infrastructure\Xlsx;

use App\Support\JsNumber;
use XMLReader;

/**
 * Stage 4 of the XLSX import (L13; Express xlsx-read.ts `readWorkbook`): the reading of a pre-scanned workbook on
 * XMLReader (libxml2; entities never expanded, see `open`), framework-free — it runs in the sandbox child (resources/sandbox/
 * xlsx-read.php). Every part read must be well-formed XML 1.0 (what saxes enforces for exceljs; the pre-scan checked
 * the namespace rules). The cells follow exceljs where the contract agrees with it:
 * - a shared string (`t="s"`) or an inline string (`t="inlineStr"`, `<is>`) — its text as is; rich text — its runs
 *   concatenated (phonetic `<rPh>` runs left out); `t="str"` — the text of `<v>`;
 * - a number (`t` absent or `n`) — `JsNumber::plain` of parseFloat; a number whose style (the cell's, or for a cell
 *   with a falsy `s` its row's) has a date format (exceljs `isDateFmt`) → INVALID;
 * - `t="b"`, `t="e"`, `t="d"` → INVALID (`validation.pattern`);
 * - a formula — its cached result typed as above (`t="str"` text, `b`/`e` INVALID, otherwise a number); none → '';
 * - trailing empty cells dropped; a cell over 1 000 code points → TOO_LONG (its text is not kept).
 * Result (P25, P26): the header (row 1, if the first row read is row 1) and the non-empty data rows up to row 10 001
 * (`tooManyRows` at the 10 001st, reading stops); over 8 MiB of kept text → `tooLarge` once the sheet is read.
 * `xl/styles.xml` is read as exceljs reads it with saxes: a DOCTYPE is skipped without processing its declarations,
 * so a reference to an entity it declares is undefined (unsupported).
 */
final class XlsxReader
{
    /** A cell of another type (date, boolean, error): `validation.pattern`. */
    public const INVALID = null;

    /** A cell over 1 000 characters: `validation.maxLength`. */
    public const TOO_LONG = 1;

    public const MAX_DATA_ROWS = 10000;

    public const MAX_CELL_CHARS = 1000;

    public const MAX_RESULT_BYTES = 8 * 1024 * 1024;

    private const NS = XlsxScanner::SPREADSHEETML;

    private const DEFAULT_FORMATS = [
        0 => 'General', 1 => '0', 2 => '0.00', 3 => '#,##0', 4 => '#,##0.00', 9 => '0%', 10 => '0.00%',
        11 => '0.00E+00', 12 => '# ?/?', 13 => '# ??/??', 14 => 'mm-dd-yy', 15 => 'd-mmm-yy', 16 => 'd-mmm',
        17 => 'mmm-yy', 18 => 'h:mm AM/PM', 19 => 'h:mm:ss AM/PM', 20 => 'h:mm', 21 => 'h:mm:ss',
        22 => 'm/d/yy "h":mm', 37 => '#,##0 ;(#,##0)', 38 => '#,##0 ;[Red](#,##0)', 39 => '#,##0.00 ;(#,##0.00)',
        40 => '#,##0.00 ;[Red](#,##0.00)', 45 => 'mm:ss', 46 => '[h]:mm:ss', 47 => 'mmss.0', 48 => '##0.0E+0',
        49 => '@',
    ];

    private const TEXT_NODES = [XMLReader::TEXT => true, XMLReader::CDATA => true, XMLReader::WHITESPACE => true,
        XMLReader::SIGNIFICANT_WHITESPACE => true];

    /**
     * The whole job of the sandbox child: stages 2–4 of a workbook's bytes. Never throws.
     *
     * @return array{ok: true, header: list<string|int|null>|null, rows: list<array{number: int, cells: list<string|int|null>}>}|array{ok: false, kind: string}
     */
    public static function readWorkbook(string $bytes): array
    {
        try {
            try {
                $zip = Zip::open($bytes);
            } catch (ZipError $e) {
                throw new XlsxStop($e->kind === 'tooLarge' ? 'tooLarge' : 'unsupported');
            }

            return ['ok' => true, ...self::read(XlsxScanner::scan($zip))];
        } catch (XlsxStop $e) {
            return ['ok' => false, 'kind' => $e->kind];
        } catch (\Throwable) {
            return ['ok' => false, 'kind' => 'unsupported'];
        }
    }

    /**
     * @return array{header: list<string|int|null>|null, rows: list<array{number: int, cells: list<string|int|null>}>}
     *
     * @throws XlsxStop
     */
    public static function read(FirstSheet $s): array
    {
        $styles = $s->styles !== null ? self::styles($s->styles) : [];
        self::wellFormed($s->workbook);
        self::wellFormed($s->rels);
        $strings = $s->sharedStrings !== null ? self::sharedStrings($s->sharedStrings) : [];

        return self::sheet($s->sheet, $strings, $styles);
    }

    /** exceljs `isDateFmt`: after removing `[…]` and `"…"`, any of `ymdhMsb`. */
    public static function isDateFormat(?string $fmt): bool
    {
        if ($fmt === null || $fmt === '') {
            return false;
        }
        $fmt = self::strip($fmt, '[', ']');
        $fmt = self::strip($fmt, '"', '"');

        return strpbrk($fmt, 'ymdhMsb') !== false;
    }

    /** `s.replace(/<open>[^<close>]*<close>/g, '')`. */
    private static function strip(string $s, string $open, string $close): string
    {
        $out = '';
        $i = 0;
        for (; ;) {
            $a = strpos($s, $open, $i);
            if ($a === false) {
                return $out.substr($s, $i);
            }
            $b = strpos($s, $close, $a + 1);
            if ($b === false) {
                return $out.substr($s, $i);
            }
            $out .= substr($s, $i, $a - $i);
            $i = $b + 1;
        }
    }

    /**
     * The number format of every cell style (`cellXfs` index → format code or null), as exceljs's StylesXform builds
     * it; not readable → unsupported.
     *
     * @return list<?string>
     */
    public static function styles(string $bytes): array
    {
        $text = self::withoutDoctype(mb_convert_encoding($bytes, 'UTF-8', 'UTF-8'));
        $custom = [];
        $xfs = [];
        $path = [];
        $r = self::open($text, false);
        while (self::step($r)) {
            $type = $r->nodeType;
            if ($type === XMLReader::ELEMENT) {
                $name = $r->name;
                if ($name === 'numFmt' && in_array('numFmts', $path, true)) {
                    $code = $r->getAttribute('formatCode');
                    if ($code === null) {
                        throw new XlsxStop('unsupported'); // exceljs fails on such a style sheet
                    }
                    $id = JsNumber::parseInt((string) $r->getAttribute('numFmtId'));
                    if ($id !== null) {
                        $custom[$id] = self::unescape($code);
                    }
                } elseif ($name === 'xf' && $path !== [] && end($path) === 'cellXfs') {
                    $xfs[] = JsNumber::parseInt((string) $r->getAttribute('numFmtId'));
                }
                if (! $r->isEmptyElement) {
                    $path[] = $name;
                }
            } elseif ($type === XMLReader::END_ELEMENT) {
                array_pop($path);
            }
        }
        self::close($r);
        $out = [];
        foreach ($xfs as $fid) {
            $out[] = $fid ? (($custom[$fid] ?? '') !== '' ? $custom[$fid] : (self::DEFAULT_FORMATS[$fid] ?? null)) : null;
        }

        return $out;
    }

    /** exceljs NumFmtXform: `formatCode.replace(/\\(.)/g, '$1')` (`.` is not a line terminator). */
    private static function unescape(string $s): string
    {
        if (! str_contains($s, '\\')) {
            return $s;
        }
        $out = '';
        $n = strlen($s);
        for ($i = 0; $i < $n; $i++) {
            if ($s[$i] === '\\' && $i + 1 < $n && $s[$i + 1] !== "\n" && $s[$i + 1] !== "\r"
                && substr($s, $i + 1, 3) !== "\u{2028}" && substr($s, $i + 1, 3) !== "\u{2029}") {
                $i++;
            }
            $out .= $s[$i];
        }

        return $out;
    }

    /**
     * The styles part with its DOCTYPE blanked out: saxes (exceljs) skips the DOCTYPE without processing its
     * declarations — so an entity it declares stays undefined (libxml2 then refuses a reference to it, as saxes does)
     * and nothing is fetched or expanded. The prolog is read token by token as saxes reads it (review I1 of Tasks 4+5:
     * a substring search let a decoy `<!DOCTYPE` inside a comment or a PI hide the real one): an optional BOM, then
     * whitespace, comments, PIs (the XML declaration among them) and at most one DOCTYPE — a second one is misplaced
     * for saxes (`inappropriately located doctype`) → unsupported. The scan stops at anything else (the root element,
     * or text and other markup libxml2 refuses); a DOCTYPE libxml2 meets there is refused by `step()`. An unterminated
     * comment, PI or DOCTYPE → unsupported.
     */
    public static function withoutDoctype(string $text): string
    {
        $span = self::prologDoctype($text);
        if ($span === null) {
            return $text;
        }
        [$start, $end] = $span;

        return substr($text, 0, $start).str_repeat(' ', $end - $start).substr($text, $end);
    }

    /**
     * [start, end) of the prolog's DOCTYPE, or null when the prolog has none.
     *
     * @return array{int, int}|null
     *
     * @throws XlsxStop
     */
    public static function prologDoctype(string $text): ?array
    {
        $n = strlen($text);
        $i = str_starts_with($text, "\xEF\xBB\xBF") ? 3 : 0;
        $span = null;
        for (; ;) {
            $i += strspn($text, " \t\r\n", $i);
            if ($i + 1 >= $n || $text[$i] !== '<') {
                return $span;
            }
            if ($text[$i + 1] === '?') {
                $i = self::after($text, '?>', $i + 2);
            } elseif (substr_compare($text, '<!--', $i, 4) === 0) {
                $i = self::after($text, '-->', $i + 4);
            } elseif (substr_compare($text, '<!DOCTYPE', $i, 9) === 0) {
                if ($span !== null) {
                    throw new XlsxStop('unsupported'); // a second DOCTYPE
                }
                $end = self::doctypeEnd($text, $i + 9);
                $span = [$i, $end];
                $i = $end;
            } else {
                return $span; // the root element, or markup libxml2 refuses before any DOCTYPE
            }
        }
    }

    /**
     * The offset after the `>` that ends a DOCTYPE whose name starts at $i — saxes's states: S_DOCTYPE (quotes; `[`
     * opens the internal subset; `>` ends it) and in the subset S_DTD (quotes, `<!--` comments, `<?` PIs; `]` closes
     * it).
     *
     * @throws XlsxStop
     */
    private static function doctypeEnd(string $text, int $i): int
    {
        $n = strlen($text);
        $subset = false;
        while ($i < $n) {
            $c = $text[$i];
            if ($c === '"' || $c === "'") {
                $i = self::after($text, $c, $i + 1);

                continue;
            }
            if ($subset) {
                if ($c === ']') {
                    $subset = false;
                } elseif ($c === '<' && substr_compare($text, '<!--', $i, 4) === 0) {
                    // saxes: the first `--` must end the comment (`-->`), else "malformed comment" → unsupported.
                    $i = self::after($text, '--', $i + 4);
                    if (($text[$i] ?? '') !== '>') {
                        throw new XlsxStop('unsupported');
                    }
                    $i++;

                    continue;
                } elseif ($c === '<' && ($text[$i + 1] ?? '') === '?') {
                    $i = self::after($text, '?>', $i + 2);

                    continue;
                }
            } elseif ($c === '[') {
                $subset = true;
            } elseif ($c === '>') {
                return $i + 1;
            }
            $i++;
        }
        throw new XlsxStop('unsupported');
    }

    /**
     * The offset after the first $token at or after $i.
     *
     * @throws XlsxStop when there is none (unterminated)
     */
    private static function after(string $text, string $token, int $i): int
    {
        $p = $i <= strlen($text) ? strpos($text, $token, $i) : false;
        if ($p === false) {
            throw new XlsxStop('unsupported');
        }

        return $p + strlen($token);
    }

    /** XML 1.0 well-formedness of a part (a full XMLReader pass). */
    public static function wellFormed(string $text): void
    {
        $r = self::open($text);
        while (self::step($r)) {
            // nothing: errors are collected by libxml2
        }
        self::close($r);
    }

    /**
     * The texts of the `<si>` items (runs concatenated, `<rPh>` left out).
     *
     * @return list<string>
     */
    public static function sharedStrings(string $text): array
    {
        $strings = [];
        $buf = null;
        $t = 0;
        $rph = 0;
        $r = self::open($text);
        while (self::step($r)) {
            $type = $r->nodeType;
            if ($type === XMLReader::ELEMENT) {
                if ($r->namespaceURI !== self::NS) {
                    continue;
                }
                $name = $r->localName;
                $empty = $r->isEmptyElement;
                if ($name === 'si') {
                    if ($empty) {
                        $strings[] = '';
                    } else {
                        $buf = '';
                    }
                } elseif ($name === 't' && ! $empty) {
                    $t++;
                } elseif ($name === 'rPh' && ! $empty) {
                    $rph++;
                }
            } elseif ($type === XMLReader::END_ELEMENT) {
                if ($r->namespaceURI !== self::NS) {
                    continue;
                }
                $name = $r->localName;
                if ($name === 't') {
                    $t--;
                } elseif ($name === 'rPh') {
                    $rph--;
                } elseif ($name === 'si') {
                    $strings[] = $buf ?? '';
                    $buf = null;
                }
            } elseif ($buf !== null && $t > 0 && $rph === 0 && isset(self::TEXT_NODES[$type])) {
                $buf .= $r->value;
            }
        }
        self::close($r);

        return $strings;
    }

    /**
     * @param  list<string>  $strings
     * @param  list<?string>  $styles
     * @return array{header: list<string|int|null>|null, rows: list<array{number: int, cells: list<string|int|null>}>}
     */
    public static function sheet(string $text, array $strings, array $styles): array
    {
        $st = new SheetState($strings, $styles);
        $r = self::open($text);
        $tooMany = false;
        while (self::step($r)) {
            $type = $r->nodeType;
            if ($type === XMLReader::ELEMENT) {
                if ($r->namespaceURI !== self::NS) {
                    continue;
                }
                $name = $r->localName;
                $empty = $r->isEmptyElement;
                if ($name === 'row') {
                    if ($st->inSheetData) {
                        $st->row = (int) $r->getAttribute('r');
                        [$exists, $fmt] = $st->fmtOf($r->getAttribute('s'));
                        $st->rowFmt = $exists ? $fmt : null;
                        $st->values = [];
                        if ($empty && ! $st->endRow()) {
                            $tooMany = true;
                            break;
                        }
                    }
                } elseif ($name === 'c') {
                    if ($st->row !== null) {
                        $s = $r->getAttribute('s');
                        $fmt = $st->rowFmt;
                        if ($s !== null && JsNumber::parseInt($s)) { // exceljs: a falsy style index keeps the row's style
                            [$exists, $own] = $st->fmtOf($s);
                            $fmt = $exists ? $own : $st->rowFmt;
                        }
                        $ref = XlsxScanner::cellRef((string) $r->getAttribute('r'));
                        $st->startCell($ref[0] ?? 0, $r->getAttribute('t'), $fmt);
                        if ($empty) {
                            $st->endCell();
                        }
                    }
                } elseif ($name === 'sheetData') {
                    $st->inSheetData = ! $empty;
                } elseif ($st->col !== null) {
                    if ($name === 'v') {
                        $st->v = '';
                        $st->capture = $empty ? null : 'v';
                    } elseif ($name === 'f') {
                        $st->hasF = true;
                    } elseif ($name === 'is') {
                        $st->inline = '';
                        $st->tDepth = 0;
                        $st->rphDepth = 0;
                        $st->capture = null;
                    } elseif (($name === 't' || $name === 'rPh') && $st->inline !== null) {
                        if (! $empty) {
                            $name === 't' ? $st->tDepth++ : $st->rphDepth++;
                        }
                        $st->captureInline();
                    }
                }
            } elseif ($type === XMLReader::END_ELEMENT) {
                if ($r->namespaceURI !== self::NS) {
                    continue;
                }
                $name = $r->localName;
                if ($name === 'row') {
                    if (! $st->endRow()) {
                        $tooMany = true;
                        break;
                    }
                } elseif ($name === 'c') {
                    $st->endCell();
                } elseif ($name === 'sheetData') {
                    $st->inSheetData = false;
                } elseif ($st->col !== null) {
                    if ($name === 'v' || $name === 'is') {
                        $st->capture = null;
                    } elseif (($name === 't' || $name === 'rPh') && $st->inline !== null) {
                        $name === 't' ? $st->tDepth-- : $st->rphDepth--;
                        $st->captureInline();
                    }
                }
            } elseif ($st->capture !== null && isset(self::TEXT_NODES[$type])) {
                $st->text($r->value);
            }
        }
        if ($tooMany) {
            $r->close();
            libxml_clear_errors();
            throw new XlsxStop('tooManyRows');
        }
        self::close($r);
        if ($st->resultBytes > self::MAX_RESULT_BYTES) {
            throw new XlsxStop('tooLarge');
        }

        return ['header' => $st->header, 'rows' => $st->rows];
    }

    /**
     * A reader over one part. Entities are never expanded (review I1 of Tasks 4+5):
     * - `$huge` (the workbook, its relationships, the shared strings and the sheet — a cell may exceed libxml2's
     *   10 MB text limit) turns LIBXML_PARSEHUGE on, which also turns libxml2's entity-amplification guard off; such
     *   a part must therefore have no DOCTYPE at all (the pre-scan refuses one too) — any → unsupported;
     * - styles.xml (≤ 1 MiB, its DOCTYPE blanked by `withoutDoctype`) is read without it, the guard on.
     * Whatever slips past both, `step()` refuses at the first DOCTYPE node.
     */
    private static function open(string $text, bool $huge = true): XMLReader
    {
        if ($text === '' || ($huge && self::prologDoctype($text) !== null)) {
            throw new XlsxStop('unsupported');
        }
        libxml_use_internal_errors(true);
        libxml_clear_errors();
        $r = XMLReader::XML($text, 'UTF-8', ($huge ? LIBXML_PARSEHUGE : 0) | LIBXML_NONET | LIBXML_COMPACT);
        if (! $r instanceof XMLReader) {
            throw new XlsxStop('unsupported');
        }

        return $r;
    }

    /** The next node; a DOCTYPE node (never expected: see `open`) → unsupported. */
    private static function step(XMLReader $r): bool
    {
        if (! $r->read()) {
            return false;
        }
        if ($r->nodeType === XMLReader::DOC_TYPE) {
            $r->close();
            libxml_clear_errors();
            throw new XlsxStop('unsupported');
        }

        return true;
    }

    /** Ends a pass: any fatal libxml2 error (not well-formed) → unsupported. */
    private static function close(XMLReader $r): void
    {
        $r->close();
        foreach (libxml_get_errors() as $e) {
            if ($e->level === LIBXML_ERR_FATAL) {
                libxml_clear_errors();
                throw new XlsxStop('unsupported');
            }
        }
        libxml_clear_errors();
    }
}
