<?php

namespace App\Actions\Analytics;

use App\Actions\Batches\BatchView;
use App\Domain\Decimal;
use App\Domain\StateMachine;
use App\Http\Query\QueryReader;
use App\Security\Principal;
use Illuminate\Support\Facades\DB;

/**
 * getDashboard (contracts/openapi/paths/analytics.yaml; schemas InspectorDashboard, OrgDashboard, LabDashboard;
 * FR-ANL-01…03; Express modules/analytics/dashboard.ts). `scope` by the caller's roles (union): inspector —
 * INSPECTOR, ADMIN; org — FARMER, PROCESSOR, RETAILER (the caller's organization); lab — LAB (the caller's
 * laboratory); otherwise `errors.scope: [validation.scope.notAllowed]` (R51), in the same 400 as the window's errors.
 * Every number comes from one READ ONLY REPEATABLE READ snapshot (Window::snapshot); "now" is the snapshot's now().
 * Deleted rows never count (soft-deleted batches hide their lab tests and recall tasks too, deleted recalls their
 * tasks); shares via Decimal::ratioPercent2, hours via hours() (S whole seconds — `floor(extract(epoch …))` in SQL —
 * over N × 3600, half up). No float anywhere: counts are integers, sums decimal strings (bcmath).
 */
final class Dashboard
{
    public const SCOPES = ['inspector', 'org', 'lab'];

    public const SCOPE_ROLES = [
        'inspector' => ['INSPECTOR', 'ADMIN'],
        'org' => ['FARMER', 'PROCESSOR', 'RETAILER'],
        'lab' => ['LAB'],
    ];

    /** DONE tests completed in the window [?, ?), of non-deleted tests of non-deleted batches (lt, b). */
    private const DONE_IN = "lt.deleted_at IS NULL AND b.deleted_at IS NULL AND lt.status = 'DONE'
        AND lt.completed_at >= ?::timestamptz AND lt.completed_at < ?::timestamptz";

    /** @return array<string, mixed> */
    public static function get(Principal $p, QueryReader $q): array
    {
        $scope = $q->enum('scope', self::SCOPES);
        if (! $q->has('scope')) {
            $q->errors['scope'] = ['validation.required'];
        }
        if ($scope !== null && array_intersect($p->roles, self::SCOPE_ROLES[$scope]) === []) {
            $q->errors['scope'] = ['validation.scope.notAllowed'];
        }
        $range = Window::read($q);
        $q->done();

        return Window::snapshot(function (string $now) use ($p, $scope, $range): array {
            $w = Window::resolve($range['from'], $range['to'], Window::dateOf($now));

            return match ($scope) {
                'inspector' => self::inspector($p, $w),
                'org' => self::org($p, $w),
                default => self::lab($p, $w),
            };
        });
    }

    /** `Hours` of a sum of whole seconds (a decimal string) over $n records; null when there are none. */
    public static function hours(string $seconds, int $n): ?string
    {
        if ($n === 0) {
            return null;
        }

        return Decimal::ratioPercent2($seconds, bcmul((string) $n, '360000', 0));
    }

