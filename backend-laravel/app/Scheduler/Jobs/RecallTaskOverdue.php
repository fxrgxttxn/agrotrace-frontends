<?php

namespace App\Scheduler\Jobs;

use App\Actions\Batches\Lifecycle;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Scheduler\ScheduledJob;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Scheduler job `recall-task-overdue` (tag Recalls, BR-08; entity-state-machines.json recallTask OPEN → OVERDUE,
 * `escalate`, by system; Express scheduler/jobs/recall-task-overdue.ts line by line): in ONE transaction the OPEN
 * tasks past due — `status = 'OPEN' AND due_at < now()` (the DB clock) — of recalls that are not soft-deleted (tasks
 * of a soft-deleted recall are invisible and unconfirmable: never escalated; Express review M5), `FOR NO KEY UPDATE
 * SKIP LOCKED` (a task a confirmation holds is seen next tick), become OVERDUE (`escalated_at` = the transaction's
 * now(), version + 1), each with the audit row `system.recallTaskOverdue` (actor null) and a `notification.dispatch`
 * OVERDUE outbox row (requestId null) to the task's holder and the inspectors. An OVERDUE task is never selected
 * again.
 */
final class RecallTaskOverdue implements ScheduledJob
{
    public function run(): void
    {
        $n = $this->tick();
        if ($n > 0) {
            Log::info('scheduler job tick', ['job' => 'recall-task-overdue', 'rows' => $n]);
        }
    }

    /** One pass; the number of tasks made OVERDUE. */
    public function tick(): int
    {
        return Tx::run(function (): int {
            $due = DB::select("SELECT t.id, t.recall_id, t.batch_id, t.holder_org_id, t.status, t.due_at::text AS due_at, t.version
                  FROM recall_tasks t
                 WHERE t.status = 'OPEN' AND t.due_at < now()
                   AND NOT EXISTS (SELECT 1 FROM recalls r WHERE r.id = t.recall_id AND r.deleted_at IS NOT NULL)
                 ORDER BY t.due_at, t.id
                 FOR NO KEY UPDATE OF t SKIP LOCKED");
            if ($due === []) {
                return 0;
            }
            $now = Tx::now();
            $nowIso = Iso::fromPg($now);
            $codes = self::column('batches', 'public_code', array_map(fn ($t) => $t->batch_id, $due));
            $holders = self::column('organizations', 'name', array_map(fn ($t) => $t->holder_org_id, $due));
            foreach ($due as $t) {
                $v = (int) $t->version;
                DB::update("UPDATE recall_tasks SET status = 'OVERDUE', escalated_at = ?::timestamptz, version = ? WHERE id = ?", [$now, $v + 1, $t->id]);
                AuditLog::write(null, 'system.recallTaskOverdue', 'recallTask', $t->id, [
                    'status' => [$t->status, 'OVERDUE'],
                    'escalatedAt' => [null, $nowIso],
                    'version' => [$v, $v + 1],
                ]);
                Lifecycle::notify('OVERDUE', ['orgIds' => [$t->holder_org_id], 'roles' => ['INSPECTOR']], [
                    'recallId' => $t->recall_id,
                    'taskId' => $t->id,
                    'batchId' => $t->batch_id,
                    'publicCode' => $codes[$t->batch_id] ?? null,
                    'dueAt' => Iso::fromPg($t->due_at),
                    'holderOrgId' => $t->holder_org_id,
                    'holderName' => $holders[$t->holder_org_id] ?? null,
                ]);
            }

            return count($due);
        });
    }

    /**
     * @param  list<string>  $ids
     * @return array<string, string> id → $column of $table
     */
    private static function column(string $table, string $column, array $ids): array
    {
        $ids = array_values(array_unique($ids));
        $out = [];
        foreach (DB::select("SELECT id, {$column} AS v FROM {$table} WHERE id IN (".implode(',', array_fill(0, count($ids), '?')).')', $ids) as $r) {
            $out[$r->id] = $r->v;
        }

        return $out;
    }
}
