<?php

namespace App\Events\Handlers;

use App\Actions\Rating\Rating;
use App\Events\Claim;
use App\Events\EventHandler;
use App\Infrastructure\Db\Tx;
use stdClass;

/**
 * `rating.recalculate` (contracts/events/rating.recalculate.schema.json, BR-09; Express
 * events/consumers/rating-recalculate.ts): in ONE transaction that starts with the processed_events claim, the farm's
 * rating is recomputed from scratch under its row lock (Rating::recalculate). `cause` and `sourceId` are informational
 * only: a redelivery or a parallel delivery yields the same rating.
 */
final class RatingRecalculate implements EventHandler
{
    public function handle(stdClass $envelope): void
    {
        $orgId = (string) ($envelope->data->organizationId ?? '');
        Tx::run(function () use ($envelope, $orgId): void {
            if (! Claim::event((string) $envelope->id)) {
                return;
            }
            Rating::recalculate($orgId);
        });
    }
}
