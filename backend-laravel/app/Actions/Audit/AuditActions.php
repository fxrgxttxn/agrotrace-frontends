<?php

namespace App\Actions\Audit;

use App\Http\Query\QueryReader;
use App\Infrastructure\Audit\AuditLog;
use App\Security\FileUrls;
use App\Support\Iso;
use App\Support\Json;
use App\Support\UtcDays;
use Illuminate\Support\Facades\DB;

/**
 * listAuditLog (contracts/openapi/paths/audit.yaml; Express audit/service.ts): every row for ADMIN and INSPECTOR
 * alike; filters actorId, entityType, entityId, action (exact), backend, from/to (UTC dates of createdAt, inclusive —
 * UtcDays); sorted by createdAt, ties by id ascending in both directions.
 */
final class AuditActions
{
    private const BACKENDS = ['express', 'django', 'laravel', 'seed', 'system'];

    /** @return array<string, mixed> */
    public static function list(QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(['createdAt'], 'createdAt,desc');
        $actorId = $q->uuid('actorId');
        $entityType = $q->enum('entityType', AuditLog::ENTITY_TYPES);
        $entityId = $q->uuid('entityId');
        $action = $q->text('action', 64);
        $backend = $q->enum('backend', self::BACKENDS);
        ['from' => $from, 'to' => $to] = $q->dateRange();
        $q->done();

        $where = ['TRUE'];
        $bindings = [];
        foreach (['a.actor_id' => $actorId, 'a.entity_type' => $entityType, 'a.entity_id' => $entityId, 'a.action' => $action, 'a.backend' => $backend] as $col => $v) {
            if ($v !== null) {
                $where[] = "{$col} = ?";
                $bindings[] = $v;
            }
        }
        [$days, $dayBindings] = UtcDays::range('a.created_at', $from, $to);
        array_push($where, ...$days);
        array_push($bindings, ...$dayBindings);
        $cond = implode(' AND ', $where);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM audit_log a WHERE {$cond}", $bindings)->total;
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $rows = DB::select("SELECT a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.diff::text AS diff, host(a.ip) AS ip,
                a.backend, a.request_id, a.created_at::text AS created_at, u.full_name,
                o.id AS org_id, o.name AS org_name, o.type AS org_type, o.logo_file_id
              FROM audit_log a
              LEFT JOIN users u ON u.id = a.actor_id
              LEFT JOIN organizations o ON o.id = u.organization_id
             WHERE {$cond}
             ORDER BY a.created_at {$dir}, a.id ASC LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]);

        return [
            'items' => array_map(fn ($r) => [
                'id' => (int) $r->id,
                'actor' => $r->actor_id !== null && $r->full_name !== null && $r->org_id !== null ? [
                    'id' => $r->actor_id,
                    'fullName' => $r->full_name,
                    'organization' => [
                        'id' => $r->org_id,
                        'name' => $r->org_name,
                        'type' => $r->org_type,
                        'logoUrl' => $r->logo_file_id !== null ? FileUrls::public($r->logo_file_id) : null,
                    ],
                ] : null,
                'action' => $r->action,
                'entityType' => $r->entity_type,
                'entityId' => $r->entity_id,
                'diff' => Json::decode($r->diff),
                'ip' => $r->ip,
                'backend' => $r->backend,
                'requestId' => $r->request_id,
                'createdAt' => Iso::fromPg($r->created_at),
            ], $rows),
            'page' => $page,
            'size' => $size,
            'total' => $total,
        ];
    }
}
