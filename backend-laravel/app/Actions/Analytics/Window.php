<?php

namespace App\Actions\Analytics;

use App\Http\Query\QueryReader;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Db\TxOptions;
use App\Support\UtcDays;

/**
 * The analytics window (getDashboard, downloadReport; contracts/openapi/paths/analytics.yaml, reports.yaml; Express
 * modules/analytics/window.ts): UTC dates, inclusive. Default — the last 30 days: `to` = today (UTC, the snapshot
 * transaction's clock, P43), `from` = `to` − 29; one end given — the other one 29 days from it; `from` > `to` →
 * `errors.from: [validation.range]` (QueryReader::dateRange); explicit bounds longer than 366 days →
 * `errors.from: [validation.range.tooLong]`. And the read-only snapshot all analytics run in: one transaction
 * READ ONLY REPEATABLE READ.
 *
 * Dates stay `YYYY-MM-DD` strings (the contract's calendar includes year 0000, as QueryReader and Express): the day
 * arithmetic runs on proleptic Gregorian day numbers. A computed end beyond the four-digit calendar (`from=9999-12-31`
 * alone, `to=0000-01-01` alone) is clamped to 9999-12-31 / 0000-01-01 — Express prints `+010000-01` / `-000001-12`
 * there (not a `format: date`), no row lies beyond either end, so every number is the same (as Django).
 */
final class Window
{
    public const DAYS = 30;

    public const MAX_DAYS = 366;

    private const FIRST = '0000-01-01';

    private const LAST = '9999-12-31';

    /**
     * The window parameters of a dashboard or report: `from`/`to` (format, range) and the 366-day limit, the errors
     * collected in $q (one 400 with the operation's other errors).
     *
     * @return array{from: ?string, to: ?string}
     */
    public static function read(QueryReader $q): array
    {
        $range = $q->dateRange();
        if (! isset($q->errors['from']) && self::tooLong($range['from'], $range['to'])) {
            $q->errors['from'] = ['validation.range.tooLong'];
        }

        return $range;
    }

    /** True when explicit bounds span more than 366 days (a default or one-sided window never does). */
    public static function tooLong(?string $from, ?string $to): bool
    {
        return $from !== null && $to !== null && self::days($to) - self::days($from) + 1 > self::MAX_DAYS;
    }

    /**
     * The applied window of validated parameters; $snapshotDate = the UTC date of the snapshot's now().
     *
     * @return array{from: string, to: string}
     */
    public static function resolve(?string $from, ?string $to, string $snapshotDate): array
    {
        if ($from === null && $to === null) {
            return ['from' => self::shift($snapshotDate, 1 - self::DAYS), 'to' => $snapshotDate];
        }
        if ($from === null) {
            return ['from' => self::shift((string) $to, 1 - self::DAYS), 'to' => (string) $to];
        }
        if ($to === null) {
            return ['from' => $from, 'to' => self::shift($from, self::DAYS - 1)];
        }

        return ['from' => $from, 'to' => $to];
    }

    /**
     * Half-open instant bounds of a window as timestamptz literals: [from 00:00Z, to + 1 day 00:00Z); the end of
     * 9999-12-31 is `infinity` (no stored instant lies after it, as Express's 10000-01-01).
     *
     * @param  array{from: string, to: string}  $w
     * @return array{0: string, 1: string}
     */
    public static function bounds(array $w): array
    {
        return [UtcDays::start($w['from']), UtcDays::after($w['to']) ?? 'infinity'];
    }

    /**
     * Runs $fn($now) in one READ ONLY REPEATABLE READ transaction; $now — the snapshot's now() as PostgreSQL prints it
     * in the UTC session (`2026-10-21 12:34:56.123456+00`, P43: one instant). The connection and the DB slot stay
     * held until the caller releases them (SlotHolder) — never across rendering (P61).
     *
     * @template T
     *
     * @param  callable(string): T  $fn
     * @return T
     */
    public static function snapshot(callable $fn): mixed
    {
        return Tx::run(fn () => $fn(Tx::now()), new TxOptions('repeatable read', readOnly: true));
    }

    /** The UTC date of a snapshot's now() text. */
    public static function dateOf(string $pgNow): string
    {
        return substr($pgNow, 0, 10);
    }

    public static function shift(string $date, int $days): string
    {
        return self::date(self::days($date) + $days);
    }

    /** Day number of a `YYYY-MM-DD` (proleptic Gregorian, 1970-01-01 = 0; H. Hinnant's days_from_civil). */
    public static function days(string $date): int
    {
        $y = (int) substr($date, 0, 4);
        $m = (int) substr($date, 5, 2);
        $d = (int) substr($date, 8, 2);
        if ($m <= 2) {
            $y -= 1;
        }
        $era = intdiv($y >= 0 ? $y : $y - 399, 400);
        $yoe = $y - $era * 400;
        $doy = intdiv(153 * ($m + ($m > 2 ? -3 : 9)) + 2, 5) + $d - 1;
        $doe = $yoe * 365 + intdiv($yoe, 4) - intdiv($yoe, 100) + $doy;

        return $era * 146097 + $doe - 719468;
    }

    /** The inverse of days(), clamped to the four-digit calendar 0000-01-01 … 9999-12-31. */
    public static function date(int $days): string
    {
        if ($days < self::days(self::FIRST)) {
            return self::FIRST;
        }
        if ($days > self::days(self::LAST)) {
            return self::LAST;
        }
        $z = $days + 719468;
        $era = intdiv($z >= 0 ? $z : $z - 146096, 146097);
        $doe = $z - $era * 146097;
        $yoe = intdiv($doe - intdiv($doe, 1460) + intdiv($doe, 36524) - intdiv($doe, 146096), 365);
        $doy = $doe - (365 * $yoe + intdiv($yoe, 4) - intdiv($yoe, 100));
        $mp = intdiv(5 * $doy + 2, 153);
        $d = $doy - intdiv(153 * $mp + 2, 5) + 1;
        $m = $mp + ($mp < 10 ? 3 : -9);
        $y = $yoe + $era * 400 + ($m <= 2 ? 1 : 0);

        return sprintf('%04d-%02d-%02d', $y, $m, $d);
    }
}
