<?php

namespace App\Queries;

use App\Security\Principal;
use Illuminate\Support\Facades\DB;

/**
 * Visibility (п. 4.2; Express organizations/service.ts canSeeOrganization, batches/visibility.ts) as SQL fragments
 * with their bindings, so lists filter in the database.
 * - An organization: its own, plus the counterparties of the waybills it can see (as sender — any status, as receiver
 *   — not DRAFT); INSPECTOR and ADMIN see every one; deleted ones are invisible to all.
 * - A batch: INSPECTOR/ADMIN all; LAB — batches with a non-deleted test of its laboratory; FARMER/PROCESSOR/RETAILER
 *   — S ∪ N (S: originated, held, or in a SENT/ACCEPTED/REJECTED waybill it sends or receives; N: direct parents and
 *   children of S). Deletion of the batch itself is the caller's predicate.
 */
final class Visibility
{
    /**
     * The predicate "organization $orgIdSql (a column) is visible to $p" — deletion excluded.
     *
     * @return array{0: string, 1: list<mixed>}
     */
    public static function organizationVisibleTo(Principal $p, string $orgIdSql = 'o.id'): array
    {
        if ($p->seesAll()) {
            return ['true', []];
        }

        return ["({$orgIdSql} = ? OR EXISTS (SELECT 1 FROM waybills w
                   WHERE w.deleted_at IS NULL
                     AND ((w.sender_org_id = ? AND w.receiver_org_id = {$orgIdSql})
                       OR (w.receiver_org_id = ? AND w.sender_org_id = {$orgIdSql} AND w.status <> 'DRAFT'))))",
            [$p->orgId, $p->orgId, $p->orgId]];
    }

    /**
     * The predicate "field $alias is visible to $p" (tag Fields): FARMER — the fields of its own farm; INSPECTOR and
     * ADMIN — every field (read-only). Deletion is the caller's predicate.
     *
     * @return array{0: string, 1: list<mixed>}
     */
    public static function fieldVisibleTo(Principal $p, string $alias = 'f'): array
    {
        return $p->seesAll() ? ['true', []] : ["{$alias}.organization_id = ?", [$p->orgId]];
    }

    /** Whether organization $orgId exists (not deleted) and $p may see it. */
    public static function canSeeOrganization(Principal $p, string $orgId): bool
    {
        [$sql, $bindings] = self::organizationVisibleTo($p, 'o.id');
        $row = DB::selectOne("SELECT EXISTS (SELECT 1 FROM organizations o WHERE o.id = ? AND o.deleted_at IS NULL AND {$sql}) AS ok",
            [$orgId, ...$bindings]);

        return $row !== null && $row->ok === true;
    }

    /**
     * `SELECT id …` of S ∪ N for the organization.
     *
     * @return array{0: string, 1: list<mixed>}
     */
    public static function participantBatchIds(string $orgId): array
    {
        return [<<<'SQL'
            WITH s AS (
              SELECT b.id FROM batches b
               WHERE b.deleted_at IS NULL AND (b.origin_org_id = ? OR b.holder_org_id = ?)
              UNION
              SELECT wi.batch_id FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id
               WHERE w.deleted_at IS NULL AND w.status IN ('SENT', 'ACCEPTED', 'REJECTED')
                 AND (w.sender_org_id = ? OR w.receiver_org_id = ?)
            )
            SELECT id FROM s
            UNION SELECT l.child_batch_id FROM batch_links l WHERE l.parent_batch_id IN (SELECT id FROM s)
            UNION SELECT l.parent_batch_id FROM batch_links l WHERE l.child_batch_id IN (SELECT id FROM s)
            SQL, [$orgId, $orgId, $orgId, $orgId]];
    }

    /**
     * The predicate "batch $batchIdSql is visible to $p" (deletion of the batch not included).
     *
     * @return array{0: string, 1: list<mixed>}
     */
    public static function batchVisibleTo(Principal $p, string $batchIdSql): array
    {
        if ($p->seesAll()) {
            return ['true', []];
        }
        $parts = [];
        $bindings = [];
        if ($p->hasRole('LAB')) {
            $parts[] = "EXISTS (SELECT 1 FROM lab_tests t WHERE t.batch_id = {$batchIdSql} AND t.deleted_at IS NULL AND t.lab_org_id = ?)";
            $bindings[] = $p->orgId;
        }
        if ($p->isParticipant()) {
            [$ids, $b] = self::participantBatchIds($p->orgId);
            $parts[] = "{$batchIdSql} IN ({$ids})";
            array_push($bindings, ...$b);
        }
        if ($parts === []) {
            return ['false', []];
        }

        return ['('.implode(' OR ', $parts).')', $bindings];
    }
}
