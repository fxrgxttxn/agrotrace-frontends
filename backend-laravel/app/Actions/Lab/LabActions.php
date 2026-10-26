<?php

namespace App\Actions\Lab;

use App\Actions\Batches\BatchesActions;
use App\Actions\Batches\Lifecycle;
use App\Actions\Recalls\Engine;
use App\Domain\Decimal;
use App\Domain\Rules;
use App\Http\IfMatch;
use App\Http\Multipart\Upload;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\LabSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Locks;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Db\TxOptions;
use App\Infrastructure\Files\Files;
use App\Infrastructure\Outbox\Outbox;
use App\Queries\PublicCache;
use App\Queries\RecallScope;
use App\Security\Principal;
use App\Support\Iso;
use App\Support\UtcDays;
use Illuminate\Support\Facades\DB;
use LogicException;
use stdClass;

/**
 * Lab tests (contracts/openapi/paths/lab.yaml; БП-2, FR-QA-02…05, BR-02, R47, R57; Express lab/service.ts line by
 * line): the queue, the inspector's unplanned test, sample registration, results (BR-02 conclusion; PASS → Approved,
 * FAIL → Blocked and the recall engine), the PDF protocol. Views and visibility — LabView.
 *
 * Mutations lock the test first (`labTest`, R52), then — submitLabResults only — the batches in ONE `FOR NO KEY UPDATE
 * ORDER BY id`; every check from 404 on runs over the locked test; `If-Match` is a compare-and-set against it. A LAB
 * mutation sees only its own laboratory's tests (404 otherwise). submitLabResults runs at REPEATABLE READ like the
 * recall engine (п. 8.2.3, Engine::RECALL_TX): one repeat on 40001/40P01 or the open-recall race, each with a fresh
 * snapshot and Tx::now(), then 409 VERSION_CONFLICT {currentVersion}. Redis and MinIO run with no DB slot held (P61).
 */
final class LabActions
{
    /** uploadLabProtocol: PDF ≤ 10 MiB inclusive (FR-QA-04, spec 8.6). */
    public const PROTOCOL_MAX_BYTES = 10 * 1024 * 1024;

    /** submitLabResults FAIL: `recalls.reason` (contract submitLabResults). */
    public const RECALL_REASON = 'Превышение нормативов по результатам лабораторного анализа';

    private const LIST_SORT = ['dueAt', 'createdAt', 'completedAt'];

    private const STATUSES = ['QUEUED', 'SAMPLED', 'DONE', 'ESCALATED', 'CANCELLED'];

    private const REASONS = ['PLANNED', 'RISK', 'COMPLAINT', 'INSPECTOR'];

    private const TEST_COLUMNS = 't.*, t.due_at::text AS due_at, t.sampled_at::text AS sampled_at, t.completed_at::text AS completed_at,
        t.escalated_at::text AS escalated_at, t.created_at::text AS created_at, t.updated_at::text AS updated_at,
        t.deleted_at::text AS deleted_at';

    private static function notFound(): Problem
    {
        return new Problem(404, ProblemCode::NOT_FOUND);
    }

    /** @return array<string, mixed> */
    private static function audit(stdClass $t): array
    {
        return [
            'status' => $t->status,
            'conclusion' => $t->conclusion,
            'sampledAt' => Iso::fromPg($t->sampled_at),
            'completedAt' => Iso::fromPg($t->completed_at),
            'recallId' => $t->recall_id,
            'version' => (int) $t->version,
        ];
    }

    /** The non-deleted test of the user's own laboratory, locked `FOR NO KEY UPDATE` (R52 `labTest`); else 404. */
    private static function lockOwnTest(Principal $p, string $id): stdClass
    {
        $t = DB::selectOne('SELECT '.self::TEST_COLUMNS.' FROM lab_tests t WHERE t.id = ? FOR NO KEY UPDATE OF t', [$id]);
        if ($t === null || $t->deleted_at !== null || ! $p->hasRole('LAB') || $t->lab_org_id !== $p->orgId) {
            throw self::notFound();
        }
        $b = DB::selectOne('SELECT deleted_at FROM batches WHERE id = ?', [$t->batch_id]);
        if ($b === null || $b->deleted_at !== null) {
            throw self::notFound();
        }

        return $t;
    }

