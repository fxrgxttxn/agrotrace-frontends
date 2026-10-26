<?php

namespace App\Actions\Recalls;

use App\Actions\Batches\BatchesActions;
use App\Actions\Batches\Lifecycle;
use App\Domain\Rules;
use App\Http\IfMatch;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\RecallSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Locks;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Db\TxOptions;
use App\Queries\PublicCache;
use App\Security\Principal;
use App\Support\Iso;
use App\Support\UtcDays;
use Illuminate\Support\Facades\DB;
use LogicException;

/**
 * Recalls and recall tasks (contracts/openapi/paths/recalls.yaml, recall-tasks.yaml; БП-5, FR-QA-06/07, BR-08, BR-10,
 * R47/R52/R54; Express recalls/service.ts line by line): the register, the card and the graph (INSPECTOR, ADMIN), the
 * manual recall (INSPECTOR — the engine at REPEATABLE READ, Engine::RECALL_TX), the tasks (their holders and
 * INSPECTOR) and their confirmation.
 *
 * confirmRecallTask locks in the R52 order (P57): the task is read without a lock to learn its recall and batch, then
 * the recall `FOR NO KEY UPDATE`, the batch (Locks::batches), the task (Locks::recallTasks); every check from 404 on
 * runs over the locked rows, `If-Match` is a compare-and-set on the task. Two confirmations of one recall serialize on
 * the recall row, so exactly one of them sees every task CONFIRMED and closes it (BR-10). Every instant it writes is
 * the one Tx::now() (P43: confirmed_at = closed_at).
 */
final class RecallsActions
{
    private const RECALL_SORT = ['openedAt', 'closedAt'];

    private const TASK_SORT = ['dueAt', 'createdAt', 'confirmedAt'];

    private const TRIGGERS = ['LAB', 'INSPECTOR', 'COMPLAINT'];

    private const TASK_STATUSES = ['OPEN', 'CONFIRMED', 'OVERDUE'];

    private const OVERDUE_SQL = "(t.status <> 'CONFIRMED' AND now() > t.due_at)";

    private static function notFound(): Problem
    {
        return new Problem(404, ProblemCode::NOT_FOUND);
    }

    /**
     * @param  list<string>  $values
     * @param  list<string>  $where
     * @param  list<mixed>  $bindings
     */
    private static function in(string $column, array $values, array &$where, array &$bindings): void
    {
        $where[] = "{$column} IN (".implode(',', array_fill(0, count($values), '?')).')';
        array_push($bindings, ...$values);
    }

    /** @return array<string, mixed> */
    private static function taskAudit(object $t): array
    {
        return [
            'status' => $t->status,
            'confirmedAt' => Iso::fromPg($t->confirmed_at),
            'confirmedBy' => $t->confirmed_by,
            'version' => (int) $t->version,
        ];
    }

    /**
     * listRecalls — every non-deleted recall; filters joined by AND; `x-sort` with nulls last, ties by id as text.
     *
     * @return array<string, mixed>
     */
    public static function list(QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(self::RECALL_SORT, 'openedAt,desc');
        $text = $q->q();
        $status = $q->enum('status', ['OPEN', 'CLOSED']);
        $triggers = $q->enums('trigger', self::TRIGGERS);
        $batchId = $q->uuid('batchId');
        ['from' => $from, 'to' => $to] = $q->dateRange();
        $q->done();

        $where = ['r.deleted_at IS NULL'];
        $bindings = [];
        if ($status !== null) {
            $where[] = 'r.status = ?';
            $bindings[] = $status;
        }
        if ($triggers !== null) {
            self::in('r.trigger', $triggers, $where, $bindings);
        }
        if ($batchId !== null) {
            $where[] = 'EXISTS (SELECT 1 FROM recall_batches rb WHERE rb.recall_id = r.id AND rb.batch_id = ?)';
            $bindings[] = $batchId;
        }
        // from/to — by the UTC date of openedAt.
        [$days, $dayBindings] = UtcDays::range('r.opened_at', $from, $to);
        array_push($where, ...$days);
        array_push($bindings, ...$dayBindings);
        if ($text !== null) {
            $where[] = 'position(lower(?) in lower(b.public_code)) > 0';
            $bindings[] = $text;
        }
        $cond = implode(' AND ', $where);
        $fromSql = 'FROM recalls r JOIN batches b ON b.id = r.source_batch_id';
        $total = (int) DB::selectOne("SELECT count(*) AS total {$fromSql} WHERE {$cond}", $bindings)->total;
        $order = $sort['field'] === 'closedAt' ? 'r.closed_at' : 'r.opened_at';
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $ids = array_map(fn ($r) => $r->id, DB::select("SELECT r.id {$fromSql} WHERE {$cond}
            ORDER BY {$order} {$dir} NULLS LAST, r.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]));

