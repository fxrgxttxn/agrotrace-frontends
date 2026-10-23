<?php

namespace App\Infrastructure\Db;

use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use LogicException;

/**
 * Row locks with the strengths of P57 (contract info.description; Express fields/service.ts `ownFieldForUpdate`).
 *
 * A field is locked only while it is not deleted (`deleted_at IS NULL` is part of the locking query), so a reference
 * that waited behind a deleteField re-checks the condition on the deleted row and finds nothing:
 * - `for no key update` — changes that keep the key (updateField, createTreatment): a createBatch on the field, which
 *   holds FOR KEY SHARE, does not wait for them;
 * - `for key share` — references (updateTreatment, createBatch);
 * - `for update` — deleteField only (one of the two places FOR UPDATE is allowed): it conflicts with every reference
 *   lock, waits for the running ones and makes the later ones fail.
 */
final class Locks
{
    private const STRENGTHS = ['for no key update', 'for key share', 'for update'];

    /**
     * The non-deleted field $id (optionally of organization $orgId) with its region code, locked; null when none.
     */
    public static function field(string $id, string $strength, ?string $orgId = null): ?object
    {
        if (! in_array($strength, self::STRENGTHS, true)) {
            throw new InvalidArgumentException("unknown lock strength {$strength}");
        }
        if (! Tx::active()) {
            throw new LogicException('Locks::field outside Tx::run');
        }
        $org = $orgId !== null ? ' AND f.organization_id = ?' : '';

        return DB::selectOne('SELECT f.id, f.organization_id, f.name, f.area_ha, f.geometry::text AS geometry, r.code AS region_code
              FROM fields f JOIN regions r ON r.id = f.region_id
             WHERE f.id = ? AND f.deleted_at IS NULL'.$org.' '.strtoupper($strength).' OF f',
            $orgId !== null ? [$id, $orgId] : [$id]);
    }

    /**
     * The waybill $id `FOR NO KEY UPDATE` — the first lock of every waybill operation (R47/R52 total order: waybill →
     * recall → labTest → complaint → organization → batches → recall tasks → other rows). Deleted rows are included
     * (visibility is the caller's check over the locked row); null when there is none.
     */
    public static function waybill(string $id): ?object
    {
        if (! Tx::active()) {
            throw new LogicException('Locks::waybill outside Tx::run');
        }

        return DB::selectOne('SELECT w.*, w.created_at::text AS created_at, w.updated_at::text AS updated_at,
                w.sent_at::text AS sent_at, w.accepted_at::text AS accepted_at, w.deleted_at::text AS deleted_at
              FROM waybills w WHERE w.id = ? FOR NO KEY UPDATE OF w', [$id]);
    }

    /**
     * Recall tasks $ids `FOR NO KEY UPDATE ORDER BY id`, in ONE statement, after the batches (R52). Missing ids are
     * simply absent; the caller re-checks over the locked rows every condition that chose them.
     *
     * @param  list<string>  $ids
     * @return list<object> in id order
     */
    public static function recallTasks(array $ids): array
    {
        if (! Tx::active()) {
            throw new LogicException('Locks::recallTasks outside Tx::run');
        }
        $ids = array_values(array_unique($ids));
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));

        return DB::select("SELECT t.*, t.due_at::text AS due_at FROM recall_tasks t WHERE t.id IN ({$marks})
             ORDER BY t.id FOR NO KEY UPDATE OF t", $ids);
    }

    /**
     * The batches $ids `FOR NO KEY UPDATE ORDER BY id`, in ONE statement (R47/R52 lock order: after waybill, recall,
     * labTest, complaint, organization; before recall tasks and other rows). Missing ids are simply absent; deleted
     * rows are included (visibility and deletion are the caller's checks over the locked rows).
     *
     * @param  list<string>  $ids
     * @return array<string, object> by id
     */
    public static function batches(array $ids): array
    {
        if (! Tx::active()) {
            throw new LogicException('Locks::batches outside Tx::run');
        }
        $ids = array_values(array_unique($ids));
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $out = [];
        foreach (DB::select("SELECT b.*, b.harvested_at::text AS harvested_at, b.produced_at::text AS produced_at,
                b.created_at::text AS created_at, b.updated_at::text AS updated_at, b.qr_generated_at::text AS qr_generated_at,
                b.deleted_at::text AS deleted_at
              FROM batches b WHERE b.id IN ({$marks}) ORDER BY b.id FOR NO KEY UPDATE OF b", $ids) as $b) {
            $out[$b->id] = $b;
        }

        return $out;
    }
}
