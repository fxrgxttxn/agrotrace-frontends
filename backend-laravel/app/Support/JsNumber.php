<?php

namespace App\Support;

/**
 * JavaScript number text and parsing, framework-free (it also runs in the XLSX sandbox child):
 * - `text($x)` is `String(x)` (ECMA-262 Number::toString): the shortest decimal digits that read back as $x, plain
 *   between 1e-7 and 1e21, else `d.ddde±n`;
 * - `plain($x)` is the XLSX import's `numberText` (Express xlsx-read.ts): the same digits, never an exponent;
 * - `parseFloat($s)` / `parseInt($s)` are the global functions exceljs reads cell text with (leading JS white space
 *   skipped, the longest numeric prefix; null for NaN).
 */
final class JsNumber
{
    /** JavaScript StrWhiteSpaceChar (WhiteSpace + LineTerminator) in UTF-8, longest first is not needed (no prefixes). */
    private const WHITE = ["\t", "\n", "\x0B", "\x0C", "\r", ' ', "\u{00A0}", "\u{1680}", "\u{2000}", "\u{2001}",
        "\u{2002}", "\u{2003}", "\u{2004}", "\u{2005}", "\u{2006}", "\u{2007}", "\u{2008}", "\u{2009}", "\u{200A}",
        "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}"];

    public static function text(float|int $x): string
    {
        if (is_int($x)) {
            $x = (float) $x;
        }
        if (is_nan($x)) {
            return 'NaN';
        }
        if (is_infinite($x)) {
            return $x > 0 ? 'Infinity' : '-Infinity';
        }
        if ($x == 0.0) {
            return '0';
        }
        [$neg, $digits, $n] = self::shortest($x);
        $k = strlen($digits);
        $sign = $neg ? '-' : '';
        if ($k <= $n && $n <= 21) {
            return $sign.$digits.str_repeat('0', $n - $k);
        }
        if ($n > 0 && $n <= 21) {
            return $sign.substr($digits, 0, $n).'.'.substr($digits, $n);
        }
        if ($n > -6 && $n <= 0) {
            return $sign.'0.'.str_repeat('0', -$n).$digits;
        }
        $e = $n - 1;
        $exp = 'e'.($e >= 0 ? '+' : '-').abs($e);

        return $sign.($k === 1 ? $digits : $digits[0].'.'.substr($digits, 1)).$exp;
    }

    /** `numberText`: String(x) written without an exponent (`1e21` → `1000000000000000000000`, `1e-7` → `0.0000001`). */
    public static function plain(float|int $x): string
    {
        if (is_int($x)) {
            $x = (float) $x;
        }
        if (is_nan($x) || is_infinite($x)) {
            return self::text($x);
        }
        if ($x == 0.0) {
            return '0';
        }
        [$neg, $digits, $n] = self::shortest($x);
        $k = strlen($digits);
        $body = $n <= 0
            ? '0.'.str_repeat('0', -$n).$digits
            : ($n >= $k ? $digits.str_repeat('0', $n - $k) : substr($digits, 0, $n).'.'.substr($digits, $n));

        return ($neg ? '-' : '').$body;
    }

    /**
     * JavaScript `parseFloat`: null for NaN; ±INF for an `Infinity` prefix.
     */
    public static function parseFloat(string $s): ?float
    {
        $i = self::skipWhite($s);
        $n = strlen($s);
        $start = $i;
        if ($i < $n && ($s[$i] === '+' || $s[$i] === '-')) {
            $i++;
        }
        if (substr($s, $i, 8) === 'Infinity') {
            return $s[$start] === '-' ? -INF : INF;
        }
        $intDigits = strspn($s, '0123456789', $i);
        $j = $i + $intDigits;
        $fracDigits = 0;
        if ($j < $n && $s[$j] === '.') {
            $fracDigits = strspn($s, '0123456789', $j + 1);
            if ($intDigits > 0 || $fracDigits > 0) {
                $j += 1 + $fracDigits;
            }
        }
        if ($intDigits === 0 && $fracDigits === 0) {
            return null;
        }
        if ($j < $n && ($s[$j] === 'e' || $s[$j] === 'E')) {
            $k = $j + 1;
            if ($k < $n && ($s[$k] === '+' || $s[$k] === '-')) {
                $k++;
            }
            $expDigits = strspn($s, '0123456789', $k);
            if ($expDigits > 0) {
                $j = $k + $expDigits;
            }
        }

        return (float) substr($s, $start, $j - $start);
    }

    /** JavaScript `parseInt(s, 10)`: null for NaN (no digits after the optional sign). */
    public static function parseInt(string $s): ?int
    {
        $i = self::skipWhite($s);
        $neg = false;
        if ($i < strlen($s) && ($s[$i] === '+' || $s[$i] === '-')) {
            $neg = $s[$i] === '-';
            $i++;
        }
        $d = strspn($s, '0123456789', $i);
        if ($d === 0) {
            return null;
        }
        $digits = ltrim(substr($s, $i, $d), '0');
        if (strlen($digits) > 18) {
            return $neg ? PHP_INT_MIN : PHP_INT_MAX;
        }
        $v = (int) ($digits === '' ? '0' : $digits);

        return $neg ? -$v : $v;
    }

    private static function skipWhite(string $s): int
    {
        $i = 0;
        $n = strlen($s);
        while ($i < $n) {
            $hit = false;
            foreach (self::WHITE as $w) {
                if (substr_compare($s, $w, $i, strlen($w)) === 0) {
                    $i += strlen($w);
                    $hit = true;
                    break;
                }
            }
            if (! $hit) {
                break;
            }
        }

        return $i;
    }

    /**
     * The shortest round-tripping decimal of a finite non-zero $x: [negative, digits without leading/trailing zeros,
     * n] with $x = 0.digits × 10^n (ECMA-262's s, k, n).
     *
     * @return array{0: bool, 1: string, 2: int}
     */
    private static function shortest(float $x): array
    {
        $neg = $x < 0;
        $a = abs($x);
        for ($p = 1; $p <= 17; $p++) {
            $s = sprintf('%.'.($p - 1).'e', $a);
            if ((float) $s === $a) {
                break;
            }
        }
        [$mant, $exp] = explode('e', $s);
        $digits = rtrim(str_replace('.', '', $mant), '0');

        return [$neg, $digits === '' ? '0' : $digits, (int) $exp + 1];
    }
}
