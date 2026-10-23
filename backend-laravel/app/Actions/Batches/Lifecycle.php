<?php

namespace App\Actions\Batches;

use App\Domain\StateMachine;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Outbox\Outbox;
use Illuminate\Support\Facades\DB;
use LogicException;

/**
 * Batch status transitions (contracts/rules/state-machine.json via StateMachine::canTransition; Express
 * batches/lifecycle.ts): every transition — automatic ones included — increments `version` by 1 and writes a
 * `batch_status_history` row (`reason`, the author or null for the server) at the transaction's `now()` (P43). The
 * caller holds the batch row lock (R47) and has checked the transition.
 */
final class Lifecycle
{
    public const REASONS = ['CREATED', 'TEST_REQUIRED', 'TEST_NOT_REQUIRED', 'LAB_PASS', 'LAB_FAIL', 'WAYBILL_SENT',
        'WAYBILL_ACCEPTED', 'WAYBILL_REJECTED', 'PROCESSED', 'ON_SALE', 'SOLD', 'RECALLED', 'WRITTEN_OFF'];

    public static function canGo(string $from, string $to): bool
    {
        return StateMachine::canTransition(['from' => $from, 'to' => $to])['allowed'];
    }

    /**
     * Moves the locked batch `status` → $to; returns the new version. `$extra` — further columns of the same UPDATE
     * (`holder_org_id`, `mass_kg`).
     *
     * @param  object{id: string, status: string, version: int|string}  $lockedBatch
     * @param  array<string, string|null>  $extra
     */
    public static function transition(object $lockedBatch, string $to, string $reason, ?string $userId, array $extra = []): int
    {
        if (! Tx::active()) {
            throw new LogicException('Lifecycle::transition outside Tx::run');
        }
        if (! self::canGo($lockedBatch->status, $to)) {
            throw new LogicException("batch {$lockedBatch->id}: {$lockedBatch->status} → {$to} is not a transition");
        }
        if (! in_array($reason, self::REASONS, true)) {
            throw new LogicException("unknown status reason {$reason}");
        }
        $version = (int) $lockedBatch->version + 1;
        $sets = ['status = ?', 'version = ?'];
        $bindings = [$to, $version];
        foreach ($extra as $column => $value) {
            if (! in_array($column, ['holder_org_id', 'mass_kg'], true)) {
                throw new LogicException("Lifecycle::transition cannot set {$column}");
            }
            $sets[] = "{$column} = ?";
            $bindings[] = $value;
        }
        DB::update('UPDATE batches SET '.implode(', ', $sets).' WHERE id = ?', [...$bindings, $lockedBatch->id]);
        DB::insert('INSERT INTO batch_status_history (batch_id, from_status, to_status, changed_by, reason, changed_at)
             VALUES (?, ?, ?, ?, ?, now())', [$lockedBatch->id, $lockedBatch->status, $to, $userId, $reason]);

        return $version;
    }

    /**
     * `notification.dispatch` into the outbox (contracts/rules/notifications.json: the type's recipients as logical
     * groups resolved to ids, `payload` with exactly the type's keys). Delivery is the worker's (Task 12).
     *
     * @param  array{userIds?: list<string>, orgIds?: list<string>, orgHeadIds?: list<string>, roles?: list<string>}  $recipients
     * @param  array<string, mixed>  $payload
     */
    public static function notify(string $type, array $recipients, array $payload): string
    {
        $uniq = fn (?array $xs): array => array_values(array_unique($xs ?? []));

        return Outbox::enqueue('notification.dispatch', [
            'notificationType' => $type,
            'recipients' => [
                'userIds' => $uniq($recipients['userIds'] ?? null),
                'orgIds' => $uniq($recipients['orgIds'] ?? null),
                'orgHeadIds' => $uniq($recipients['orgHeadIds'] ?? null),
                'roles' => $uniq($recipients['roles'] ?? null),
            ],
            'payload' => (object) $payload,
        ]);
    }
}
