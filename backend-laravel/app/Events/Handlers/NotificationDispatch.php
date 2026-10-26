<?php

namespace App\Events\Handlers;

use App\Events\Claim;
use App\Events\EventHandler;
use App\Infrastructure\Db\Tx;
use App\Notifications\Insert;
use stdClass;

/**
 * `notification.dispatch` (contracts/events/notification.dispatch.schema.json, R56; Express
 * events/consumers/notification-dispatch.ts): in ONE transaction that starts with the processed_events claim the
 * recipients are expanded and the rows inserted (Notifications\Insert — IN_APP DELIVERED, whose trigger emits
 * pg_notify for SSE; EMAIL/TELEGRAM PENDING). After the commit and the ack the consumer sends the PENDING rows
 * (Delivery::sendOwn). A redelivered event finds its claim and creates and sends nothing.
 */
final class NotificationDispatch implements EventHandler
{
    public function handle(stdClass $envelope): void
    {
        $d = $envelope->data;
        Tx::run(function () use ($envelope, $d): void {
            if (! Claim::event((string) $envelope->id)) {
                return;
            }
            $r = $d->recipients;
            Insert::rows((string) $d->notificationType, [
                'userIds' => array_values((array) ($r->userIds ?? [])),
                'orgIds' => array_values((array) ($r->orgIds ?? [])),
                'orgHeadIds' => array_values((array) ($r->orgHeadIds ?? [])),
                'roles' => array_values((array) ($r->roles ?? [])),
            ], $d->payload instanceof stdClass ? $d->payload : (object) (array) $d->payload);
        });
    }
}
