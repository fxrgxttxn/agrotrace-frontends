<?php

namespace App\Actions\Recalls;

use App\Actions\Batches\Lifecycle;
use App\Domain\Dates;
use App\Domain\Rules;
use App\Domain\Strings;
use App\Http\Problem\Renderer;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Locks;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Db\TxOptions;
use App\Infrastructure\Outbox\Outbox;
use App\Queries\RecallScope;
use App\Support\Iso;
use Closure;
use Illuminate\Support\Facades\DB;
use LogicException;
use PDOException;
use Throwable;

/**
 * The recall engine core (tag Recalls, steps 1–7; P2; Express recalls/engine.ts line by line): synchronous, inside
 * the transaction of the operation that starts it (submitLabResults with FAIL, createRecall, decideComplaint with
 * RECALL), which runs at REPEATABLE READ (R54/D7, RECALL_TX).
 *
 *   1. an OPEN recall of the source → reused, steps 2–7 skipped (findOpen); a concurrent creation hits
 *      `ux_recalls_open_source` (23505) → the whole transaction is repeated once (RECALL_TX retryIf);
 *   2. RecallScope::of — DOWN, plus UP with `blockUpstream`, depth ≤ 20, soft-deleted batches walked through;
 *   3. the caller locks the source and every member in ONE `FOR NO KEY UPDATE ORDER BY id` (Locks::batches): a member
 *      changed after the snapshot fails with 40001 and the transaction is repeated with a fresh snapshot and a fresh
 *      Tx::now() (R47), so a link added by a parallel processing is never missed (start() does steps 1–3 for callers
 *      with nothing else to lock);
 *   4–7. apply: the `recalls` row, `recall_batches` (status_before), Recalled transitions (RECALLED, by the requesting
 *      user) where the state machine allows them (§5.1 note: Processed, Sold, WrittenOff and Recalled keep their
 *      status), a task per transitioned batch (its holder; for an InTransit batch the receiver of its SENT waybill,
 *      T9 note c) due BR-08 `recallTaskDueAt(opened_at)`; no task → CLOSED at once (BR-10, closed_at = opened_at,
 *      version 2) with `notification.dispatch` RECALL {event: CLOSED} to the inspectors (R59). A new recall always
 *      writes `recall.requested` (its handler fans out OPENED/CREATED and the rating; R89: no OPENED for a closed one).
 *
 * Every instant is the attempt's Tx::now() (P43): opened_at, created_at of the recall and its tasks, closed_at.
 * Callers add their own rows, drop the public pages of `changedCodes` after the commit (R82) and publish nothing
 * themselves (the outbox relay does, R55).
 *
 * `$req`: sourceBatchId, trigger (LAB|INSPECTOR|COMPLAINT), reason (required, as Express's RecallRequest),
 * blockUpstream, labTestId?, complaintId?, actorId (created_by and the transitions' author), action (operationId of the
 * audit rows).
 */
final class Engine
{
    public const OPEN_SOURCE_INDEX = 'ux_recalls_open_source';

    /**
     * The transaction options of every operation that runs the engine: REPEATABLE READ, one repeat on 40001/40P01 or
     * the open-source race (the same budget), then 409 VERSION_CONFLICT (`$conflictParams`, e.g. `{currentVersion}`).
     */
    public static function RECALL_TX(?Closure $conflictParams = null): TxOptions
    {
        return new TxOptions(
            isolation: 'repeatable read',
            conflictParams: $conflictParams,
            retryIf: fn (Throwable $e): bool => self::isOpenSourceRace($e),
        );
    }

    /** 23505 on `ux_recalls_open_source` anywhere in the exception chain. */
    public static function isOpenSourceRace(Throwable $e): bool
    {
        for ($x = $e; $x !== null; $x = $x->getPrevious()) {
            if (Renderer::sqlState($x) !== '23505') {
                continue;
            }
            $message = $x instanceof PDOException && is_array($x->errorInfo) ? (string) ($x->errorInfo[2] ?? '') : '';

            if (str_contains($message.' '.$x->getMessage(), '"'.self::OPEN_SOURCE_INDEX.'"')) {
                return true;
            }
        }

        return false;
    }

    /** Step 1: the OPEN, non-deleted recall of the source batch, if any. */
    public static function findOpen(string $sourceBatchId): ?object
    {
        self::inTx('findOpen');

        return DB::selectOne("SELECT id FROM recalls WHERE source_batch_id = ? AND status = 'OPEN' AND deleted_at IS NULL",
            [$sourceBatchId]);
    }

    /**
     * Steps 1–7 for an operation that locks nothing else of the batches (createRecall, decideComplaint RECALL): reuse
     * → scope → one `FOR NO KEY UPDATE ORDER BY id` over the source and the members → apply. Inside Tx::run(…, RECALL_TX()).
     *
     * @param  array<string, mixed>  $req
     */
    public static function start(array $req): RecallOutcome
    {
        self::inTx('start');
        $open = self::findOpen($req['sourceBatchId']);
        if ($open !== null) {
            return RecallOutcome::reused($open->id);
        }
        $members = RecallScope::of($req['sourceBatchId'], (bool) $req['blockUpstream']);
        $locked = Locks::batches(array_map(fn ($m) => $m['batchId'], $members));

        return self::apply($req, $members, $locked);
    }

