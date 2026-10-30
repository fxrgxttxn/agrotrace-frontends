<?php

namespace App\Actions\Recalls;

use App\Actions\Batches\BatchView;
use App\Queries\ActorRefs;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;

/**
 * The contract's recall views (contracts/openapi/schemas/recalls.yaml; Express recalls/view.ts line by line):
 * `RecallTask`, `RecallListItem`, `Recall`, `RecallGraph`. `overdue` and `progress.overdue` are computed at read time
 * by the DB clock — a task not CONFIRMED with now() > due_at, whether or not the scheduler has set OVERDUE yet. The
 * contract's fixed orders compare strings by code points (`COLLATE "C"`, P14):
 * - members: SOURCE, DOWN, UP → depth → publicCode → batch id;
 * - tasks of a card: dueAt → the batch's publicCode → id;
 * - graph edges: the parent's publicCode, then the child's.
 */
final class RecallView
{
    private const OVERDUE_SQL = "(t.status <> 'CONFIRMED' AND now() > t.due_at)";

    /** @param  list<string>  $ids */
    private static function marks(array $ids): string
    {
        return implode(',', array_fill(0, count($ids), '?'));
    }

    /**
     * `RecallTask` of $ids, in the order of $ids (missing ids skipped).
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    public static function tasks(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $want = array_values(array_unique($ids));
        $rows = [];
        foreach (DB::select('SELECT t.id, t.recall_id, t.batch_id, t.holder_org_id, t.due_at::text AS due_at, t.status,
                t.escalated_at::text AS escalated_at, t.confirmed_at::text AS confirmed_at, t.confirmed_by,
                t.created_at::text AS created_at, t.version, r.reason, '.self::OVERDUE_SQL.' AS overdue
              FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id
             WHERE t.id IN ('.self::marks($want).')', $want) as $r) {
            $rows[$r->id] = $r;
        }
        $batches = [];
        foreach (BatchView::listItems(array_values(array_unique(array_map(fn ($r) => $r->batch_id, array_values($rows))))) as $b) {
            $batches[$b['id']] = $b;
        }
        $holders = BatchView::orgRefs(array_map(fn ($r) => $r->holder_org_id, array_values($rows)));
        $actors = ActorRefs::of(array_map(fn ($r) => $r->confirmed_by, array_values($rows)));
        $out = [];
        foreach ($ids as $id) {
            $r = $rows[$id] ?? null;
            if ($r === null) {
                continue;
            }
            $out[] = [
                'id' => $r->id,
                'recallId' => $r->recall_id,
                'recallReason' => $r->reason,
                'batch' => $batches[$r->batch_id],
                'holder' => $holders[$r->holder_org_id],
                'dueAt' => Iso::fromPg($r->due_at),
                'status' => $r->status,
                'overdue' => $r->overdue === true,
                'escalatedAt' => Iso::fromPg($r->escalated_at),
                'confirmedAt' => Iso::fromPg($r->confirmed_at),
                'confirmedBy' => $r->confirmed_by !== null ? ($actors[$r->confirmed_by] ?? null) : null,
                'createdAt' => Iso::fromPg($r->created_at),
                'version' => (int) $r->version,
            ];
        }

        return $out;
    }

    /**
     * `RecallListItem` of $ids, in the order of $ids (missing ids skipped).
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    public static function items(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $want = array_values(array_unique($ids));
        $rows = [];
        foreach (DB::select("SELECT r.id, r.source_batch_id, r.trigger, r.reason, r.status, r.block_upstream,
                r.opened_at::text AS opened_at, r.closed_at::text AS closed_at,
                (SELECT count(*) FROM recall_tasks t WHERE t.recall_id = r.id)::int AS total,
                (SELECT count(*) FROM recall_tasks t WHERE t.recall_id = r.id AND t.status = 'CONFIRMED')::int AS confirmed,
                (SELECT count(*) FROM recall_tasks t WHERE t.recall_id = r.id AND ".self::OVERDUE_SQL.')::int AS overdue,
                (SELECT count(*) FROM recall_batches rb WHERE rb.recall_id = r.id)::int AS batches_count
              FROM recalls r WHERE r.id IN ('.self::marks($want).')', $want) as $r) {
            $rows[$r->id] = $r;
        }
        $sources = [];
        foreach (BatchView::listItems(array_values(array_unique(array_map(fn ($r) => $r->source_batch_id, array_values($rows))))) as $b) {
            $sources[$b['id']] = $b;
        }
        $out = [];
        foreach ($ids as $id) {
            $r = $rows[$id] ?? null;
            if ($r === null) {
                continue;
            }
            $out[] = [
                'id' => $r->id,
                'sourceBatch' => $sources[$r->source_batch_id],
                'trigger' => $r->trigger,
                'reason' => $r->reason,
                'status' => $r->status,
                'blockUpstream' => $r->block_upstream === true,
                'openedAt' => Iso::fromPg($r->opened_at),
                'closedAt' => Iso::fromPg($r->closed_at),
                'progress' => ['confirmed' => (int) $r->confirmed, 'total' => (int) $r->total, 'overdue' => (int) $r->overdue],
                'batchesCount' => (int) $r->batches_count,
            ];
        }

        return $out;
    }

    /**
     * `recall_batches` of the recall in the contract's order.
     *
     * @return list<object{batch_id: string, direction: string, depth: int, status_before: string}>
     */
    private static function members(string $recallId): array
    {
        return DB::select("SELECT rb.batch_id, rb.direction, rb.depth, rb.status_before
              FROM recall_batches rb JOIN batches b ON b.id = rb.batch_id
             WHERE rb.recall_id = ?
             ORDER BY CASE rb.direction WHEN 'SOURCE' THEN 0 WHEN 'DOWN' THEN 1 ELSE 2 END, rb.depth,
                      b.public_code COLLATE \"C\", rb.batch_id", [$recallId]);
    }

