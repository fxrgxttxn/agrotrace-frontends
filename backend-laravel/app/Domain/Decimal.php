<?php

namespace App\Domain;

use App\Http\Validation\Ecma;
use InvalidArgumentException;

/**
 * Exact decimal arithmetic on decimal strings (@agrotrace/domain decimal.ts; L14): bcmath only, never float — sums
 * up to 10^18 g and `n·10^4` exceed int64 and double precision. Grams are integer strings.
 */
final class Decimal
{
    /** -1, 0 or 1 — exact, scale-normalized ("2.0" = "2.00", "9.5" < "10.0"); non-negative decimal strings only. */
    public static function compare(string $a, string $b): int
    {
        $sa = self::scale($a);
        $sb = self::scale($b);

        return bccomp($a, $b, max($sa, $sb));
    }

    /**
     * A mass in kg → grams (R26): at most 9 integer digits, at most 3 decimals (numeric(12,3), contract `Mass`).
     */
    public static function kgToGrams(string $kg): string
    {
        if (! Ecma::test(Ecma::compile('^\d{1,9}(?:\.\d{1,3})?$'), $kg)) {
            throw new InvalidArgumentException("invalid mass: {$kg}");
        }
        [$int, $frac] = array_pad(explode('.', $kg, 2), 2, '');

        return bcadd(bcmul($int, '1000'), str_pad($frac, 3, '0'));
    }

    /** Grams (an integer string, may be negative) → kg with exactly 3 decimals. */
    public static function gramsToKg(string $grams): string
    {
        $neg = str_starts_with($grams, '-');
        $abs = $neg ? substr($grams, 1) : $grams;

        return ($neg ? '-' : '').bcdiv($abs, '1000', 0).'.'.str_pad(bcmod($abs, '1000'), 3, '0', STR_PAD_LEFT);
    }

    /** lossNormPercent `^\d{1,3}(\.\d{1,2})?$` (R23) → percent·100 as an integer string. */
    public static function percentToBasisPoints(string $percent): string
    {
        if (! preg_match(Ecma::compile('^(\d{1,3})(?:\.(\d{1,2}))?$'), $percent, $m)) {
            throw new InvalidArgumentException("invalid percent: {$percent}");
        }

        return bcadd(bcmul($m[1], '100'), str_pad($m[2] ?? '', 2, '0'));
    }

    /** round_half_up(n / d · 100, 2) as "N.NN" (n, d ≥ 0 integer strings, d > 0). */
    public static function ratioPercent2(string $n, string $d): string
    {
        $scaled = bcdiv(bcadd(bcmul(bcmul($n, '10000'), '2'), $d), bcmul('2', $d), 0);

        return bcdiv($scaled, '100', 0).'.'.str_pad(bcmod($scaled, '100'), 2, '0', STR_PAD_LEFT);
    }

    private static function scale(string $s): int
    {
        if (! preg_match(Ecma::compile('^\d+(?:\.(\d+))?$'), $s, $m)) {
            throw new InvalidArgumentException("invalid decimal: {$s}");
        }

        return strlen($m[1] ?? '');
    }
}
