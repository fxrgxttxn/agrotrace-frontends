<?php

namespace App\Actions\Reports;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Infrastructure\Sandbox\Lane;
use App\Infrastructure\Sandbox\LaneOptions;
use App\Infrastructure\Sandbox\LaneRefused;

/**
 * The report render queue (downloadReport, P52, L6; Express modules/reports/render.ts): the sandbox lane `report` —
 * per container 1 render running + 4 waiting, 120 s from admission (waiting included; the child's start-up excluded),
 * `memory_limit` 1 GiB in the child (a 50 000-row workbook needs ~0.5 GiB). admit() takes the place BEFORE any data
 * is read: a full queue → 503 BACKEND_UNAVAILABLE `{reason: "report-busy"}` at once, so refused requests cost no
 * database work — and, unlike Express's advisory check, the place is held, so a burst cannot pass it together.
 */
final class Queue
{
    public const WAITING = 4;

    public const DEADLINE_SEC = 120.0;

    public const MEMORY = '1G';

    public static function admit(?LaneOptions $o = null): Ticket
    {
        try {
            return new Ticket(Lane::admit($o ?? self::options()));
        } catch (LaneRefused) {
            throw self::busy();
        }
    }

    public static function options(): LaneOptions
    {
        return new LaneOptions('report', self::WAITING, self::DEADLINE_SEC, self::MEMORY);
    }

    /** The 503 of a full queue, a missed deadline or a failed render. */
    public static function busy(): Problem
    {
        return new Problem(503, ProblemCode::BACKEND_UNAVAILABLE, params: ['reason' => 'report-busy']);
    }
}
