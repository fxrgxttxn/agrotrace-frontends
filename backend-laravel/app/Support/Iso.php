<?php

namespace App\Support;

use DateTimeImmutable;
use DateTimeZone;

/**
 * Instants in the API format of Express (Global Constraints «Время»): `YYYY-MM-DDTHH:MM:SS.mmmZ`, UTC. PostgreSQL
 * text (`2026-10-21 12:34:56.123456+00`) is converted here and nowhere else — never through Eloquent datetime casts
 * (L9); microseconds are truncated to milliseconds, as a JavaScript Date does.
 */
final class Iso
{
    public const FORMAT = 'Y-m-d\TH:i:s.v\Z';

    public static function fromPg(?string $pg): ?string
    {
        if ($pg === null) {
            return null;
        }

        return (new DateTimeImmutable($pg))->setTimezone(new DateTimeZone('UTC'))->format(self::FORMAT);
    }

    /**
     * Date.parse of a validated `DateTime` (`YYYY-MM-DDTHH:MM[:SS[.fraction]]Z`, Zod `datetime({offset: false})`):
     * milliseconds since the epoch, the fraction cut to three digits as JavaScript does.
     */
    public static function epochMs(string $iso): int
    {
        $date = substr($iso, 0, 10);
        $time = substr($iso, 11, -1);
        [$hms, $frac] = array_pad(explode('.', $time, 2), 2, '');
        if (strlen($hms) === 5) {
            $hms .= ':00';
        }
        $d = new DateTimeImmutable("{$date}T{$hms}", new DateTimeZone('UTC'));

        return (int) $d->format('U') * 1000 + (int) str_pad(substr($frac, 0, 3), 3, '0');
    }

    /** The process clock in API format — only for the envelope's `occurredAt` (R59) and logs, never a DB write. */
    public static function clockNow(): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format(self::FORMAT);
    }
}
