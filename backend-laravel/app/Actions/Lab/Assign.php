<?php

namespace App\Actions\Lab;

use App\Actions\Batches\Lifecycle;
use App\Domain\Dates;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;
use LogicException;

/**
 * An unplanned lab test as createLabTest makes it (tag Lab; Express lab/assign.ts): QUEUED, `dueAt` =
 * addWorkingDays(now, 5) (by UTC dates, from the transaction's instant, P43), `created_by` = the inspector, version 1,
 * the audit row, LAB_ASSIGNED to the laboratory and the batch origin (notifications.json `labOrg`, `batchOrigin`).
 * Shared by createLabTest (reason INSPECTOR) and decideComplaint LAB_TEST (reason COMPLAINT, Task 11). The caller has
 * checked the batch and the laboratory (ACTIVE, type LAB).
 */
final class Assign
{
    /**
     * @param  object{id: string, public_code: string, origin_org_id: string, product_name: string}  $batch
     * @param  object{id: string, name: string}  $lab
     * @param  'INSPECTOR'|'COMPLAINT'  $reason
     * @param  string  $action  operationId of the audit row
     * @return array{id: string, dueAt: string}
     */
    public static function insertUnplanned(object $batch, object $lab, string $reason, string $actorId, string $action): array
    {
        if (! Tx::active()) {
            throw new LogicException('Assign::insertUnplanned outside Tx::run');
        }
        $now = Tx::now();
        $dueAt = Dates::addWorkingDays(['from' => (string) Iso::fromPg($now), 'days' => 5])['result'];
        $row = DB::selectOne("INSERT INTO lab_tests (batch_id, lab_org_id, reason, status, due_at, created_at, updated_at, created_by, version)
             VALUES (?, ?, ?, 'QUEUED', ?::timestamptz, ?::timestamptz, ?::timestamptz, ?, 1) RETURNING id",
            [$batch->id, $lab->id, $reason, $dueAt, $now, $now, $actorId]);
        AuditLog::write($actorId, $action, 'labTest', $row->id, AuditLog::diff(null, [
            'batchId' => $batch->id,
            'labOrgId' => $lab->id,
            'reason' => $reason,
            'status' => 'QUEUED',
            'dueAt' => $dueAt,
            'version' => 1,
        ]));
        Lifecycle::notify('LAB_ASSIGNED', ['orgIds' => [$lab->id, $batch->origin_org_id]], [
            'labTestId' => $row->id,
            'batchId' => $batch->id,
            'publicCode' => $batch->public_code,
            'productName' => $batch->product_name,
            'labOrgId' => $lab->id,
            'labName' => $lab->name,
            'reason' => $reason,
            'dueAt' => $dueAt,
        ]);

        return ['id' => $row->id, 'dueAt' => $dueAt];
    }
}
