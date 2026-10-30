<?php

namespace App\Scheduler\Jobs;

use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Outbox\Outbox;
use App\Scheduler\ScheduledJob;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Scheduler job `lab-escalation` (tag Lab, БП-2; contracts/events/lab.escalate.schema.json; Express
 * scheduler/jobs/lab-escalation.ts): in ONE transaction the open tests past due — `status IN ('QUEUED','SAMPLED') AND
 * due_at < now() AND deleted_at IS NULL`, whose batch is not soft-deleted, `FOR NO KEY UPDATE SKIP LOCKED` (a test a
 * request holds is left for the next tick) — become ESCALATED (`escalated_at` = the transaction's now(), version + 1),
 * each with an audit row `system.labTestEscalate` (actor null) and a `lab.escalate` outbox row (requestId null). The
 * clock is the database's: tests move `due_at`, never the clock. The handler (worker) sends LAB_OVERDUE.
 */
final class LabEscalation implements ScheduledJob
{
    public function run(): void
    {
        $n = $this->tick();
        if ($n > 0) {
            Log::info('scheduler job tick', ['job' => 'lab-escalation', 'rows' => $n]);
        }
    }

    /** One pass; the number of tests escalated. */
    public function tick(): int
    {
        return Tx::run(function (): int {
            $due = DB::select("SELECT t.id, t.lab_org_id, t.batch_id, t.status, t.due_at::text AS due_at, t.version
                  FROM lab_tests t
                 WHERE t.status IN ('QUEUED', 'SAMPLED') AND t.due_at < now() AND t.deleted_at IS NULL
                   -- Tests of a soft-deleted batch are invisible to everybody (tag Lab): never escalated.
                   AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.id = t.batch_id AND b.deleted_at IS NOT NULL)
                 ORDER BY t.due_at, t.id
                 FOR NO KEY UPDATE OF t SKIP LOCKED");
            if ($due === []) {
                return 0;
            }
            $now = Tx::now();
            $nowIso = Iso::fromPg($now);
            $batchIds = array_values(array_unique(array_map(fn ($t) => $t->batch_id, $due)));
            $codes = [];
            foreach (DB::select('SELECT id, public_code FROM batches WHERE id IN ('.implode(',', array_fill(0, count($batchIds), '?')).')', $batchIds) as $b) {
                $codes[$b->id] = $b->public_code;
            }
            foreach ($due as $t) {
                $v = (int) $t->version;
                DB::update("UPDATE lab_tests SET status = 'ESCALATED', escalated_at = ?::timestamptz, version = ? WHERE id = ?", [$now, $v + 1, $t->id]);
                AuditLog::write(null, 'system.labTestEscalate', 'labTest', $t->id, [
                    'status' => [$t->status, 'ESCALATED'],
                    'escalatedAt' => [null, $nowIso],
                    'version' => [$v, $v + 1],
                ]);
                Outbox::enqueue('lab.escalate', [
                    'labTestId' => $t->id,
                    'labOrgId' => $t->lab_org_id,
                    'batchId' => $t->batch_id,
                    'publicCode' => $codes[$t->batch_id] ?? null,
                    'dueAt' => Iso::fromPg($t->due_at),
                    'escalatedAt' => $nowIso,
                ]);
            }

            return count($due);
        });
    }
}
