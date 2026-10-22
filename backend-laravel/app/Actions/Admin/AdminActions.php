<?php

namespace App\Actions\Admin;

use App\Contract\RulesRepo;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\AdminSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Queries\PublicCache;
use App\Security\FileUrls;
use App\Security\Principal;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;
use LogicException;

/**
 * Administration of organizations (contracts/openapi/paths/admin.yaml, FR-ADM-01, FR-IAM-01; R54/D25–D26, R59;
 * Express admin/service.ts). Status changes follow contracts/rules/entity-state-machines.json (`organization`):
 * approveOrganization moves PENDING/MANUAL_CHECK → ACTIVE; updateAdminOrganization rejects applications and
 * suspends/resumes (PLATFORM never changes its status). Both lock the organization row FOR NO KEY UPDATE first (R47:
 * `organization` in the lock order) and run every check on the locked row.
 */
final class AdminActions
{
    public const STATUSES = ['PENDING', 'MANUAL_CHECK', 'ACTIVE', 'REJECTED', 'SUSPENDED'];

    public const TYPES = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY', 'PLATFORM'];

    /** Contract `RegionCode`. */
    public const REGION_CODE = '^[0-9A-Z-]{1,8}$';

    /** `from>to` pairs the machine allows for the operation $by. */
    private static function allowed(string $by, string $from, string $to): bool
    {
        foreach (RulesRepo::json('entity-state-machines')['organization']['transitions'] as $t) {
            if ($t['by'] === $by && $t['from'] === $from && $t['to'] === $to) {
                return true;
            }
        }

        return false;
    }

    /**
     * `OrganizationAdmin` views of $ids, in the order given.
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    public static function views(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $rows = DB::select("SELECT o.id, o.name, o.type, o.logo_file_id, o.inn, o.address, o.trust_rating, o.status,
                o.created_at::text AS created_at, o.updated_at::text AS updated_at, r.code AS region_code, r.name AS region_name,
                (SELECT count(*) FROM users u WHERE u.organization_id = o.id AND u.deleted_at IS NULL) AS users_count,
                (SELECT json_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'phone', u.phone)::text
                   FROM users u
                  WHERE u.organization_id = o.id AND u.deleted_at IS NULL AND u.is_org_admin
                  ORDER BY u.created_at, u.id LIMIT 1) AS head
              FROM organizations o JOIN regions r ON r.id = o.region_id WHERE o.id IN ({$marks})", $ids);
        $byId = [];
        foreach ($rows as $o) {
            $byId[$o->id] = $o;
        }
        $out = [];
        foreach ($ids as $id) {
            $o = $byId[$id] ?? null;
            if ($o === null) {
                continue;
            }
            $head = $o->head !== null ? json_decode($o->head, true) : null;
            $out[] = [
                'id' => $o->id,
                'name' => $o->name,
                'type' => $o->type,
                'logoUrl' => $o->logo_file_id !== null ? FileUrls::public($o->logo_file_id) : null,
                'inn' => $o->inn,
                'address' => $o->address,
                'region' => ['code' => $o->region_code, 'name' => $o->region_name],
                'trustRating' => $o->type === 'FARM' && $o->trust_rating !== null ? (int) $o->trust_rating : null,
                'status' => $o->status,
                'createdAt' => Iso::fromPg($o->created_at),
                'updatedAt' => Iso::fromPg($o->updated_at),
                'usersCount' => (int) $o->users_count,
                'head' => $head !== null ? [
                    'id' => $head['id'],
                    'fullName' => $head['full_name'],
                    'email' => mb_strtolower($head['email'], 'UTF-8'),
                    'phone' => $head['phone'],
                ] : null,
            ];
        }

        return $out;
    }

    /** @return array<string, mixed> */
    private static function view(string $id): array
    {
        return self::views([$id])[0] ?? throw new LogicException("organization {$id} vanished");
    }