    /** @return list<string> the recall's task ids: dueAt → the batch's publicCode → id */
    private static function taskIdsOf(string $recallId): array
    {
        return array_map(fn ($r) => $r->id, DB::select('SELECT t.id FROM recall_tasks t JOIN batches b ON b.id = t.batch_id
             WHERE t.recall_id = ? ORDER BY t.due_at, b.public_code COLLATE "C", t.id::text COLLATE "C"', [$recallId]));
    }

    /**
     * The `Recall` card of a non-deleted recall; null when it does not exist or is deleted.
     *
     * @return array<string, mixed>|null
     */
    public static function card(string $id): ?array
    {
        $r = DB::selectOne('SELECT id, created_by, lab_test_id, complaint_id, version FROM recalls WHERE id = ? AND deleted_at IS NULL', [$id]);
        if ($r === null) {
            return null;
        }
        $item = self::items([$id])[0];
        $ms = self::members($id);
        $batches = [];
        foreach (BatchView::listItems(array_map(fn ($m) => $m->batch_id, $ms)) as $b) {
            $batches[$b['id']] = $b;
        }
        $actors = ActorRefs::of([$r->created_by]);

        return [
            ...$item,
            'openedBy' => $r->created_by !== null ? ($actors[$r->created_by] ?? null) : null,
            'labTestId' => $r->lab_test_id,
            'complaintId' => $r->complaint_id,
            'batches' => array_map(fn ($m) => [
                'batch' => $batches[$m->batch_id],
                'direction' => $m->direction,
                'depth' => (int) $m->depth,
                'statusBefore' => $m->status_before,
            ], $ms),
            'tasks' => self::tasks(self::taskIdsOf($id)),
            'version' => (int) $r->version,
        ];
    }

    /**
     * `RecallGraph` of a non-deleted recall; null when it does not exist or is deleted.
     *
     * @return array{recallId: string, nodes: list<array<string, mixed>>, edges: list<array{parent: string, child: string, massUsedKg: string}>}|null
     */
    public static function graph(string $id): ?array
    {
        if (DB::selectOne('SELECT id FROM recalls WHERE id = ? AND deleted_at IS NULL', [$id]) === null) {
            return null;
        }
        $ms = self::members($id);
        $ids = array_map(fn ($m) => $m->batch_id, $ms);
        $items = [];
        foreach (BatchView::listItems($ids) as $b) {
            $items[$b['id']] = $b;
        }
        $taskStatus = [];
        foreach (DB::select('SELECT batch_id, status FROM recall_tasks WHERE recall_id = ?', [$id]) as $t) {
            $taskStatus[$t->batch_id] = $t->status;
        }
        $edges = [];
        if ($ids !== []) {
            $marks = self::marks($ids);
            foreach (DB::select("SELECT l.parent_batch_id, l.child_batch_id, l.mass_used_kg
                  FROM batch_links l JOIN batches p ON p.id = l.parent_batch_id JOIN batches c ON c.id = l.child_batch_id
                 WHERE l.parent_batch_id IN ({$marks}) AND l.child_batch_id IN ({$marks})
                 ORDER BY p.public_code COLLATE \"C\", c.public_code COLLATE \"C\"", [...$ids, ...$ids]) as $e) {
                $edges[] = ['parent' => $e->parent_batch_id, 'child' => $e->child_batch_id, 'massUsedKg' => (string) $e->mass_used_kg];
            }
        }

        return [
            'recallId' => $id,
            'nodes' => array_map(function ($m) use ($items, $taskStatus) {
                $b = $items[$m->batch_id];

                return [
                    'id' => $b['id'],
                    'publicCode' => $b['publicCode'],
                    'product' => $b['product'],
                    'status' => $b['status'],
                    'statusBefore' => $m->status_before,
                    'holder' => $b['holder'],
                    'direction' => $m->direction,
                    'depth' => (int) $m->depth,
                    'taskStatus' => $taskStatus[$m->batch_id] ?? null,
                ];
            }, $ms),
            'edges' => $edges,
        ];
    }
}
