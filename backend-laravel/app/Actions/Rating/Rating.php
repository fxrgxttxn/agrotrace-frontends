<?php

namespace App\Actions\Rating;

use App\Contract\RulesRepo;
use App\Domain\Rules;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use Illuminate\Support\Facades\DB;
use LogicException;

/**
 * BR-09 trust rating (contracts/events/rating.recalculate.schema.json, contracts/rules/trust-rating.json; Express
 * rating/rating.ts line by line): a full recomputation, never a delta — so any number of deliveries, in any order,
 * yields the same rating.
 *
 * Under the organization's row lock (`FOR NO KEY UPDATE`; R52 `organization`), for a FARM only: the left fold of
 * Rules::nextTrustRating from `initial` over every event of the farm, ordered by time asc, then lab events before
 * recall events, then id asc (code points):
 * - every non-deleted lab test with status DONE on a non-deleted batch the farm originated — LAB_PASS / LAB_FAIL at
 *   `completed_at`;
 * - every non-deleted recall whose source batch the farm originated — RECALL_SOURCE at `opened_at`.
 * A changed result is stored with the audit row `system.ratingRecalculate` (actor null, entityType organization, diff
 * `trustRating`). Other organization types are ignored.
 */
final class Rating
{
    /** The fold of the farm's events (no lock, no write); inside the caller's transaction. */
    public static function fold(string $orgId): int
    {
        if (! Tx::active()) {
            throw new LogicException('Rating::fold outside Tx::run');
        }
        $events = DB::select("SELECT e.event FROM (
              SELECT t.completed_at AS at, 0 AS kind, t.id::text AS id,
                     CASE t.conclusion WHEN 'PASS' THEN 'LAB_PASS' ELSE 'LAB_FAIL' END AS event
                FROM lab_tests t JOIN batches b ON b.id = t.batch_id
               WHERE t.status = 'DONE' AND t.deleted_at IS NULL AND b.deleted_at IS NULL AND b.origin_org_id = ?
              UNION ALL
              SELECT r.opened_at, 1, r.id::text, 'RECALL_SOURCE'
                FROM recalls r JOIN batches b ON b.id = r.source_batch_id
               WHERE r.deleted_at IS NULL AND b.origin_org_id = ?
            ) e
            ORDER BY e.at, e.kind, e.id COLLATE \"C\"", [$orgId, $orgId]);
        $rating = (int) RulesRepo::json('trust-rating')['initial'];
        foreach ($events as $e) {
            $rating = Rules::nextTrustRating(['current' => $rating, 'event' => $e->event])['rating'];
        }

        return $rating;
    }

    /**
     * Recomputes and stores the rating of $orgId inside the caller's transaction (after its event claim). before and
     * after are null when $orgId is not a FARM (or no such organization): nothing is done.
     *
     * @return array{before: int|null, after: int|null, changed: bool}
     */
    public static function recalculate(string $orgId): array
    {
        if (! Tx::active()) {
            throw new LogicException('Rating::recalculate outside Tx::run');
        }
        $org = DB::selectOne('SELECT id, type, trust_rating FROM organizations WHERE id = ? FOR NO KEY UPDATE', [$orgId]);
        if ($org === null || $org->type !== 'FARM') {
            return ['before' => null, 'after' => null, 'changed' => false];
        }
        $before = $org->trust_rating !== null ? (int) $org->trust_rating : null;
        $after = self::fold($orgId);
        if ($after === $before) {
            return ['before' => $before, 'after' => $after, 'changed' => false];
        }
        DB::update('UPDATE organizations SET trust_rating = ? WHERE id = ?', [$after, $orgId]);
        AuditLog::write(null, 'system.ratingRecalculate', 'organization', $orgId, ['trustRating' => [$before, $after]]);

        return ['before' => $before, 'after' => $after, 'changed' => true];
    }
}
