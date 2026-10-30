<?php

namespace App\Actions\Batches;

use App\Support\Iso;
use Illuminate\Support\Facades\DB;

/**
 * The ownership path of a batch (R45; Express batches/path.ts): getBatchPath (`PathStep`) and the public page
 * (`PublicBatch.path`, Task 11) share it. The first stage is the originating organization from `harvestedAt` (RAW)
 * or `producedAt` (DERIVED); every ACCEPTED, non-deleted waybill with the batch (by acceptedAt, then waybill number by
 * code points) closes the previous stage and opens the receiver's; the current holder's stage has `to` = null. Sending
 * and rejection create no stage.
 */
final class Path
{
    /**
     * @param  object{id: string, kind: string, origin_org_id: string, harvested_at: ?string, produced_at: ?string, created_at: string}  $batch
     * @return list<array{org: array<string, mixed>, from: string, to: ?string, waybillNumber: ?string}>
     */
    public static function stages(object $batch): array
    {
        $accepted = DB::select(<<<'SQL'
            SELECT w.number, w.receiver_org_id, w.accepted_at::text AS accepted_at
              FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id
             WHERE wi.batch_id = ? AND w.status = 'ACCEPTED' AND w.deleted_at IS NULL AND w.accepted_at IS NOT NULL
             ORDER BY w.accepted_at, w.number COLLATE "C"
            SQL, [$batch->id]);
        $refs = BatchView::orgRefs([$batch->origin_org_id, ...array_map(fn ($w) => $w->receiver_org_id, $accepted)]);
        $start = ($batch->kind === 'RAW' ? $batch->harvested_at : $batch->produced_at) ?? $batch->created_at;
        $steps = [['org' => $refs[$batch->origin_org_id], 'from' => (string) Iso::fromPg((string) $start), 'to' => null, 'waybillNumber' => null]];
        foreach ($accepted as $w) {
            $at = (string) Iso::fromPg($w->accepted_at);
            $steps[count($steps) - 1]['to'] = $at;
            $steps[] = ['org' => $refs[$w->receiver_org_id], 'from' => $at, 'to' => null, 'waybillNumber' => $w->number];
        }

        return $steps;
    }
}
