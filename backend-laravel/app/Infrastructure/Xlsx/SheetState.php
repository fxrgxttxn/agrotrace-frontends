<?php

namespace App\Infrastructure\Xlsx;

use App\Support\JsNumber;

/**
 * The state of one first-sheet read (XlsxReader::sheet): the open row and cell, what text is captured, the result so
 * far and its size (P25, P26). Framework-free (the sandbox child).
 */
final class SheetState
{
    public bool $inSheetData = false;

    public ?int $row = null;

    public ?string $rowFmt = null;

    /** @var array<int, string|null> column → value (null = INVALID) */
    public array $values = [];

    /** The open cell: its column, `t`, number format, whether it has a formula, the `<v>` and `<is>` texts. */
    public ?int $col = null;

    public ?string $t = null;

    public ?string $fmt = null;

    public bool $hasF = false;

    public ?string $v = null;

    public ?string $inline = null;

    /** 'v' | 'is' | null — where text nodes go. */
    public ?string $capture = null;

    public int $tDepth = 0;

    public int $rphDepth = 0;

    /** @var list<string|int|null>|null */
    public ?array $header = null;

    public bool $first = true;

    /** @var list<array{number: int, cells: list<string|int|null>}> */
    public array $rows = [];

    public int $dataRows = 0;

    public int $resultBytes = 0;

    /**
     * @param  list<string>  $strings
     * @param  list<?string>  $styles
     */
    public function __construct(private readonly array $strings, private readonly array $styles) {}

    /**
     * (the style exists, its number format) of a style index attribute (exceljs getStyleModel).
     *
     * @return array{0: bool, 1: ?string}
     */
    public function fmtOf(?string $s): array
    {
        if ($s === null) {
            return [false, null];
        }
        $k = JsNumber::parseInt($s);
        if ($k === null || $k < 0 || $k >= count($this->styles)) {
            return [false, null];
        }

        return [true, $this->styles[$k]];
    }

    public function startCell(int $col, ?string $t, ?string $fmt): void
    {
        $this->col = $col;
        $this->t = $t;
        $this->fmt = $fmt;
        $this->hasF = false;
        $this->v = null;
        $this->inline = null;
        $this->capture = null;
    }

    public function text(string $value): void
    {
        if ($this->capture === 'v') {
            $this->v .= $value;
        } elseif ($this->capture === 'is') {
            $this->inline .= $value;
        }
    }

    public function captureInline(): void
    {
        $this->capture = $this->tDepth > 0 && $this->rphDepth === 0 ? 'is' : null;
    }

    public function endCell(): void
    {
        if ($this->col === null) {
            return;
        }
        $col = $this->col;
        $t = $this->t;
        $v = $this->v;
        $inline = $this->inline;
        $this->col = null;
        $this->capture = null;
        if ($this->hasF) {
            $value = $v === null ? '' : ($t === 'str' ? $v : (($t === 'b' || $t === 'e') ? XlsxReader::INVALID : self::number($v)));
        } elseif ($t === 's') {
            $k = $v !== null ? JsNumber::parseInt($v) : null;
            $value = $k !== null && $k >= 0 && $k < count($this->strings) ? $this->strings[$k] : '';
        } elseif ($t === 'inlineStr' || $t === 'str') {
            $value = $inline ?? $v ?? '';
        } elseif ($t === 'b' || $t === 'e' || $t === 'd') {
            $value = ($v !== null || $inline !== null) ? XlsxReader::INVALID : '';
        } else {
            $txt = $v ?? $inline;
            $value = $txt === null ? '' : (XlsxReader::isDateFormat($this->fmt) ? XlsxReader::INVALID : self::number($txt));
        }
        if ($value !== '') {
            $this->values[$col] = $value;
        }
    }

    /** Ends the open row; false — the 10 001st data row: tooManyRows, reading stops. */
    public function endRow(): bool
    {
        if ($this->row === null) {
            return true;
        }
        $number = $this->row;
        $this->row = null;
        $cells = [];
        if ($this->values !== []) {
            $cells = array_fill(0, max(array_keys($this->values)), '');
            foreach ($this->values as $col => $v) {
                $cells[$col - 1] = $v;
            }
        }
        $this->values = [];
        if ($this->first) {
            $this->first = false;
            if ($number === 1) {
                $this->header = $this->bounded($cells);

                return true;
            }
        }
        if ($number === 1 || $cells === []) {
            return true;
        }
        if (++$this->dataRows > XlsxReader::MAX_DATA_ROWS) {
            return false;
        }
        if ($this->resultBytes > XlsxReader::MAX_RESULT_BYTES) {
            return true; // already too large: keep nothing, keep counting rows
        }
        $this->rows[] = ['number' => $number, 'cells' => $this->bounded($cells)];

        return true;
    }

    /**
     * Cells over 1 000 code points → TOO_LONG (their text is not kept); the kept text is counted.
     *
     * @param  list<string|null>  $cells
     * @return list<string|int|null>
     */
    private function bounded(array $cells): array
    {
        foreach ($cells as $i => $c) {
            if (! is_string($c)) {
                continue;
            }
            // Characters are code points (R36): over 4 bytes per allowed character it is too long whatever it holds.
            $bytes = strlen($c);
            if ($bytes > 4 * XlsxReader::MAX_CELL_CHARS || ($bytes > XlsxReader::MAX_CELL_CHARS && mb_strlen($c, 'UTF-8') > XlsxReader::MAX_CELL_CHARS)) {
                $cells[$i] = XlsxReader::TOO_LONG;

                continue;
            }
            $this->resultBytes += $bytes;
        }

        return $cells;
    }

    /** A number cell's text: parseFloat, then the shortest decimal without exponent; NaN/±Infinity → INVALID. */
    private static function number(string $text): ?string
    {
        $x = JsNumber::parseFloat($text);
        if ($x === null || is_infinite($x)) {
            return XlsxReader::INVALID;
        }

        return JsNumber::plain($x);
    }
}