    /**
     * Steps 4–7 over the locked members ($lockedById holds every member's locked row, the source included — in its
     * current state, e.g. already OnTest → Blocked). Assumes step 1 found no OPEN recall.
     *
     * @param  array<string, mixed>  $req
     * @param  list<array{batchId: string, direction: string, depth: int}>  $members
     * @param  array<string, object>  $lockedById
     */
    public static function apply(array $req, array $members, array $lockedById): RecallOutcome
    {
        self::inTx('apply');
        $now = Tx::now();
        $nowIso = (string) Iso::fromPg($now);
        $sourceId = $req['sourceBatchId'];
        $source = $lockedById[$sourceId] ?? throw new LogicException("recall source {$sourceId} is not locked");
        $actor = $req['actorId'];
        $action = $req['action'];
        $labTestId = $req['labTestId'] ?? null;
        $complaintId = $req['complaintId'] ?? null;
        $blockUpstream = (bool) $req['blockUpstream'];

        $recall = DB::selectOne("INSERT INTO recalls (source_batch_id, trigger, reason, status, block_upstream, lab_test_id,
                complaint_id, opened_at, version, created_by, created_at, updated_at)
             VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?::timestamptz, 1, ?, ?::timestamptz, ?::timestamptz) RETURNING id",
            [$sourceId, $req['trigger'], $req['reason'], $blockUpstream, $labTestId, $complaintId, $now, $actor, $now, $now]);

        $dueAt = Dates::recallTaskDueAt(['openedAt' => $nowIso])['dueAt'];
        $changedCodes = [];
        $taskIds = [];
        usort($members, fn ($a, $b) => Strings::compareCodePoints($a['batchId'], $b['batchId']));
        foreach ($members as $m) {
            $b = $lockedById[$m['batchId']] ?? null;
            if ($b === null) {
                continue; // gone between the walk and the lock: not a member
            }
            $before = $b->status;
            DB::insert('INSERT INTO recall_batches (recall_id, batch_id, direction, depth, status_before) VALUES (?, ?, ?, ?, ?)',
                [$recall->id, $b->id, $m['direction'], $m['depth'], $before]);
            // Processed, Sold, WrittenOff and already Recalled keep their status and get no task (§5.1).
            if (! Lifecycle::canGo($before, 'Recalled')) {
                continue;
            }
            $holder = self::taskHolder($b, $before);
            $v = Lifecycle::transition($b, 'Recalled', 'RECALLED', $actor);
            $changedCodes[] = $b->public_code;
            AuditLog::write($actor, $action, 'batch', $b->id, ['status' => [$before, 'Recalled'], 'version' => [(int) $b->version, $v]]);
            if ($holder === null) {
                continue;
            }
            $task = DB::selectOne("INSERT INTO recall_tasks (recall_id, holder_org_id, batch_id, due_at, status, version, created_at, updated_at)
                 VALUES (?, ?, ?, ?::timestamptz, 'OPEN', 1, ?::timestamptz, ?::timestamptz) RETURNING id",
                [$recall->id, $holder, $b->id, $dueAt, $now, $now]);
            $taskIds[] = $task->id;
            AuditLog::write($actor, $action, 'recallTask', $task->id, AuditLog::diff(null, [
                'recallId' => $recall->id,
                'batchId' => $b->id,
                'holderOrgId' => $holder,
                'dueAt' => $dueAt,
                'status' => 'OPEN',
                'version' => 1,
            ]));
        }

        $closed = Rules::shouldCloseRecall(['taskStatuses' => array_map(fn () => 'OPEN', $taskIds)])['close'];
        if ($closed) {
            DB::update("UPDATE recalls SET status = 'CLOSED', closed_at = ?::timestamptz, version = 2 WHERE id = ?", [$now, $recall->id]);
        }
        AuditLog::write($actor, $action, 'recall', $recall->id, AuditLog::diff(null, [
            'sourceBatchId' => $sourceId,
            'trigger' => $req['trigger'],
            'reason' => $req['reason'],
            'status' => $closed ? 'CLOSED' : 'OPEN',
            'blockUpstream' => $blockUpstream,
            'labTestId' => $labTestId,
            'complaintId' => $complaintId,
            'openedAt' => $nowIso,
            'closedAt' => $closed ? $nowIso : null,
            'version' => $closed ? 2 : 1,
        ]));
        if ($closed) {
            Lifecycle::notify('RECALL', ['roles' => ['INSPECTOR']], [
                'recallId' => $recall->id,
                'event' => 'CLOSED',
                'sourceBatchId' => $sourceId,
                'publicCode' => $source->public_code,
                'trigger' => $req['trigger'],
            ]);
        }
        $requested = Outbox::enqueue('recall.requested', [
            'recallId' => $recall->id,
            'sourceBatchId' => $sourceId,
            'trigger' => $req['trigger'],
            'openedBy' => $actor,
        ]);

        return new RecallOutcome($recall->id, true, $closed, $changedCodes, $taskIds, [$requested]);
    }

    /** The organization holding the recall task of a batch: its holder, or for InTransit the SENT waybill's receiver. */
    private static function taskHolder(object $b, string $statusBefore): ?string
    {
        if ($statusBefore === 'InTransit') {
            $w = DB::selectOne("SELECT w.receiver_org_id FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id
                 WHERE wi.batch_id = ? AND w.status = 'SENT' AND w.deleted_at IS NULL LIMIT 1", [$b->id]);
            if ($w !== null) {
                return $w->receiver_org_id;
            }
        }

        return $b->holder_org_id;
    }

    private static function inTx(string $fn): void
    {
        if (! Tx::active()) {
            throw new LogicException("Engine::{$fn} outside Tx::run(…, Engine::RECALL_TX())");
        }
    }
}