    /** @return array{currentVersion: int}|null */
    private static function currentVersion(string $id): ?array
    {
        $r = DB::selectOne('SELECT version FROM lab_tests WHERE id = ?', [$id]);

        return $r !== null ? ['currentVersion' => (int) $r->version] : null;
    }

    /** Whether $p sees the test (tag Lab); 404 otherwise. */
    private static function visibleTest(Principal $p, string $id): void
    {
        [$visible, $bindings] = LabView::visibleTo($p);
        $r = DB::selectOne("SELECT t.id FROM lab_tests t JOIN batches b ON b.id = t.batch_id
             WHERE t.id = ? AND t.deleted_at IS NULL AND b.deleted_at IS NULL AND {$visible}", [$id, ...$bindings]);
        if ($r === null) {
            throw self::notFound();
        }
    }

    /**
     * listLabTests — visible tests, filters joined by AND (R51 for labOrgId), `x-sort` with nulls last, ties by id as
     * text.
     *
     * @return array<string, mixed>
     */
    public static function list(Principal $p, QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(self::LIST_SORT, 'dueAt,asc');
        $text = $q->q();
        $statuses = $q->enums('status', self::STATUSES);
        $reasons = $q->enums('reason', self::REASONS);
        $conclusion = $q->enum('conclusion', ['PASS', 'FAIL']);
        $overdue = $q->bool('overdue');
        $batchId = $q->uuid('batchId');
        $labOrgId = null;
        if ($p->seesAll()) {
            $labOrgId = $q->uuid('labOrgId');
        } else {
            $q->notAllowed('labOrgId');
        }
        ['from' => $from, 'to' => $to] = $q->dateRange();
        $q->done();

        [$visible, $bindings] = LabView::visibleTo($p);
        $where = ['t.deleted_at IS NULL', 'b.deleted_at IS NULL', $visible];
        $in = function (string $column, array $values) use (&$where, &$bindings): void {
            $where[] = "{$column} IN (".implode(',', array_fill(0, count($values), '?')).')';
            array_push($bindings, ...$values);
        };
        if ($statuses !== null) {
            $in('t.status', $statuses);
        }
        if ($reasons !== null) {
            $in('t.reason', $reasons);
        }
        if ($conclusion !== null) {
            $where[] = 't.conclusion = ?';
            $bindings[] = $conclusion;
        }
        if ($overdue !== null) {
            $where[] = $overdue ? LabView::overdueSql() : 'NOT '.LabView::overdueSql();
        }
        if ($batchId !== null) {
            $where[] = 't.batch_id = ?';
            $bindings[] = $batchId;
        }
        if ($labOrgId !== null) {
            $where[] = 't.lab_org_id = ?';
            $bindings[] = $labOrgId;
        }
        // from/to — by the UTC date of createdAt.
        [$days, $dayBindings] = UtcDays::range('t.created_at', $from, $to);
        array_push($where, ...$days);
        array_push($bindings, ...$dayBindings);
        if ($text !== null) {
            $where[] = 'position(lower(?) in lower(b.public_code)) > 0';
            $bindings[] = $text;
        }
        $cond = implode(' AND ', $where);
        $from = 'FROM lab_tests t JOIN batches b ON b.id = t.batch_id';
        $total = (int) DB::selectOne("SELECT count(*) AS total {$from} WHERE {$cond}", $bindings)->total;
        $order = match ($sort['field']) {
            'createdAt' => 't.created_at',
            'completedAt' => 't.completed_at',
            default => 't.due_at',
        };
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $ids = array_map(fn ($r) => $r->id, DB::select("SELECT t.id {$from} WHERE {$cond}
            ORDER BY {$order} {$dir} NULLS LAST, t.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]));

        return ['items' => LabView::listItems($ids), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /** @return array<string, mixed> */
    public static function get(Principal $p, string $id): array
    {
        self::visibleTest($p, $id);

        return LabView::card($p, $id);
    }

    /**
     * createLabTest — body → references in one 400 (batch non-deleted; organization non-deleted ACTIVE, of type LAB) →
     * a QUEUED INSPECTOR test due in 5 working days, LAB_ASSIGNED (lab + batch origin). No locks: no existing row
     * changes.
     *
     * @return array<string, mixed>
     */
    public static function create(Principal $p, mixed $body): array
    {
        $input = LabSchemas::parseCreate($body);
        $batchId = strtolower($input['batchId']);
        $labOrgId = strtolower($input['labOrgId']);
        $id = Tx::run(function () use ($p, $batchId, $labOrgId): string {
            $errors = [];
            $b = DB::selectOne('SELECT b.id, b.public_code, b.origin_org_id, pr.name AS product_name
                  FROM batches b JOIN products pr ON pr.id = b.product_id WHERE b.id = ? AND b.deleted_at IS NULL', [$batchId]);
            if ($b === null) {
                $errors['batchId'] = ['validation.notFound'];
            }
            $lab = DB::selectOne('SELECT id, name, type, status FROM organizations WHERE id = ? AND deleted_at IS NULL', [$labOrgId]);
            if ($lab === null || $lab->status !== 'ACTIVE') {
                $errors['labOrgId'] = ['validation.notFound'];
            } elseif ($lab->type !== 'LAB') {
                $errors['labOrgId'] = ['validation.labOrg.type'];
            }
            if ($errors !== []) {
                throw Problem::validation($errors);
            }

            return Assign::insertUnplanned($b, $lab, 'INSPECTOR', $p->userId, 'createLabTest')['id'];
        });

        return LabView::card($p, $id);
    }

    /**
     * registerLabSample — body/If-Match (400, the controller) → lock → 404 → If-Match → QUEUED → SAMPLED, sampledAt,
     * version + 1.
     *
     * @return array<string, mixed>
     */
    public static function sample(Principal $p, string $id, int $version): array
    {
        Tx::run(function () use ($p, $id, $version): void {
            $t = self::lockOwnTest($p, $id);
            IfMatch::check($version, (int) $t->version);
            if ($t->status !== 'QUEUED') {
                throw BatchesActions::invalidTransition(['from' => $t->status, 'to' => 'SAMPLED']);
            }
            $after = DB::selectOne("UPDATE lab_tests t SET status = 'SAMPLED', sampled_at = now(), version = ? WHERE t.id = ?
                 RETURNING ".self::TEST_COLUMNS, [(int) $t->version + 1, $id]);
            AuditLog::write($p->userId, 'registerLabSample', 'labTest', $id, AuditLog::diff(self::audit($t), self::audit($after)));
        }, new TxOptions(conflictParams: fn () => self::currentVersion($id)));

        return LabView::card($p, $id);
    }

    /**
     * submitLabResults — body/If-Match (400, the controller) → lock the test → 404 → If-Match → status → indicator set
     * (one 400) → lock the batch (PASS) or the batch and the recall scope (FAIL) in one statement → results, the batch
     * transition (only from OnTest), FAIL: the recall engine (new, or the OPEN one reused, R57) → DONE → LAB_RESULT,
     * rating.recalculate (FARM origin). The public pages are dropped after the commit, whatever the batch status (R82:
     * labSummary).
     *
     * @param  array{results: list<array{indicatorId: string, value: string}>}  $input
     * @return array<string, mixed>
     */
    public static function submit(Principal $p, string $id, int $version, array $input): array
    {
        $codes = Tx::run(function () use ($p, $id, $version, $input): array {
            $t = self::lockOwnTest($p, $id);
            IfMatch::check($version, (int) $t->version);
            if (! in_array($t->status, LabView::OPEN, true)) {
                throw BatchesActions::invalidTransition(['from' => $t->status, 'to' => 'DONE']);
            }

            // 5. The exact indicator set of the test's norms (D4) — duplicates and mismatch in one 400. Norms: no lock (D7).
            $batch0 = DB::selectOne('SELECT b.product_id, pr.name AS product_name, o.type AS origin_type
                  FROM batches b JOIN products pr ON pr.id = b.product_id JOIN organizations o ON o.id = b.origin_org_id
                 WHERE b.id = ?', [$t->batch_id]);
            if ($batch0 === null) {
                throw new LogicException("lab test {$id}: batch {$t->batch_id} vanished");
            }
            $normOf = [];
            foreach (LabView::currentNorms($batch0->product_id) as $n) {
                $normOf[$n['indicatorId']] = $n;
            }
            $ids = array_map(fn ($r) => strtolower($r['indicatorId']), $input['results']);
            $errors = [];
            $seen = [];
            foreach ($ids as $i => $x) {
                if (isset($seen[$x])) {
                    $errors["results[{$i}].indicatorId"] = ['validation.duplicate'];
                }
                $seen[$x] = true;
            }
            $mismatch = count($seen) !== count($normOf);
            foreach (array_keys($seen) as $x) {
                $mismatch = $mismatch || ! isset($normOf[$x]);
            }
            if ($mismatch) {
                $errors['results'] = ['validation.results.mismatch'];
            }
            if ($errors !== []) {
                throw Problem::validation($errors);
            }

            $rows = [];
            foreach ($input['results'] as $i => $r) {
                $rows[] = ['indicatorId' => $ids[$i], 'value' => $r['value'], 'maxValue' => $normOf[$ids[$i]]['maxValue']];
            }
            $concluded = Rules::concludeLabTest(['results' => $rows]);
            if (! isset($concluded['conclusion'])) {
                throw new LogicException('concludeLabTest: no results'); // unreachable: minItems 1
            }
            $conclusion = $concluded['conclusion'];

            // Locks of the batches (R52): the test's batch, plus — FAIL without an OPEN recall — the recall scope.
            $open = $conclusion === 'FAIL' ? Engine::findOpen($t->batch_id) : null;
            $scope = $conclusion === 'FAIL' && $open === null ? RecallScope::of($t->batch_id, false) : [];
            $locked = Locks::batches([$t->batch_id, ...array_map(fn ($m) => $m['batchId'], $scope)]);
            $b = $locked[$t->batch_id];

            $values = [];
            $bindings = [];
            foreach ($rows as $r) {
                $values[] = '(?, ?, ?, ?, ?)';
                array_push($bindings, $id, $r['indicatorId'], $r['value'], $r['maxValue'], Decimal::compare($r['value'], $r['maxValue']) > 0);
            }
            DB::insert('INSERT INTO lab_results (lab_test_id, indicator_id, value, norm_value_snapshot, is_exceeded) VALUES '
                .implode(', ', $values), $bindings);
            // The batch page shows labSummary (R82): dropped after every result, whatever the batch status.
            $changed = [$b->public_code];
            if ($b->status === 'OnTest') {
                $to = $conclusion === 'PASS' ? 'Approved' : 'Blocked';
                $v = Lifecycle::transition($b, $to, $conclusion === 'PASS' ? 'LAB_PASS' : 'LAB_FAIL', $p->userId);
                AuditLog::write($p->userId, 'submitLabResults', 'batch', $b->id, ['status' => [$b->status, $to], 'version' => [(int) $b->version, $v]]);
                $moved = clone $b;
                $moved->status = $to;
                $moved->version = $v;
                $locked[$b->id] = $moved;
            }
            $recallId = null;
            if ($conclusion === 'FAIL') {
                if ($open !== null) {
                    $recallId = $open->id;
                } else {
                    $outcome = Engine::apply([
                        'sourceBatchId' => $t->batch_id,
                        'trigger' => 'LAB',
                        'reason' => self::RECALL_REASON,
                        'blockUpstream' => false,
                        'labTestId' => $id,
                        'actorId' => $p->userId,
                        'action' => 'submitLabResults',
                    ], $scope, $locked);
                    $recallId = $outcome->recallId;
                    array_push($changed, ...$outcome->changedCodes);
                }
            }
            $after = DB::selectOne("UPDATE lab_tests t SET status = 'DONE', conclusion = ?, completed_at = now(),
                    sampled_at = coalesce(t.sampled_at, now()), recall_id = ?, version = ?
                 WHERE t.id = ? RETURNING ".self::TEST_COLUMNS, [$conclusion, $recallId, (int) $t->version + 1, $id]);
            AuditLog::write($p->userId, 'submitLabResults', 'labTest', $id, [
                ...AuditLog::diff(self::audit($t), self::audit($after)),
                'results' => [null, array_map(fn ($r) => [
                    'indicatorId' => $r['indicatorId'],
                    'value' => $r['value'],
                    'normValue' => $r['maxValue'],
                    'isExceeded' => Decimal::compare($r['value'], $r['maxValue']) > 0,
                ], $rows)],
            ]);
            $holder = $b->holder_org_id;
            Lifecycle::notify('LAB_RESULT', [
                'orgIds' => $holder !== null && $holder !== $b->origin_org_id ? [$b->origin_org_id, $holder] : [$b->origin_org_id],
                'roles' => $t->reason === 'INSPECTOR' || $t->reason === 'COMPLAINT' ? ['INSPECTOR'] : [],
            ], [
                'labTestId' => $id,
                'batchId' => $b->id,
                'publicCode' => $b->public_code,
                'productName' => $batch0->product_name,
                'conclusion' => $conclusion,
                'recallId' => $recallId,
            ]);
            if ($batch0->origin_type === 'FARM') {
                Outbox::enqueue('rating.recalculate', [
                    'organizationId' => $b->origin_org_id,
                    'cause' => $conclusion === 'PASS' ? 'LAB_PASS' : 'LAB_FAIL',
                    'sourceId' => $id,
                ]);
            }

            return $changed;
        }, Engine::RECALL_TX(fn () => self::currentVersion($id)));

        try {
            return LabView::card($p, $id);
        } finally {
            // R82 after the commit, with no DB slot held (P61) — and even when the card read fails (T8 review M1).
            SlotHolder::release();
            PublicCache::dropCodes($codes);
        }
    }

    /**
     * uploadLabProtocol — (400/413 by the multipart reader, the controller) → 404 → 415 → the objects to MinIO with no
     * DB slot held (P61) → the file, the test's protocol replaced (the old file soft-deleted; version unchanged), under
     * the test's lock again. P55: a second deadlock is 409 without params.
     *
     * @return array{id: string, url: string, mime: string, sizeBytes: int, originalName: string}
     */
    public static function uploadProtocol(Principal $p, string $id, Upload $upload): array
    {
        Tx::run(fn () => self::lockOwnTest($p, $id));
        SlotHolder::release();
        $file = Files::prepare($upload, 'LAB_PROTOCOL', $p->userId, ['application/pdf']);
        Files::store($file);
        Tx::run(function () use ($p, $id, $file): void {
            $t = self::lockOwnTest($p, $id);
            $now = Tx::now();
            Files::insert($file);
            DB::update('UPDATE lab_tests SET protocol_file_id = ? WHERE id = ?', [$file->id(), $id]);
            AuditLog::write($p->userId, 'uploadLabProtocol', 'file', $file->id(), AuditLog::diff(null, Files::auditView($file)));
            AuditLog::write($p->userId, 'uploadLabProtocol', 'labTest', $id, ['protocolFileId' => [$t->protocol_file_id, $file->id()]]);
            if (Files::softDelete($t->protocol_file_id, $now)) {
                AuditLog::write($p->userId, 'uploadLabProtocol', 'file', $t->protocol_file_id, ['deletedAt' => [null, Iso::fromPg($now)]]);
            }
        });
        $r = $file->row;

        return Files::ref($r['id'], 'LAB_PROTOCOL', $r['mime'], $r['size_bytes'], $r['original_name']);
    }

    /** downloadLabProtocol — the visible test's current protocol (404: invisible, none): a live files row. */
    public static function protocolFile(Principal $p, string $id): stdClass
    {
        self::visibleTest($p, $id);
        $t = DB::selectOne('SELECT protocol_file_id FROM lab_tests WHERE id = ?', [$id]);
        $f = $t !== null && $t->protocol_file_id !== null ? Files::live($t->protocol_file_id) : null;
        if ($f === null) {
            throw self::notFound();
        }

        return $f;
    }
}
