<?php

namespace App\Actions\Lab;

use App\Actions\Batches\BatchView;
use App\Infrastructure\Files\Files;
use App\Queries\Visibility;
use App\Security\Principal;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * Lab test views (contracts/openapi/schemas/lab.yaml `LabTestListItem`, `LabTest`) and visibility (tag Lab; Express
 * lab/view.ts): deleted tests and tests of deleted batches are seen by nobody (the caller's predicate); INSPECTOR and
 * ADMIN — all; LAB — its own laboratory's tests; FARMER/PROCESSOR/RETAILER — the tests of the batches they see
 * (batchVisibleTo with the LAB role taken away). `overdue` is computed by the DB clock at read time: an open status
 * and now() > due_at.
 *
 * `norms`: while not DONE — the current norms of the batch's product with non-deleted indicators, read without a lock
 * (D7); for DONE — the snapshot of the results (maxValue = normValue); both by indicator name (code points), then id.
 */
final class LabView
{
    /** Statuses whose results can still be submitted (entity-state-machines.json labTest → DONE). */
    public const OPEN = ['QUEUED', 'SAMPLED', 'ESCALATED'];

    private const OVERDUE_SQL = "(t.status IN ('QUEUED', 'SAMPLED', 'ESCALATED') AND now() > t.due_at)";

    /**
     * The predicate "test `t` (its batch `b`) is visible to $p" — deletion is the caller's filter.
     *
     * @return array{0: string, 1: list<mixed>}
     */
    public static function visibleTo(Principal $p): array
    {
        if ($p->seesAll()) {
            return ['true', []];
        }
        $parts = [];
        $bindings = [];
        if ($p->hasRole('LAB')) {
            $parts[] = 't.lab_org_id = ?';
            $bindings[] = $p->orgId;
        }
        if ($p->isParticipant()) {
            $noLab = new Principal($p->userId, $p->orgId, array_values(array_filter($p->roles, fn ($r) => $r !== 'LAB')), $p->orgAdmin, $p->exp);
            [$sql, $b] = Visibility::batchVisibleTo($noLab, 't.batch_id');
            $parts[] = $sql;
            array_push($bindings, ...$b);
        }

        return $parts === [] ? ['false', []] : ['('.implode(' OR ', $parts).')', $bindings];
    }

    /** Overdue predicate over `t` (the DB clock). */
    public static function overdueSql(): string
    {
        return self::OVERDUE_SQL;
    }

    /**
     * @param  list<string>  $ids
     * @return array<string, stdClass>
     */
    private static function rows(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $out = [];
        foreach (DB::select('SELECT t.id, t.batch_id, t.lab_org_id, t.reason, t.status, t.conclusion, t.due_at::text AS due_at,
                t.created_at::text AS created_at, t.sampled_at::text AS sampled_at, t.completed_at::text AS completed_at,
                t.escalated_at::text AS escalated_at, t.recall_id, t.version, b.product_id,
                f.id AS file_id, f.kind AS file_kind, f.mime AS file_mime, f.size_bytes AS file_size, f.original_name AS file_name,
                '.self::OVERDUE_SQL." AS overdue
              FROM lab_tests t JOIN batches b ON b.id = t.batch_id
              LEFT JOIN files f ON f.id = t.protocol_file_id AND f.deleted_at IS NULL
             WHERE t.id IN ({$marks})", array_values(array_unique($ids))) as $r) {
            $out[$r->id] = $r;
        }

        return $out;
    }

    /**
     * @param  list<string>  $ids
     * @return list<array{row: stdClass, item: array<string, mixed>}> in the order of $ids
     */
    private static function items(array $ids): array
    {
        $rows = self::rows($ids);
        if ($rows === []) {
            return [];
        }
        $batches = [];
        foreach (BatchView::listItems(array_values(array_unique(array_map(fn ($r) => $r->batch_id, $rows)))) as $b) {
            $batches[$b['id']] = $b;
        }
        $labs = BatchView::orgRefs(array_map(fn ($r) => $r->lab_org_id, array_values($rows)));
        $out = [];
        foreach ($ids as $id) {
            $r = $rows[$id] ?? null;
            if ($r === null) {
                continue;
            }
            $out[] = ['row' => $r, 'item' => [
                'id' => $r->id,
                'batch' => $batches[$r->batch_id],
                'lab' => $labs[$r->lab_org_id],
                'reason' => $r->reason,
                'status' => $r->status,
                'conclusion' => $r->conclusion,
                'dueAt' => Iso::fromPg($r->due_at),
                'overdue' => $r->overdue === true,
                'createdAt' => Iso::fromPg($r->created_at),
                'sampledAt' => Iso::fromPg($r->sampled_at),
                'completedAt' => Iso::fromPg($r->completed_at),
                'hasProtocol' => $r->file_id !== null,
            ]];
        }

        return $out;
    }

    /**
     * `LabTestListItem` of $ids, in the order of $ids.
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    public static function listItems(array $ids): array
    {
        return array_map(fn ($x) => $x['item'], self::items($ids));
    }

    /**
     * Current norms of a product (non-deleted indicators), by indicator name (code points), then id.
     *
     * @return list<array{indicatorId: string, name: string, unit: string, maxValue: string}>
     */
    public static function currentNorms(string $productId): array
    {
        return array_map(fn ($r) => ['indicatorId' => $r->id, 'name' => $r->name, 'unit' => $r->unit, 'maxValue' => $r->max_value],
            DB::select('SELECT i.id, i.name, i.unit, n.max_value FROM norms n JOIN indicators i ON i.id = n.indicator_id
                 WHERE n.product_id = ? AND i.deleted_at IS NULL ORDER BY i.name COLLATE "C", i.id::text COLLATE "C"', [$productId]));
    }

    /**
     * The `LabTest` card of $id for $p (the caller checked visibility).
     *
     * @return array<string, mixed>
     */
    public static function card(Principal $p, string $id): array
    {
        ['row' => $r, 'item' => $item] = self::items([$id])[0];
        $results = [];
        if ($r->status === 'DONE') {
            foreach (DB::select('SELECT i.id, i.name, i.unit, lr.value, lr.norm_value_snapshot, lr.is_exceeded
                  FROM lab_results lr JOIN indicators i ON i.id = lr.indicator_id
                 WHERE lr.lab_test_id = ? ORDER BY i.name COLLATE "C", i.id::text COLLATE "C"', [$id]) as $x) {
                $results[] = [
                    'indicatorId' => $x->id,
                    'name' => $x->name,
                    'unit' => $x->unit,
                    'value' => $x->value,
                    'normValue' => $x->norm_value_snapshot ?? $x->value,
                    'isExceeded' => (bool) $x->is_exceeded,
                ];
            }
        }
        $norms = $r->status === 'DONE'
            ? array_map(fn ($x) => ['indicatorId' => $x['indicatorId'], 'name' => $x['name'], 'unit' => $x['unit'], 'maxValue' => $x['normValue']], $results)
            : self::currentNorms($r->product_id);
        // LabTestActionName: role LAB of the test's own laboratory (the operations answer 404 to any other).
        $actions = [];
        if ($p->hasRole('LAB') && $r->lab_org_id === $p->orgId) {
            if ($r->status === 'QUEUED') {
                $actions[] = 'sample';
            }
            if (in_array($r->status, self::OPEN, true)) {
                $actions[] = 'submitResults';
            }
            if ($r->status !== 'CANCELLED') {
                $actions[] = 'uploadProtocol';
            }
        }

        return [
            ...$item,
            'escalatedAt' => Iso::fromPg($r->escalated_at),
            'results' => $results,
            'protocol' => $r->file_id === null ? null
                : Files::ref($r->file_id, $r->file_kind, $r->file_mime, $r->file_size, $r->file_name),
            'norms' => $norms,
            'recallId' => $r->recall_id,
            'version' => (int) $r->version,
            'actions' => $actions,
        ];
    }
}
