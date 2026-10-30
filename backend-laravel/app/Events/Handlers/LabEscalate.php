<?php

namespace App\Events\Handlers;

use App\Events\Claim;
use App\Events\EventHandler;
use App\Infrastructure\Db\Tx;
use App\Notifications\Insert;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * `lab.escalate` (contracts/events/lab.escalate.schema.json, R56; Express events/consumers/lab-escalate.ts): LAB_OVERDUE
 * for the heads of the lab organization and every inspector (contracts/rules/notifications.json), in ONE transaction
 * that starts with the processed_events claim — a redelivery writes nothing. Payload: the event's data plus the
 * laboratory's name. The consumer sends the PENDING EMAIL/TELEGRAM rows after the ack (Notifications\Delivery).
 */
final class LabEscalate implements EventHandler
{
    public function handle(stdClass $envelope): void
    {
        $d = $envelope->data;
        Tx::run(function () use ($envelope, $d): void {
            if (! Claim::event($envelope->id)) {
                return;
            }
            $lab = DB::selectOne('SELECT name FROM organizations WHERE id = ?', [$d->labOrgId]);
            Insert::rows('LAB_OVERDUE', ['userIds' => [], 'orgIds' => [], 'orgHeadIds' => [$d->labOrgId], 'roles' => ['INSPECTOR']], (object) [
                'labTestId' => $d->labTestId,
                'batchId' => $d->batchId,
                'publicCode' => $d->publicCode,
                'labOrgId' => $d->labOrgId,
                'labName' => $lab->name ?? '',
                'dueAt' => $d->dueAt,
            ]);
        });
    }
}