    /** The organization row, locked FOR NO KEY UPDATE; 404 when missing or deleted. */
    private static function lockOrganization(string $id): \stdClass
    {
        return DB::selectOne('SELECT id, type, name, address, region_id, status FROM organizations
             WHERE id = ? AND deleted_at IS NULL FOR NO KEY UPDATE', [$id]) ?? throw new Problem(404, ProblemCode::NOT_FOUND);
    }

    /**
     * listAdminOrganizations — every non-deleted organization; status/type repeat; regionCode; q (name or INN).
     *
     * @return array<string, mixed>
     */
    public static function list(QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(['createdAt', 'name'], 'createdAt,desc');
        $text = $q->q();
        $statuses = $q->enums('status', self::STATUSES);
        $types = $q->enums('type', self::TYPES);
        $regionCode = $q->matching('regionCode', self::REGION_CODE);
        $q->done();

        $where = ['o.deleted_at IS NULL'];
        $bindings = [];
        if ($statuses !== null) {
            $where[] = 'o.status IN ('.implode(',', array_fill(0, count($statuses), '?')).')';
            array_push($bindings, ...$statuses);
        }
        if ($types !== null) {
            $where[] = 'o.type IN ('.implode(',', array_fill(0, count($types), '?')).')';
            array_push($bindings, ...$types);
        }
        if ($regionCode !== null) {
            $where[] = 'o.region_id IN (SELECT id FROM regions WHERE code = ?)';
            $bindings[] = $regionCode;
        }
        if ($text !== null) {
            // Name: substring without case; INN: prefix. `%`, `_`, `\` are ordinary characters (no LIKE).
            $where[] = '(position(lower(?) in lower(o.name)) > 0 OR starts_with(o.inn, ?))';
            array_push($bindings, $text, $text);
        }
        $cond = implode(' AND ', $where);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM organizations o WHERE {$cond}", $bindings)->total;
        $order = $sort['field'] === 'name' ? 'o.name COLLATE "C"' : 'o.created_at';
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $ids = array_map(fn ($r) => $r->id, DB::select("SELECT o.id FROM organizations o WHERE {$cond}
            ORDER BY {$order} {$dir}, o.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]));

        return ['items' => self::views($ids), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /**
     * updateAdminOrganization — order: 400 body → lock → 404 → 409 INVALID_TRANSITION (status differs and the machine
     * does not allow it, or PLATFORM) → 400 regionCode notFound. Only changed fields are written and audited; a change
     * of name or region drops the public pages that show the organization (R82).
     *
     * @return array<string, mixed>
     */
    public static function update(Principal $p, string $id, mixed $body): array
    {
        $input = AdminSchemas::organizationAdminPatch()->parse($body);
        $codes = Tx::run(function () use ($p, $id, $input): array {
            $o = self::lockOrganization($id);
            $status = $input['status'] ?? null;
            if ($status !== null && $status !== $o->status) {
                if ($o->type === 'PLATFORM' || ! self::allowed('updateAdminOrganization', $o->status, $status)) {
                    throw new Problem(409, ProblemCode::INVALID_TRANSITION, params: ['from' => $o->status, 'to' => $status]);
                }
            }
            $current = DB::selectOne('SELECT id, code FROM regions WHERE id = ?', [$o->region_id]);
            $region = $current;
            if (isset($input['regionCode']) && $input['regionCode'] !== $current->code) {
                $region = DB::selectOne('SELECT id, code FROM regions WHERE code = ? FOR KEY SHARE', [$input['regionCode']]);
                if ($region === null) {
                    throw Problem::validation(['regionCode' => ['validation.notFound']]);
                }
            }
            $before = ['name' => $o->name, 'address' => $o->address, 'regionCode' => $current->code, 'status' => $o->status];
            $after = [
                'name' => $input['name'] ?? $o->name,
                'address' => array_key_exists('address', $input) ? $input['address'] : $o->address,
                'regionCode' => $region->code,
                'status' => $status ?? $o->status,
            ];
            $diff = AuditLog::diff($before, $after);
            if ($diff === []) {
                return [];
            }
            DB::update('UPDATE organizations SET name = ?, address = ?, region_id = ?, status = ?, updated_at = now() WHERE id = ?',
                [$after['name'], $after['address'], $region->id, $after['status'], $id]);
            AuditLog::write($p->userId, 'updateAdminOrganization', 'organization', $id, $diff);

            return isset($diff['name']) || isset($diff['regionCode']) ? PublicCache::organizationPageCodes($id) : [];
        });
        PublicCache::dropCodes($codes);

        return self::view($id);
    }

    /**
     * approveOrganization — PENDING/MANUAL_CHECK → ACTIVE on the locked row; otherwise 409 {from, to: ACTIVE}. The
     * operation declares no 400: a malformed id names no organization → 404 (D1).
     *
     * @return array<string, mixed>
     */
    public static function approve(Principal $p, string $id): array
    {
        Tx::run(function () use ($p, $id): void {
            $o = self::lockOrganization($id);
            if (! self::allowed('approveOrganization', $o->status, 'ACTIVE')) {
                throw new Problem(409, ProblemCode::INVALID_TRANSITION, params: ['from' => $o->status, 'to' => 'ACTIVE']);
            }
            DB::update("UPDATE organizations SET status = 'ACTIVE', updated_at = now() WHERE id = ?", [$id]);
            AuditLog::write($p->userId, 'approveOrganization', 'organization', $id, ['status' => [$o->status, 'ACTIVE']]);
        });

        return self::view($id);
    }
}
