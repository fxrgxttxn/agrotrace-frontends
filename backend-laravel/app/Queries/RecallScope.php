<?php

namespace App\Queries;

use App\Domain\Strings;
use Illuminate\Support\Facades\DB;

/**
 * Step 2 of the recall engine (tag Recalls; п. 7.6 raw `WITH RECURSIVE` over `batch_links`; Express recalls/engine.ts
 * `recallScope`): the source (SOURCE, depth 0) and its descendants (DOWN) — plus its ancestors (UP) when
 * `blockUpstream` — each once at its smallest depth 1…20. The walk passes THROUGH soft-deleted batches, which are not
 * members themselves; a batch found DOWN is not repeated UP. Ordered by id (code points). Runs in the caller's
 * transaction (REPEATABLE READ snapshot of the engine).
 */
final class RecallScope
{
    public const MAX_DEPTH = 20;

    /** @return list<array{batchId: string, direction: 'SOURCE'|'DOWN'|'UP', depth: int}> */
    public static function of(string $sourceBatchId, bool $blockUpstream): array
    {
        $members = [['batchId' => $sourceBatchId, 'direction' => 'SOURCE', 'depth' => 0]];
        $seen = [$sourceBatchId => true];
        foreach (self::walk($sourceBatchId, 'DOWN') as $r) {
            $seen[$r->id] = true;
            $members[] = ['batchId' => $r->id, 'direction' => 'DOWN', 'depth' => (int) $r->depth];
        }
        if ($blockUpstream) {
            foreach (self::walk($sourceBatchId, 'UP') as $r) {
                if (! isset($seen[$r->id])) {
                    $members[] = ['batchId' => $r->id, 'direction' => 'UP', 'depth' => (int) $r->depth];
                }
            }
        }
        usort($members, fn ($a, $b) => Strings::compareCodePoints($a['batchId'], $b['batchId']));

        return $members;
    }

    /** @return list<object{id: string, depth: int}> */
    private static function walk(string $sourceBatchId, string $direction): array
    {
        [$from, $to] = $direction === 'DOWN' ? ['parent_batch_id', 'child_batch_id'] : ['child_batch_id', 'parent_batch_id'];

        return DB::select("WITH RECURSIVE walk(id, depth) AS (
                SELECT l.{$to}, 1 FROM batch_links l WHERE l.{$from} = ?
                UNION
                SELECT l.{$to}, w.depth + 1 FROM batch_links l JOIN walk w ON l.{$from} = w.id
                 WHERE w.depth < ?
              )
              SELECT w.id, min(w.depth)::int AS depth FROM walk w JOIN batches b ON b.id = w.id
               WHERE b.deleted_at IS NULL AND w.id <> ?
               GROUP BY w.id", [$sourceBatchId, self::MAX_DEPTH, $sourceBatchId]);
    }
}
