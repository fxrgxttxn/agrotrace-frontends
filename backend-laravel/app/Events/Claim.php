<?php

namespace App\Events;

use App\Infrastructure\Db\Tx;
use Illuminate\Support\Facades\DB;
use LogicException;

/**
 * The consumer's first statement (R56, envelope): `INSERT INTO processed_events … ON CONFLICT DO NOTHING` inside the
 * handler's transaction. false — the event was already handled (a redelivery, or the same event handled by a parallel
 * consumer that committed first): the handler writes nothing.
 */
final class Claim
{
    public static function event(string $eventId): bool
    {
        if (! Tx::active()) {
            throw new LogicException('Claim::event outside Tx::run: the claim commits with the handler\'s effects');
        }

        return DB::selectOne("INSERT INTO processed_events (event_id, backend) VALUES (?, 'laravel')
             ON CONFLICT (event_id) DO NOTHING RETURNING event_id", [$eventId]) !== null;
    }
}
