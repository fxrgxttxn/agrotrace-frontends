<?php

namespace App\Actions\Complaints;

use App\Actions\Batches\BatchesActions;
use App\Actions\Batches\BatchView;
use App\Actions\Lab\Assign;
use App\Actions\Recalls\Engine;
use App\Actions\Recalls\RecallOutcome;
use App\Contract\RulesRepo;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\ComplaintSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Queries\ActorRefs;
use App\Queries\PublicCache;
use App\Security\Principal;
use App\Support\Iso;
use App\Support\UtcDays;
use Illuminate\Support\Facades\DB;

/**
 * Complaints (contracts/openapi/paths/complaints.yaml; БП-6, FR-QA-08; entity-state-machines.json `complaint`; Express
 * complaints/service.ts line by line), INSPECTOR only: the list, the card (with the buyer's contact), review (NEW →
 * IN_REVIEW) and the final decision (NEW | IN_REVIEW → DECIDED): REJECT; LAB_TEST — an unplanned test like
 * createLabTest with reason COMPLAINT in `labOrgId` (Lab\Assign, which also sends LAB_ASSIGNED); RECALL — the recall
 * engine (trigger COMPLAINT, reason = comment, complaintId; an OPEN recall of the batch is reused, R54/D15) at
 * REPEATABLE READ (Engine::RECALL_TX).
 *
 * Locks (R47, R52): the complaint `FOR NO KEY UPDATE` first; RECALL then the batches in one `FOR NO KEY UPDATE ORDER BY
 * id` (the engine). Every check from 404 on runs over the locked complaint. decided_at is Tx::now() (P43).
 */
final class ComplaintsActions
{
    private const SORT = ['createdAt', 'decidedAt'];

    private const STATUSES = ['NEW', 'IN_REVIEW', 'DECIDED'];

    private const DECISIONS = ['REJECT', 'LAB_TEST', 'RECALL'];

    private const COLUMNS = 'id, batch_id, text, contact, status, decision, decision_comment, inspector_id, lab_test_id,
        recall_id, created_at::text AS created_at, decided_at::text AS decided_at, deleted_at::text AS deleted_at';

    private static function notFound(): Problem
    {
        return new Problem(404, ProblemCode::NOT_FOUND);
    }

