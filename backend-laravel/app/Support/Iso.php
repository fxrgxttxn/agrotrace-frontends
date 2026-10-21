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

    /** The process clock in API format — only for the envelope's `occurredAt` (R59) and logs, never a DB write. */
    public static function clockNow(): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format(self::FORMAT);
    }
}
