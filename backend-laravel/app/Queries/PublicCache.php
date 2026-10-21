<?php

namespace App\Queries;

use App\Infrastructure\Redis\SharedRedis;
use Illuminate\Support\Facades\DB;

/**
 * The public batch page cache (R82, R92; Express modules/public/cache.ts): `pub:batch:{publicCode}` holds the exact
 * PublicBatch JSON; an operation that changes what a page shows collects the affected codes inside its transaction
 * (a DB read) and deletes the keys after the commit (exact keys, in chunks of 500).
 */
final class PublicCache
{
    /**
     * Batches whose page shows the organization: it originates them, or it is a stage of their `path` (the receiver
     * of an accepted waybill with the batch) — logo, name, region.
     *
     * @return list<string>
     */
    public static function organizationPageCodes(string $orgId): array
    {
        $rows = DB::select(<<<'SQL'
            SELECT b.public_code FROM batches b WHERE b.origin_org_id = ?
            UNION
            SELECT b.public_code FROM waybills w
              JOIN waybill_items wi ON wi.waybill_id = w.id
              JOIN batches b ON b.id = wi.batch_id
             WHERE w.receiver_org_id = ? AND w.status = 'ACCEPTED'
            SQL, [$orgId, $orgId]);

        return array_map(fn ($r) => $r->public_code, $rows);
    }

    /**
     * @param  list<string>  $productIds
     * @return list<string>
     */
    public static function productPageCodes(array $productIds): array
    {
        if ($productIds === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($productIds), '?'));

        return array_map(fn ($r) => $r->public_code, DB::select("SELECT public_code FROM batches WHERE product_id IN ({$marks})", $productIds));
    }

    /** @param  list<string>  $codes */
    public static function dropCodes(array $codes): void
    {
        $r = SharedRedis::client();
        foreach (array_chunk($codes, 500) as $chunk) {
            $r->del(array_map(fn (string $c) => "pub:batch:{$c}", $chunk));
        }
    }

    /** Collects the organization's page codes and deletes them (call after the commit). */
    public static function dropForOrganization(string $orgId): void
    {
        self::dropCodes(self::organizationPageCodes($orgId));
    }
}
