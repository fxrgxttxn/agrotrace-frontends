<?php

namespace App\Events;

use App\Events\Handlers\VsdImport;

/**
 * The event types this backend handles, with their handler classes (resolved by the service container). Only these
 * types are published by the relay and the sweeper: a row of another type stays unpublished in the outbox until the
 * task that brings its handler registers it here (Plan 5 Tasks 9–12; Django Ruling Q12) — published, it would only be
 * dead-lettered and lost.
 */
final class EventHandlers
{
    /** @var array<string, class-string<EventHandler>> */
    public const MAP = [
        'vsd.import' => VsdImport::class,
    ];

    /** @return list<string> */
    public static function types(): array
    {
        return array_keys(self::MAP);
    }

    /** @return array<string, EventHandler> */
    public static function resolve(): array
    {
        return array_map(fn (string $class) => app($class), self::MAP);
    }
}
