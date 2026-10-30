<?php

namespace App\Actions\Organizations;

use App\Http\Multipart\Upload;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Files\Files;
use App\Queries\PublicCache;
use App\Queries\Visibility;
use App\Security\FileUrls;
use App\Security\Principal;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * Organizations (contracts/openapi/paths/organizations.yaml; Express modules/organizations/service.ts). A card is
 * visible as Visibility says (an invisible one is indistinguishable from a missing one: 404); the directory
 * (listOrganizations, R46) is every ACTIVE organization except PLATFORM, regardless of visibility.
 */
final class OrganizationsActions
{
    public const LOGO_MAX_BYTES = 2 * 1024 * 1024;

    public const LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];

    private const TYPES = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY', 'PLATFORM'];

    public static function visibleOr404(Principal $p, string $id): void
    {
        if (! Visibility::canSeeOrganization($p, $id)) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }
    }

    /**
     * getOrganization — `trustRating` only for farms.
     *
     * @return array<string, mixed>
     */
    public static function get(Principal $p, string $id): array
    {
        self::visibleOr404($p, $id);
        $o = DB::selectOne('SELECT o.id, o.name, o.type, o.logo_file_id, o.inn, o.address, o.trust_rating, o.status,
                r.code AS region_code, r.name AS region_name
              FROM organizations o JOIN regions r ON r.id = o.region_id WHERE o.id = ?', [$id]);

        return [
            'id' => $o->id,
            'name' => $o->name,
            'type' => $o->type,
            'logoUrl' => $o->logo_file_id !== null ? FileUrls::public($o->logo_file_id) : null,
            'inn' => $o->inn,
            'address' => $o->address,
            'region' => ['code' => $o->region_code, 'name' => $o->region_name],
            'trustRating' => $o->type === 'FARM' && $o->trust_rating !== null ? (int) $o->trust_rating : null,
            'status' => $o->status,
        ];
    }

    /**
     * listOrganizations — ACTIVE, not PLATFORM; `type` (repeated), `q` = name or INN prefix, case-insensitive.
     *
     * @return array<string, mixed>
     */
    public static function directory(QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(['name'], 'name,asc');
        $text = $q->q();
        $types = $q->enums('type', self::TYPES);
        $q->done();

        $where = ["o.status = 'ACTIVE'", "o.type <> 'PLATFORM'", 'o.deleted_at IS NULL'];
        $bindings = [];
        if ($types !== null) {
            $where[] = 'o.type IN ('.implode(',', array_fill(0, count($types), '?')).')';
            array_push($bindings, ...$types);
        }
        if ($text !== null) {
            $where[] = '(starts_with(lower(o.name), lower(?)) OR starts_with(o.inn, ?))';
            array_push($bindings, $text, $text);
        }
        $cond = implode(' AND ', $where);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM organizations o JOIN regions r ON r.id = o.region_id WHERE {$cond}", $bindings)->total;
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $rows = DB::select("SELECT o.id, o.name, o.type, o.logo_file_id, r.code AS region_code, r.name AS region_name
              FROM organizations o JOIN regions r ON r.id = o.region_id WHERE {$cond}
             ORDER BY o.name COLLATE \"C\" {$dir}, o.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]);

        return [
            'items' => array_map(fn (stdClass $o) => [
                'id' => $o->id,
                'name' => $o->name,
                'type' => $o->type,
                'logoUrl' => $o->logo_file_id !== null ? FileUrls::public($o->logo_file_id) : null,
                'region' => ['code' => $o->region_code, 'name' => $o->region_name],
            ], $rows),
            'page' => $page,
            'size' => $size,
            'total' => $total,
        ];
    }

    /**
     * uploadOrganizationLogo — 404 invisible, 403 a visible foreign one (heads: own only; ADMIN: any), then the file
     * (415); the old logo is soft-deleted; the public batch pages showing the organization are dropped after the
     * commit (R82 `pub:batch:*`). The visibility check's slot is given back before the image/SVG work (P61).
     *
     * @param  null|callable(): bool  $clientGone
     * @return array<string, mixed>
     */
    public static function uploadLogo(Principal $p, string $orgId, Upload $upload, ?callable $clientGone = null): array
    {
        self::visibleOr404($p, $orgId);
        if (! $p->isAdmin() && $orgId !== $p->orgId) {
            throw new Problem(403, ProblemCode::FORBIDDEN);
        }
        SlotHolder::release();
        $file = Files::prepare($upload, 'LOGO', $p->userId, self::LOGO_TYPES, $clientGone);
        Files::store($file);
        $codes = Tx::run(function () use ($p, $orgId, $file): array {
            $o = DB::selectOne('SELECT logo_file_id FROM organizations WHERE id = ? AND deleted_at IS NULL FOR NO KEY UPDATE', [$orgId]);
            if ($o === null) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            $now = Tx::now();
            Files::insert($file);
            DB::update('UPDATE organizations SET logo_file_id = ?, updated_at = ?::timestamptz WHERE id = ?', [$file->id(), $now, $orgId]);
            AuditLog::write($p->userId, 'uploadOrganizationLogo', 'file', $file->id(), AuditLog::diff(null, Files::auditView($file)));
            AuditLog::write($p->userId, 'uploadOrganizationLogo', 'organization', $orgId, ['logoFileId' => [$o->logo_file_id, $file->id()]]);
            if (Files::softDelete($o->logo_file_id, $now)) {
                AuditLog::write($p->userId, 'uploadOrganizationLogo', 'file', $o->logo_file_id, ['deletedAt' => [null, Iso::fromPg($now)]]);
            }

            return PublicCache::organizationPageCodes($orgId);
        });
        PublicCache::dropCodes($codes);
        $r = $file->row;

        return Files::ref($r['id'], 'LOGO', $r['mime'], $r['size_bytes'], $r['original_name']);
    }

    /** The current logo of a visible organization (404: invisible, missing, no logo). */
    public static function logoFile(Principal $p, string $orgId): stdClass
    {
        self::visibleOr404($p, $orgId);
        $f = DB::selectOne('SELECT f.id, f.object_key, f.original_name, f.mime, f.size_bytes, f.sha256, f.variants::text AS variants, f.kind, f.owner_id
              FROM organizations o JOIN files f ON f.id = o.logo_file_id WHERE o.id = ? AND f.deleted_at IS NULL', [$orgId]);

        return $f ?? throw new Problem(404, ProblemCode::NOT_FOUND);
    }
}