        return ['items' => RecallView::items($ids), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /** @return array<string, mixed> */
    public static function get(string $id): array
    {
        return RecallView::card($id) ?? throw self::notFound();
    }

    /** @return array<string, mixed> */
    public static function graph(string $id): array
    {
        return RecallView::graph($id) ?? throw self::notFound();
    }

    /**
     * createRecall — body (400) → the source non-deleted (else 400 sourceBatchId notFound; any status) → the engine
     * (trigger INSPECTOR, the body's reason and blockUpstream, the user as author). 201 — a new recall (its pages
     * dropped after the commit; `recall.requested` relayed after the response); 200 — the OPEN recall of the source,
     * unchanged. The source check is inside the transaction, so a repeated attempt checks again.
     *
     * @return array{status: int, body: array<string, mixed>}
     */
    public static function create(Principal $p, mixed $body): array
    {
        $input = RecallSchemas::parseCreate($body);
        $sourceBatchId = strtolower($input['sourceBatchId']);
        $outcome = Tx::run(function () use ($p, $input, $sourceBatchId): RecallOutcome {
            if (DB::selectOne('SELECT id FROM batches WHERE id = ? AND deleted_at IS NULL', [$sourceBatchId]) === null) {
                throw Problem::validation(['sourceBatchId' => ['validation.notFound']]);
            }

            return Engine::start([
                'sourceBatchId' => $sourceBatchId,
                'trigger' => 'INSPECTOR',
                'reason' => $input['reason'],
                'blockUpstream' => $input['blockUpstream'],
                'actorId' => $p->userId,
                'action' => 'createRecall',
            ]);
        }, Engine::RECALL_TX());
        try {
            $card = RecallView::card($outcome->recallId) ?? throw new LogicException("recall {$outcome->recallId} vanished");
        } finally {
            // R82 after the commit, with no DB slot held (P61) — and even when the card read fails (T8 review M1).
            if ($outcome->changedCodes !== []) {
                SlotHolder::release();
                PublicCache::dropCodes($outcome->changedCodes);
            }
        }

        return ['status' => $outcome->created ? 201 : 200, 'body' => $card];
    }

    /**
     * listRecallTasks — holders see their organization's tasks, INSPECTOR every task (R51: holderOrgId for INSPECTOR
     * only); tasks of soft-deleted recalls are hidden.
     *
     * @return array<string, mixed>
     */
    public static function listTasks(Principal $p, QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(self::TASK_SORT, 'dueAt,asc');
        $text = $q->q();
        $statuses = $q->enums('status', self::TASK_STATUSES);
        $overdue = $q->bool('overdue');
        $recallId = $q->uuid('recallId');
        $inspector = $p->hasRole('INSPECTOR');
        $holderOrgId = null;
        if ($inspector) {
            $holderOrgId = $q->uuid('holderOrgId');
        } else {
            $q->notAllowed('holderOrgId');
        }
        $q->done();

        $where = ['r.deleted_at IS NULL'];
        $bindings = [];
        if (! $inspector) {
            $where[] = 't.holder_org_id = ?';
            $bindings[] = $p->orgId;
        }
        if ($statuses !== null) {
            self::in('t.status', $statuses, $where, $bindings);
        }
        if ($overdue !== null) {
            $where[] = $overdue ? self::OVERDUE_SQL : 'NOT '.self::OVERDUE_SQL;
        }
        if ($recallId !== null) {
            $where[] = 't.recall_id = ?';
            $bindings[] = $recallId;
        }
        if ($holderOrgId !== null) {
            $where[] = 't.holder_org_id = ?';
            $bindings[] = $holderOrgId;
        }
        if ($text !== null) {
            $where[] = 'position(lower(?) in lower(b.public_code)) > 0';
            $bindings[] = $text;
        }
        $cond = implode(' AND ', $where);
        $fromSql = 'FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id JOIN batches b ON b.id = t.batch_id';
        $total = (int) DB::selectOne("SELECT count(*) AS total {$fromSql} WHERE {$cond}", $bindings)->total;
        $order = match ($sort['field']) {
            'createdAt' => 't.created_at',
            'confirmedAt' => 't.confirmed_at',
            default => 't.due_at',
        };
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $ids = array_map(fn ($r) => $r->id, DB::select("SELECT t.id {$fromSql} WHERE {$cond}
            ORDER BY {$order} {$dir} NULLS LAST, t.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]));

        return ['items' => RecallView::tasks($ids), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /** @return array{currentVersion: int}|null */
    private static function taskVersion(string $id): ?array
    {
        $r = DB::selectOne('SELECT version FROM recall_tasks WHERE id = ?', [$id]);

        return $r !== null ? ['currentVersion' => (int) $r->version] : null;
    }

    /**
     * confirmRecallTask — body/If-Match (one 400, the controller) → locks (recall → batch → task) → 404 (no such task,
     * a deleted recall, holder ≠ the user's organization) → If-Match → CONFIRMED → batch not Recalled → the task
     * CONFIRMED, the batch WrittenOff, and — the last open task — the recall CLOSED with RECALL CLOSED to the
     * inspectors.
     *
     * @return array<string, mixed>
     */
    public static function confirm(Principal $p, string $id, int $version): array
    {
        $codes = Tx::run(function () use ($p, $id, $version): array {
            $t0 = DB::selectOne('SELECT recall_id, batch_id FROM recall_tasks WHERE id = ?', [$id]);
            if ($t0 === null) {
                throw self::notFound();
            }
            $recall = DB::selectOne('SELECT id, source_batch_id, trigger, status, version, deleted_at FROM recalls
                 WHERE id = ? FOR NO KEY UPDATE', [$t0->recall_id]);
            $b = Locks::batches([$t0->batch_id])[$t0->batch_id] ?? null;
            $t = Locks::recallTasks([$id])[0] ?? null;
            if ($recall === null || $b === null || $t === null || $recall->deleted_at !== null || $t->holder_org_id !== $p->orgId) {
                throw self::notFound();
            }
            IfMatch::check($version, (int) $t->version);
            if ($t->status === 'CONFIRMED') {
                throw BatchesActions::invalidTransition(['from' => 'CONFIRMED', 'to' => 'CONFIRMED']);
            }
            if ($b->status !== 'Recalled') {
                throw BatchesActions::invalidTransition(['from' => $b->status, 'to' => 'WrittenOff', 'publicCode' => $b->public_code]);
            }

            $now = Tx::now();
            $after = DB::selectOne("UPDATE recall_tasks SET status = 'CONFIRMED', confirmed_at = ?::timestamptz, confirmed_by = ?, version = ?
                 WHERE id = ? RETURNING status, confirmed_at::text AS confirmed_at, confirmed_by, version",
                [$now, $p->userId, (int) $t->version + 1, $id]);
            AuditLog::write($p->userId, 'confirmRecallTask', 'recallTask', $id, AuditLog::diff(self::taskAudit($t), self::taskAudit($after)));
            $v = Lifecycle::transition($b, 'WrittenOff', 'WRITTEN_OFF', $p->userId);
            AuditLog::write($p->userId, 'confirmRecallTask', 'batch', $b->id, ['status' => [$b->status, 'WrittenOff'], 'version' => [(int) $b->version, $v]]);

            $statuses = array_map(fn ($s) => $s->status, DB::select('SELECT status FROM recall_tasks WHERE recall_id = ?', [$recall->id]));
            if ($recall->status === 'OPEN' && Rules::shouldCloseRecall(['taskStatuses' => $statuses])['close']) {
                $rv = (int) $recall->version;
                DB::update("UPDATE recalls SET status = 'CLOSED', closed_at = ?::timestamptz, version = ? WHERE id = ?", [$now, $rv + 1, $recall->id]);
                AuditLog::write($p->userId, 'confirmRecallTask', 'recall', $recall->id, [
                    'status' => ['OPEN', 'CLOSED'],
                    'closedAt' => [null, Iso::fromPg($now)],
                    'version' => [$rv, $rv + 1],
                ]);
                $source = DB::selectOne('SELECT public_code FROM batches WHERE id = ?', [$recall->source_batch_id]);
                Lifecycle::notify('RECALL', ['roles' => ['INSPECTOR']], [
                    'recallId' => $recall->id,
                    'event' => 'CLOSED',
                    'sourceBatchId' => $recall->source_batch_id,
                    'publicCode' => $source->public_code,
                    'trigger' => $recall->trigger,
                ]);
            }

            return [$b->public_code];
        }, new TxOptions(conflictParams: fn () => self::taskVersion($id)));
        try {
            return RecallView::tasks([$id])[0] ?? throw new LogicException("recall task {$id} vanished");
        } finally {
            // R82 after the commit, with no DB slot held (P61) — and even when the view read fails (T8 review M1).
            SlotHolder::release();
            PublicCache::dropCodes($codes);
        }
    }
}
