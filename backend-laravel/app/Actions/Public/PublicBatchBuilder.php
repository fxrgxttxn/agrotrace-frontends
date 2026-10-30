<?php

namespace App\Actions\Public;

use App\Actions\Batches\Path;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Redis\SharedRedis;
use App\Security\FileUrls;
use App\Support\Iso;
use App\Support\Json;
use Illuminate\Support\Facades\DB;

/**
 * The contract's `PublicBatch` (getPublicBatch; Express public/service.ts `buildPage`) as the exact JSON bytes, and its
 * shared cache `pub:batch:{publicCode}` (R82, R92, M10). No personal data: organization names, region, dates, the lab
 * summary and the status only; product photo and logo ids are taken as seeded (P32).
 */
final class PublicBatchBuilder
{
    public const TTL_SEC = 300;

    /** SafetyStatus by the batch status (schema SafetyStatus); any other status is SAFE. */
    private const SAFETY = [
        'Recalled' => 'RECALLED',
        'WrittenOff' => 'RECALLED',
        'Blocked' => 'BLOCKED',
        'Created' => 'UNKNOWN',
        'OnTest' => 'UNKNOWN',
    ];

    /** The page bytes of the non-deleted batch with $publicCode, or null. */
    public static function build(string $publicCode): ?string
    {
        return self::page($publicCode)['bytes'] ?? null;
    }

    /**
     * The page bytes from the cache — a hit is returned as stored, never parsed — or freshly built and stored for
     * 300 s; null when there is no such batch. After the SET the batch's version is read again and the key deleted if
     * it changed meanwhile: a change that committed (and deleted the key) while the page was being built would
     * otherwise leave a stale page (e.g. SAFE for a batch just recalled) for 5 minutes — every status change bumps
     * the version. No DB slot is held across a Redis call (P61).
     */
    public static function cached(string $publicCode): ?string
    {
        $redis = SharedRedis::client();
        $key = "pub:batch:{$publicCode}";
        $hit = $redis->get($key);
        if (is_string($hit)) {
            return $hit;
        }
        $built = self::page($publicCode);
        if ($built === null) {
            return null;
        }
        SlotHolder::release();
        $redis->set($key, $built['bytes'], ['EX' => self::TTL_SEC]);
        $now = DB::selectOne('SELECT version FROM batches WHERE id = ?', [$built['batchId']]);
        if ($now === null || (int) $now->version !== $built['version']) {
            SlotHolder::release();
            $redis->del($key);
        }

        return $built['bytes'];
    }

    /** @return array{bytes: string, batchId: string, version: int}|null */
    private static function page(string $code): ?array
    {
        $b = DB::selectOne(<<<'SQL'
            SELECT b.id, b.public_code, b.kind, b.status, b.version, b.origin_org_id,
                   b.harvested_at::text AS harvested_at, b.produced_at::text AS produced_at, b.created_at::text AS created_at,
                   p.name AS product_name, p.category AS product_category, p.image_file_id AS product_image,
                   o.name AS origin_name, o.logo_file_id AS origin_logo, r.code AS region_code, r.name AS region_name
              FROM batches b
              JOIN products p ON p.id = b.product_id
              JOIN organizations o ON o.id = b.origin_org_id
              JOIN regions r ON r.id = o.region_id
             WHERE b.public_code = ? AND b.deleted_at IS NULL
            SQL, [$code]);
        if ($b === null) {
            return null;
        }
        $done = DB::select(<<<'SQL'
            SELECT id, conclusion, completed_at::text AS completed_at FROM lab_tests
             WHERE batch_id = ? AND status = 'DONE' AND deleted_at IS NULL AND completed_at IS NOT NULL
             ORDER BY completed_at, id::text COLLATE "C"
            SQL, [$b->id]);
        $last = $done !== [] ? $done[count($done) - 1] : null;
        $page = [
            'publicCode' => $b->public_code,
            'product' => [
                'name' => $b->product_name,
                'category' => $b->product_category,
                'imageUrl' => $b->product_image !== null ? FileUrls::public($b->product_image) : null,
            ],
            'origin' => [
                'farmName' => $b->origin_name,
                'logoUrl' => $b->origin_logo !== null ? FileUrls::public($b->origin_logo) : null,
                'region' => ['code' => $b->region_code, 'name' => $b->region_name],
            ],
            'harvestedAt' => Iso::fromPg($b->harvested_at),
            'producedAt' => Iso::fromPg($b->produced_at),
            'status' => $b->status,
            'safety' => self::SAFETY[$b->status] ?? 'SAFE',
            'path' => array_map(fn (array $s) => [
                'orgName' => $s['org']['name'],
                'orgType' => $s['org']['type'],
                'logoUrl' => $s['org']['logoUrl'],
                'from' => $s['from'],
                'to' => $s['to'],
            ], Path::stages($b)),
            'labSummary' => [
                'total' => count($done),
                'passed' => count(array_filter($done, fn ($t) => $t->conclusion === 'PASS')),
                'lastConclusion' => $last?->conclusion,
                'lastDate' => Iso::fromPg($last?->completed_at),
            ],
        ];

        return ['bytes' => Json::encode($page), 'batchId' => $b->id, 'version' => (int) $b->version];
    }
}
