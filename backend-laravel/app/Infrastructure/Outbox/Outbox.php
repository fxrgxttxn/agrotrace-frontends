<?php

namespace App\Infrastructure\Outbox;

use App\Infrastructure\Db\Tx;
use App\Support\Iso;
use App\Support\Json;
use App\Support\RequestContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use InvalidArgumentException;
use LogicException;
use stdClass;

/**
 * Transactional outbox, write side (R55, R56, P1): an event is a row of `outbox_events` (backend `laravel`) inserted
 * in the SAME transaction as the state change; its `payload` is the whole envelope (contracts/events/envelope):
 * id (UUIDv4 = AMQP message_id), type, occurredAt (the clock at the INSERT, R59), backend, requestId (from the request
 * context; null outside a request), data. After the commit the id joins RequestContext::eventIds() for the relay
 * (Plan 5 Task 12); an attempt that rolls back or is retried leaves nothing behind.
 */
final class Outbox
{
    public const TYPES = ['recall.requested', 'notification.dispatch', 'lab.escalate', 'rating.recalculate', 'vsd.import'];

    /** @param  array<string, mixed>|stdClass  $data */
    public static function enqueue(string $type, array|stdClass $data): string
    {
        if (! in_array($type, self::TYPES, true)) {
            throw new InvalidArgumentException("unknown event type {$type}");
        }
        if (! Tx::active()) {
            throw new LogicException('Outbox::enqueue outside Tx::run: the event must commit with its state change');
        }
        $ctx = app(RequestContext::class);
        $id = (string) Str::uuid();
        $envelope = [
            'id' => $id,
            'type' => $type,
            'occurredAt' => Iso::clockNow(),
            'backend' => 'laravel',
            'requestId' => $ctx->requestId(),
            'data' => is_array($data) ? Json::obj($data) : $data,
        ];
        DB::insert(
            'INSERT INTO outbox_events (id, backend, type, payload) VALUES (?, ?, ?, ?::jsonb)',
            [$id, 'laravel', $type, Json::encode($envelope)],
        );
        Tx::afterCommit(fn () => $ctx->addEventId($id));

        return $id;
    }
}