    /**
     * InspectorDashboard of the window $w (inside the snapshot).
     *
     * @param  array{from: string, to: string}  $w
     * @return array<string, mixed>
     */
    public static function inspector(Principal $p, array $w): array
    {
        $b = Window::bounds($w);
        $total = DB::selectOne('SELECT count(*)::int AS n FROM batches
             WHERE deleted_at IS NULL AND created_at >= ?::timestamptz AND created_at < ?::timestamptz', $b);
        $byProduct = DB::select("SELECT p.id AS key, p.name, count(*)::int AS tested,
                    count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed
               FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN products p ON p.id = b.product_id
              WHERE ".self::DONE_IN.'
              GROUP BY p.id, p.name', $b);
        $byFarm = DB::select("SELECT o.id AS key, o.name, count(*)::int AS tested,
                    count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed
               FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN organizations o ON o.id = b.origin_org_id
              WHERE ".self::DONE_IN." AND b.kind = 'RAW' AND o.type = 'FARM'
              GROUP BY o.id, o.name", $b);
        $active = DB::selectOne("SELECT count(*)::int AS n FROM recalls WHERE deleted_at IS NULL AND status = 'OPEN'");
        $closed = DB::selectOne('SELECT coalesce(sum(floor(extract(epoch FROM closed_at - opened_at)))::bigint, 0)::text AS s,
                    count(*)::int AS n
               FROM recalls
              WHERE deleted_at IS NULL AND closed_at >= ?::timestamptz AND closed_at < ?::timestamptz', $b);
        $regions = DB::select('SELECT r.code, r.name,
                    (SELECT count(*)::int FROM lab_tests lt
                       JOIN batches b ON b.id = lt.batch_id JOIN organizations o ON o.id = b.origin_org_id
                      WHERE '.self::DONE_IN." AND lt.conclusion = 'FAIL' AND o.region_id = r.id) AS count
               FROM regions r
              ORDER BY r.code COLLATE \"C\"", $b);

        return [
            'scope' => 'inspector',
            'period' => $w,
            'batchesTotal' => (int) $total->n,
            'rejectedShare' => ['byProduct' => self::topShares($byProduct), 'byFarm' => self::topShares($byFarm)],
            'activeRecalls' => (int) $active->n,
            'avgRecallHours' => self::hours((string) $closed->s, (int) $closed->n),
            'violationsByRegion' => array_map(
                fn (object $r): array => ['code' => (string) $r->code, 'name' => (string) $r->name, 'count' => (int) $r->count],
                $regions,
            ),
        ];
    }

    /**
     * OrgDashboard of the caller's organization (inside the snapshot).
     *
     * @param  array{from: string, to: string}  $w
     * @return array<string, mixed>
     */
    public static function org(Principal $p, array $w): array
    {
        $b = Window::bounds($w);
        $byStatus = self::byStatus($p->orgId);
        $lab = DB::selectOne("SELECT count(*) FILTER (WHERE lt.conclusion = 'PASS')::int AS pass,
                    count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS fail
               FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id
              WHERE ".self::DONE_IN.' AND b.origin_org_id = ?', [...$b, $p->orgId]);
        // Tasks as listRecallTasks shows them: tasks of deleted recalls or deleted batches are not counted.
        $tasks = DB::selectOne("SELECT count(*)::int AS open, count(*) FILTER (WHERE now() > t.due_at)::int AS overdue
               FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id JOIN batches b ON b.id = t.batch_id
              WHERE t.holder_org_id = ? AND t.status IN ('OPEN', 'OVERDUE')
                AND r.deleted_at IS NULL AND b.deleted_at IS NULL", [$p->orgId]);

        return [
            'scope' => 'org',
            'period' => $w,
            'organization' => BatchView::orgRefs([$p->orgId])[$p->orgId],
            'byStatus' => $byStatus,
            'labResults' => ['pass' => (int) $lab->pass, 'fail' => (int) $lab->fail],
            'openTasks' => (int) $tasks->open,
            'overdueTasks' => (int) $tasks->overdue,
        ];
    }

    /**
     * LabDashboard of the caller's laboratory (inside the snapshot): the queue at the snapshot's now(), the rest in
     * the window.
     *
     * @param  array{from: string, to: string}  $w
     * @return array<string, mixed>
     */
    public static function lab(Principal $p, array $w): array
    {
        $b = Window::bounds($w);
        $queue = DB::selectOne("SELECT count(*)::int AS n, count(*) FILTER (WHERE now() > lt.due_at)::int AS overdue
               FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id
              WHERE lt.lab_org_id = ? AND lt.deleted_at IS NULL AND b.deleted_at IS NULL
                AND lt.status IN ('QUEUED', 'SAMPLED', 'ESCALATED')", [$p->orgId]);
        $done = DB::selectOne("SELECT count(*)::int AS n, count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed,
                    coalesce(sum(floor(extract(epoch FROM lt.completed_at - lt.created_at)))::bigint, 0)::text AS s
               FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id
              WHERE ".self::DONE_IN.' AND lt.lab_org_id = ?', [...$b, $p->orgId]);

        return [
            'scope' => 'lab',
            'period' => $w,
            'organization' => BatchView::orgRefs([$p->orgId])[$p->orgId],
            'queue' => (int) $queue->n,
            'overdue' => (int) $queue->overdue,
            'completed' => (int) $done->n,
            'failed' => (int) $done->failed,
            'avgHours' => self::hours((string) $done->s, (int) $done->n),
        ];
    }

    /**
     * `byStatus` of the batches an organization holds (every status of the state machine, in its order; deleted
     * batches not counted) — OrgDashboard and the org report's «Партии по статусам».
     *
     * @return list<array{status: string, count: int}>
     */
    public static function byStatus(string $orgId): array
    {
        $counts = [];
        foreach (DB::select('SELECT status, count(*)::int AS n FROM batches
             WHERE deleted_at IS NULL AND holder_org_id = ? GROUP BY status', [$orgId]) as $r) {
            $counts[(string) $r->status] = (int) $r->n;
        }

        return array_map(fn (string $s): array => ['status' => $s, 'count' => $counts[$s] ?? 0], StateMachine::statuses());
    }

    /**
     * Top 10 by the ROUNDED `share` desc (P47: the share as shown, not the exact ratio), then `tested` desc, then
     * `name` by code points.
     *
     * @param  list<object>  $rows
     * @return list<array{key: string, name: string, tested: int, failed: int, share: string}>
     */
    public static function topShares(array $rows): array
    {
        $items = array_map(fn (object $r): array => [
            'key' => (string) $r->key,
            'name' => (string) $r->name,
            'tested' => (int) $r->tested,
            'failed' => (int) $r->failed,
            'share' => Decimal::ratioPercent2((string) $r->failed, (string) $r->tested),
        ], $rows);
        usort($items, fn (array $a, array $b): int => Decimal::compare($b['share'], $a['share'])
            ?: ($b['tested'] <=> $a['tested'])
            ?: strcmp($a['name'], $b['name']));

        return array_slice($items, 0, 10);
    }
}
