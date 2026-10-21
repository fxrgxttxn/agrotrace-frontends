<?php

namespace App\Domain;

use DateTimeImmutable;
use DateTimeZone;
use InvalidArgumentException;

/**
 * Date rules (@agrotrace/domain dates.ts): instants are ISO 8601 strings, computed in UTC with millisecond precision
 * (DateTimeImmutable, never the PHP default zone), printed `YYYY-MM-DDTHH:MM:SS.mmmZ`.
 */
final class Dates
{
    private const DAY_MS = 86_400_000;

    private const OUT = 'Y-m-d\TH:i:s.v\Z';

    /** The UTC calendar date of an ISO instant (its first 10 characters, as Express slices it). */
    public static function utcDate(string $iso): string
    {
        return substr($iso, 0, 10);
    }

    public static function addDaysToDate(string $date, int $days): string
    {
        $d = new DateTimeImmutable("{$date}T00:00:00Z");

        return $d->modify(($days >= 0 ? '+' : '').$days.' days')->format('Y-m-d');
    }

    /**
     * Adds N working days (Mon–Fri) to an ISO instant, skipping Saturdays and Sundays by UTC calendar date; the time of
     * day is kept. Weekends only, no holidays (R24); days=0 returns the instant unchanged (normalized), even on a
     * weekend.
     *
     * @param  array{from: string, days: int}  $i
     * @return array{result: string}
     */
    public static function addWorkingDays(array $i): array
    {
        $ms = self::ms($i['from']);
        $left = (int) $i['days'];
        while ($left > 0) {
            $ms += self::DAY_MS;
            $wd = (int) self::fromMs($ms)->format('w');
            if ($wd !== 0 && $wd !== 6) {
                $left--;
            }
        }

        return ['result' => self::fromMs($ms)->format(self::OUT)];
    }

    /**
     * BR-08: a recall task is due exactly 24 h after it was opened.
     *
     * @param  array{openedAt: string}  $i
     * @return array{dueAt: string}
     */
    public static function recallTaskDueAt(array $i): array
    {
        return ['dueAt' => self::fromMs(self::ms($i['openedAt']) + self::DAY_MS)->format(self::OUT)];
    }

    /**
     * BR-08: overdue once now strictly passes dueAt.
     *
     * @param  array{dueAt: string, now: string}  $i
     * @return array{overdue: bool}
     */
    public static function isOverdue(array $i): array
    {
        return ['overdue' => self::ms($i['now']) > self::ms($i['dueAt'])];
    }

    /**
     * FR-PROD-02: a treatment is editable within 24 h of its creation, boundary inclusive.
     *
     * @param  array{createdAt: string, now: string}  $i
     * @return array{allowed: bool}
     */
    public static function canEditTreatment(array $i): array
    {
        return ['allowed' => self::ms($i['now']) - self::ms($i['createdAt']) <= self::DAY_MS];
    }

    /** Milliseconds since the epoch of an ISO 8601 instant (Date.parse). */
    public static function ms(string $iso): int
    {
        try {
            $d = new DateTimeImmutable($iso, new DateTimeZone('UTC'));
        } catch (\Exception) {
            throw new InvalidArgumentException("invalid instant: {$iso}");
        }

        return intdiv((int) $d->format('Uu'), 1000);
    }

    public static function fromMs(int $ms): DateTimeImmutable
    {
        $sec = intdiv($ms, 1000);
        $rem = $ms % 1000;
        if ($rem < 0) {
            $sec--;
            $rem += 1000;
        }

        return (new DateTimeImmutable('@'.$sec))->setTimezone(new DateTimeZone('UTC'))
            ->modify('+'.($rem * 1000).' microseconds');
    }
}
