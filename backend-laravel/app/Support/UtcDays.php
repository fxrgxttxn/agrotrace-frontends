<?php

namespace App\Support;

/**
 * `DateFrom`/`DateTo` filters as UTC days (R41/D31; Express http/params.ts `dayAfter`), the one helper every from/to
 * filter uses. A date is `format: date` as QueryReader::isCalendarDate accepts it: years 0000–9999 (proleptic
 * Gregorian, as JavaScript's Date). `from` → `column >= <from> 00:00Z`; `to` (inclusive) → `column < <the next day>
 * 00:00Z`, exactly Express's bounds at the edges:
 * - the day after 9999-12-31 is 10000-01-01, after every instant the database can hold here — no upper bound;
 * - year 0 is 1 BC for PostgreSQL (`0001-… BC`), before every stored instant; 0000-12-31 ends at 0001-01-01.
 * The bounds are timestamptz literals with an explicit `+00`, so neither the session nor the process zone matters.
 */
final class UtcDays
{
    /** The first instant of the UTC day `$date` (YYYY-MM-DD), as a timestamptz literal. */
    public static function start(string $date): string
    {
        [$y, $m, $d] = array_map('intval', explode('-', $date));

        return self::literal($y, $m, $d);
    }

    /** The first instant after the UTC day `$date`, or null when that is past 9999-12-31 (no bound). */
    public static function after(string $date): ?string
    {
        [$y, $m, $d] = array_map('intval', explode('-', $date));
        if ($d < self::daysIn($y, $m)) {
            $d++;
        } elseif ($m < 12) {
            $m++;
            $d = 1;
        } else {
            $y++;
            $m = 1;
            $d = 1;
        }

        return $y > 9999 ? null : self::literal($y, $m, $d);
    }

    /**
     * SQL conditions and bindings of an inclusive UTC-day range on $column (a timestamptz column expression).
     *
     * @return array{0: list<string>, 1: list<string>}
     */
    public static function range(string $column, ?string $from, ?string $to): array
    {
        $conds = [];
        $bindings = [];
        if ($from !== null) {
            $conds[] = "{$column} >= ?::timestamptz";
            $bindings[] = self::start($from);
        }
        if ($to !== null) {
            $after = self::after($to);
            if ($after !== null) {
                $conds[] = "{$column} < ?::timestamptz";
                $bindings[] = $after;
            }
        }

        return [$conds, $bindings];
    }

    public static function isLeap(int $y): bool
    {
        return ($y % 4 === 0 && $y % 100 !== 0) || $y % 400 === 0;
    }

    public static function daysIn(int $y, int $m): int
    {
        return match ($m) {
            2 => self::isLeap($y) ? 29 : 28,
            4, 6, 9, 11 => 30,
            default => 31,
        };
    }

    private static function literal(int $y, int $m, int $d): string
    {
        // PostgreSQL has no year 0: astronomical year 0 is 1 BC.
        return $y === 0
            ? sprintf('0001-%02d-%02d 00:00:00+00 BC', $m, $d)
            : sprintf('%04d-%02d-%02d 00:00:00+00', $y, $m, $d);
    }
}
