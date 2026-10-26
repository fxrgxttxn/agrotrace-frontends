<?php

namespace App\Events\Handlers;

use App\Events\Claim;
use App\Events\EventHandler;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Outbox\Outbox;
use App\Notifications\Insert;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * `recall.requested` (contracts/events/recall.requested.schema.json, tag Recalls, R55/R56, R89; Express
 * events/consumers/recall-requested.ts line by line). The recall is already committed by the operation that created
 * it; the handler only fans out, in ONE transaction that starts with the processed_events claim:
 *
 *   1. RECALL {event: OPENED} to the inspectors, every task holder and the source batch's origin — only while the
 *      recall is OPEN, not soft-deleted and has tasks: a recall closed at creation (BR-10) or with every task
 *      confirmed before the handler ran already has its RECALL CLOSED, and an OPENED after it would contradict it
 *      (R89, Express M6);
 *   2. RECALL_TASK {event: CREATED} per task (id order, code points) to its holder;
 *   3. `rating.recalculate {cause: RECALL_SOURCE, sourceId: recallId}` into the outbox when the source's origin is a
 *      FARM, with the handled event's requestId (Outbox::enqueue reads it from the worker's context); the Consumer
 *      relays it after the commit, the sweeper retries.
 *
 * Notifications go through Notifications\Insert (IN_APP DELIVERED — the table trigger notifies SSE; EMAIL/TELEGRAM
 * PENDING for the delivery half, Task 12). A redelivered event finds its claim and writes nothing.
 */
final class RecallRequested implements EventHandler
{
    public function handle(stdClass $envelope): void
    {
        $recallId = (string) ($envelope->data->recallId ?? '');
        Tx::run(function () use ($envelope, $recallId): void {
            if (! Claim::event((string) $envelope->id)) {
                return;
            }
            $r = DB::selectOne('SELECT r.id, r.trigger, r.status, r.deleted_at, b.id AS batch_id, b.public_code, b.origin_org_id,
                    o.type AS origin_type
                  FROM recalls r JOIN batches b ON b.id = r.source_batch_id JOIN organizations o ON o.id = b.origin_org_id
                 WHERE r.id = ?', [$recallId]);
            if ($r === null) {
                return;
            }
            $tasks = DB::select('SELECT t.id, t.holder_org_id, t.batch_id, t.due_at::text AS due_at, b.public_code
                  FROM recall_tasks t JOIN batches b ON b.id = t.batch_id
                 WHERE t.recall_id = ? ORDER BY t.id::text COLLATE "C"', [$r->id]);
            if ($r->status === 'OPEN' && $r->deleted_at === null && $tasks !== []) {
                $orgIds = array_values(array_unique([...array_map(fn ($t) => $t->holder_org_id, $tasks), $r->origin_org_id]));
                Insert::rows('RECALL', ['userIds' => [], 'orgIds' => $orgIds, 'orgHeadIds' => [], 'roles' => ['INSPECTOR']], (object) [
                    'recallId' => $r->id,
                    'event' => 'OPENED',
                    'sourceBatchId' => $r->batch_id,
                    'publicCode' => $r->public_code,
                    'trigger' => $r->trigger,
                ]);
            }
            foreach ($tasks as $t) {
                Insert::rows('RECALL_TASK', ['userIds' => [], 'orgIds' => [$t->holder_org_id], 'orgHeadIds' => [], 'roles' => []], (object) [
                    'recallId' => $r->id,
                    'taskId' => $t->id,
                    'batchId' => $t->batch_id,
                    'publicCode' => $t->public_code,
                    'dueAt' => Iso::fromPg($t->due_at),
                    'event' => 'CREATED',
                ]);
            }
            if ($r->origin_type === 'FARM') {
                Outbox::enqueue('rating.recalculate', [
                    'organizationId' => $r->origin_org_id,
                    'cause' => 'RECALL_SOURCE',
                    'sourceId' => $r->id,
                ]);
            }
        });
    }
}
