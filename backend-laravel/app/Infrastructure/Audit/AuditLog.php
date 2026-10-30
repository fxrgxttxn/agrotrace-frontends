<?php

namespace App\Infrastructure\Audit;

use App\Infrastructure\Db\Tx;
use App\Support\Json;
use App\Support\RequestContext;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use LogicException;
use stdClass;

/**
 * Audit log writer (contract `AuditEntry`, spec 8.8; Express modules/audit/service.ts): one row per changed entity
 * row, in the SAME transaction as the change — backend `laravel`, `action` = operationId (`system.<job>` with a null
 * actor), `diff` = {apiField: [before, after]} in API formats with secrets as "***", `ip` and `request_id` from the
 * request context, `created_at` = the transaction's now() (column default, P43).
 */
final class AuditLog
{
    public const SECRET = '***';

    public const ENTITY_TYPES = [
        'organization', 'user', 'field', 'treatment', 'batch', 'waybill', 'labTest', 'recall', 'recallTask',
        'complaint', 'product', 'substance', 'indicator', 'norm', 'region', 'file', 'batchDocument',
    ];

    /** @param  array<string, array{0: mixed, 1: mixed}>|stdClass  $diff */
    public static function write(
        ?string $actorId,
        string $action,
        string $entityType,
        ?string $entityId,
        array|stdClass $diff,
    ): void {
        if (! in_array($entityType, self::ENTITY_TYPES, true)) {
            throw new InvalidArgumentException("unknown audit entity type {$entityType}");
        }
        if (! Tx::active()) {
            throw new LogicException('AuditLog::write outside Tx::run: the entry must commit with its change');
        }
        $ctx = app(RequestContext::class);
        DB::insert(
            'INSERT INTO audit_log (actor_id, action, entity_type, entity_id, diff, ip, backend, request_id)
             VALUES (?, ?, ?, ?, ?::jsonb, ?::inet, ?, ?)',
            [
                $actorId, $action, $entityType, $entityId,
                Json::encode(is_array($diff) ? ($diff === [] ? new stdClass : Json::obj($diff)) : $diff),
                $ctx->clientIp(), 'laravel', $ctx->requestId(),
            ],
        );
    }

    /**
     * `{field: [before, after]}` over the fields whose values differ (JSON equality); `$before` = null → a creation:
     * every non-null field of `$after`, with null before. Values must already be in API format.
     *
     * @param  array<string, mixed>|null  $before
     * @param  array<string, mixed>  $after
     * @return array<string, array{0: mixed, 1: mixed}>
     */
    public static function diff(?array $before, array $after): array
    {
        $out = [];
        foreach ($after as $k => $v) {
            $b = $before !== null ? ($before[$k] ?? null) : null;
            if ($before === null && $v === null) {
                continue;
            }
            if (Json::encode($b) !== Json::encode($v)) {
                $out[$k] = [$b, $v];
            }
        }

        return $out;
    }
}