    public static function canGo(string $from, string $to): bool
    {
        foreach (RulesRepo::json('entity-state-machines')['complaint']['transitions'] as $t) {
            if ($t['from'] === $from && $t['to'] === $to) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string, mixed> */
    private static function audit(object $r): array
    {
        return [
            'status' => $r->status,
            'decision' => $r->decision,
            'decisionComment' => $r->decision_comment,
            'inspectorId' => $r->inspector_id,
            'labTestId' => $r->lab_test_id,
            'recallId' => $r->recall_id,
            'decidedAt' => Iso::fromPg($r->decided_at),
        ];
    }

    /**
     * `Complaint` of $ids in the order of $ids (missing ids skipped).
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    private static function views(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $rows = DB::select('SELECT '.self::COLUMNS." FROM complaints WHERE id IN ({$marks})", $ids);
        $batches = [];
        foreach (BatchView::listItems(array_map(fn ($r) => $r->batch_id, $rows)) as $b) {
            $batches[$b['id']] = $b;
        }
        $actors = ActorRefs::of(array_map(fn ($r) => $r->inspector_id, $rows));
        $byId = [];
        foreach ($rows as $r) {
            $byId[$r->id] = $r;
        }
        $out = [];
        foreach ($ids as $id) {
            $r = $byId[$id] ?? null;
            if ($r === null) {
                continue;
            }
            $out[] = [
                'id' => $r->id,
                'batch' => $batches[$r->batch_id],
                'text' => $r->text,
                'status' => $r->status,
                'decision' => $r->decision,
                'createdAt' => Iso::fromPg($r->created_at),
                'decidedAt' => Iso::fromPg($r->decided_at),
                'contact' => $r->contact,
                'decisionComment' => $r->decision_comment,
                'inspector' => $r->inspector_id !== null ? ($actors[$r->inspector_id] ?? null) : null,
                'labTestId' => $r->lab_test_id,
                'recallId' => $r->recall_id,
            ];
        }

        return $out;
    }

    /** @return array<string, mixed> */
    private static function card(string $id): array
    {
        return self::views([$id])[0] ?? throw self::notFound();
    }

    /** The non-deleted complaint `FOR NO KEY UPDATE` (R52 `complaint`), else 404. */
    private static function lock(string $id): object
    {
        $r = DB::selectOne('SELECT '.self::COLUMNS.' FROM complaints WHERE id = ? FOR NO KEY UPDATE', [$id]);
        if ($r === null || $r->deleted_at !== null) {
            throw self::notFound();
        }

        return $r;
    }

    /**
     * listComplaints — non-deleted complaints; filters joined by AND; `x-sort` with nulls last, ties by id as text.
     *
     * @return array<string, mixed>
     */
    public static function list(QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(self::SORT, 'createdAt,desc');
        $text = $q->q();
        $statuses = $q->enums('status', self::STATUSES);
        $decisions = $q->enums('decision', self::DECISIONS);
        $batchId = $q->uuid('batchId');
        ['from' => $from, 'to' => $to] = $q->dateRange();
        $q->done();

        $where = ['c.deleted_at IS NULL'];
        $bindings = [];
        foreach (['c.status' => $statuses, 'c.decision' => $decisions] as $column => $values) {
            if ($values !== null) {
                $where[] = "{$column} IN (".implode(',', array_fill(0, count($values), '?')).')';
                array_push($bindings, ...$values);
            }
        }
        if ($batchId !== null) {
            $where[] = 'c.batch_id = ?';
            $bindings[] = $batchId;
        }
        // from/to — by the UTC date of createdAt.
        [$days, $dayBindings] = UtcDays::range('c.created_at', $from, $to);
        array_push($where, ...$days);
        array_push($bindings, ...$dayBindings);
        if ($text !== null) {
            $where[] = '(position(lower(?) in lower(b.public_code)) > 0 OR position(lower(?) in lower(c.text)) > 0)';
            array_push($bindings, $text, $text);
        }
        $cond = implode(' AND ', $where);
        $fromSql = 'FROM complaints c JOIN batches b ON b.id = c.batch_id';
        $total = (int) DB::selectOne("SELECT count(*) AS total {$fromSql} WHERE {$cond}", $bindings)->total;
        $order = $sort['field'] === 'decidedAt' ? 'c.decided_at' : 'c.created_at';
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $offset = ((int) $page - 1) * $size;
        $ids = array_map(fn ($r) => $r->id, DB::select("SELECT c.id {$fromSql} WHERE {$cond}
            ORDER BY {$order} {$dir} NULLS LAST, c.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, $offset]));
        $items = array_map(fn (array $v) => [
            'id' => $v['id'],
            'batch' => $v['batch'],
            'text' => $v['text'],
            'status' => $v['status'],
            'decision' => $v['decision'],
            'createdAt' => $v['createdAt'],
            'decidedAt' => $v['decidedAt'],
        ], self::views($ids));

        return ['items' => $items, 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /** @return array<string, mixed> */
    public static function get(string $id): array
    {
        if (DB::selectOne('SELECT id FROM complaints WHERE id = ? AND deleted_at IS NULL', [$id]) === null) {
            throw self::notFound();
        }

        return self::card($id);
    }

    /**
     * startComplaintReview — body (400) → lock → 404 → NEW only → IN_REVIEW, inspector = the user.
     *
     * @return array<string, mixed>
     */
    public static function review(Principal $p, string $id, mixed $body): array
    {
        ComplaintSchemas::parseReview($body);
        Tx::run(function () use ($p, $id): void {
            $r = self::lock($id);
            if (! self::canGo($r->status, 'IN_REVIEW')) {
                throw BatchesActions::invalidTransition(['from' => $r->status, 'to' => 'IN_REVIEW']);
            }
            $after = DB::selectOne("UPDATE complaints SET status = 'IN_REVIEW', inspector_id = ? WHERE id = ? RETURNING ".self::COLUMNS,
                [$p->userId, $id]);
            AuditLog::write($p->userId, 'startComplaintReview', 'complaint', $id, AuditLog::diff(self::audit($r), self::audit($after)));
        });

        return self::card($id);
    }

    /**
     * decideComplaint — body (400, with the decision rules) → lock → 404 → DECIDED → (LAB_TEST) the laboratory (400)
     * → DECIDED with the decision's effect. RECALL runs at REPEATABLE READ (the engine); its pages are dropped after
     * the commit with no DB slot held (P61), `recall.requested` is relayed after the response (the outbox).
     *
     * @return array<string, mixed>
     */
    public static function decide(Principal $p, string $id, mixed $body): array
    {
        $input = ComplaintSchemas::parseDecision($body);
        $decision = $input['decision'];
        $changed = Tx::run(function () use ($p, $id, $input, $decision): array {
            $r = self::lock($id);
            if (! self::canGo($r->status, 'DECIDED')) {
                throw BatchesActions::invalidTransition(['from' => $r->status, 'to' => 'DECIDED']);
            }
            $b = DB::selectOne('SELECT b.id, b.public_code, b.origin_org_id, pr.name AS product_name
                  FROM batches b JOIN products pr ON pr.id = b.product_id WHERE b.id = ?', [$r->batch_id]);
            $labTestId = null;
            $recallId = null;
            $changed = [];
            if ($decision === 'LAB_TEST') {
                $lab = DB::selectOne('SELECT id, name, type, status FROM organizations WHERE id = ? AND deleted_at IS NULL',
                    [strtolower($input['labOrgId'])]);
                if ($lab === null || $lab->status !== 'ACTIVE') {
                    throw Problem::validation(['labOrgId' => ['validation.notFound']]);
                }
                if ($lab->type !== 'LAB') {
                    throw Problem::validation(['labOrgId' => ['validation.labOrg.type']]);
                }
                $labTestId = Assign::insertUnplanned($b, $lab, 'COMPLAINT', $p->userId, 'decideComplaint')['id'];
            }
            if ($decision === 'RECALL') {
                /** @var RecallOutcome $outcome */
                $outcome = Engine::start([
                    'sourceBatchId' => $b->id,
                    'trigger' => 'COMPLAINT',
                    'reason' => $input['comment'],
                    'blockUpstream' => $input['blockUpstream'] ?? false,
                    'complaintId' => $id,
                    'actorId' => $p->userId,
                    'action' => 'decideComplaint',
                ]);
                $recallId = $outcome->recallId;
                $changed = $outcome->changedCodes;
            }
            $after = DB::selectOne("UPDATE complaints SET status = 'DECIDED', decision = ?, decision_comment = ?, inspector_id = ?,
                    decided_at = ?::timestamptz, lab_test_id = ?, recall_id = ? WHERE id = ? RETURNING ".self::COLUMNS,
                [$decision, $input['comment'], $p->userId, Tx::now(), $labTestId, $recallId, $id]);
            AuditLog::write($p->userId, 'decideComplaint', 'complaint', $id, AuditLog::diff(self::audit($r), self::audit($after)));

            return $changed;
        }, $decision === 'RECALL' ? Engine::RECALL_TX() : null);
        try {
            $card = self::card($id);
        } finally {
            // R82 after the commit, with no DB slot held (P61) — and even when the card read fails (T8 review M1).
            if ($changed !== []) {
                SlotHolder::release();
                PublicCache::dropCodes($changed);
            }
        }

        return $card;
    }
}
