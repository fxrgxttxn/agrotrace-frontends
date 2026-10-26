<?php

namespace App\Notifications;

use App\Contract\RulesRepo;
use App\Infrastructure\Db\Tx;
use App\Support\Json;
use Illuminate\Support\Facades\DB;
use LogicException;
use stdClass;

/**
 * The storage half of the `notification.dispatch` algorithm (contracts/events/notification.dispatch.schema.json,
 * contracts/rules/notifications.json; Express notifications/dispatch.ts), shared by the handlers that create
 * notifications inside their own transaction (lab.escalate now; recall.requested — Task 10; notification.dispatch —
 * Task 12).
 *
 * Recipients: `userIds` as is, all users of `orgIds`, the heads (`is_org_admin`) of `orgHeadIds`, every user having a
 * role of `roles`; only ACTIVE, non-deleted users; the union deduplicated by user id (ordered by id). Per user: one
 * IN_APP row (DELIVERED; the table trigger emits pg_notify for SSE) and per external channel one PENDING row — EMAIL
 * when `channels.email` is true or the type is forced (RECALL, RECALL_TASK, OVERDUE), TELEGRAM when Telegram is linked
 * and (`channels.telegram` is true or the type is forced). Every row carries `payload`. Sending the PENDING rows after
 * the commit is the delivery half (Task 12); until then they stay PENDING.
 */
final class Insert
{
    /**
     * The recipients as users with their external channels.
     *
     * @param  array{userIds?: list<string>, orgIds?: list<string>, orgHeadIds?: list<string>, roles?: list<string>}  $recipients
     * @return list<object{id: string, email: bool, telegram: bool, linked: bool}>
     */
    public static function expand(array $recipients): array
    {
        return DB::select("SELECT u.id,
                   coalesce((u.notification_channels->>'email')::boolean, false) AS email,
                   coalesce((u.notification_channels->>'telegram')::boolean, false) AS telegram,
                   u.telegram_chat_id IS NOT NULL AS linked
              FROM users u
             WHERE u.status = 'ACTIVE' AND u.deleted_at IS NULL
               AND (u.id = ANY(?::uuid[])
                    OR u.organization_id = ANY(?::uuid[])
                    OR (u.is_org_admin AND u.organization_id = ANY(?::uuid[]))
                    OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                                WHERE ur.user_id = u.id AND ro.code = ANY(?::text[])))
             ORDER BY u.id", [
            self::pgArray($recipients['userIds'] ?? []),
            self::pgArray($recipients['orgIds'] ?? []),
            self::pgArray($recipients['orgHeadIds'] ?? []),
            self::pgArray($recipients['roles'] ?? []),
        ]);
    }

    /**
     * Resolves the recipients and inserts the rows in the current transaction; returns the ids of the PENDING
     * (external) rows to deliver.
     *
     * @param  array{userIds?: list<string>, orgIds?: list<string>, orgHeadIds?: list<string>, roles?: list<string>}  $recipients
     * @return list<string>
     */
    public static function rows(string $type, array $recipients, stdClass $payload): array
    {
        if (! Tx::active()) {
            throw new LogicException('Insert::rows outside Tx::run: the notifications commit with the handler\'s claim');
        }
        $rules = RulesRepo::json('notifications');
        if (! isset($rules['types'][$type])) {
            throw new LogicException("unknown notification type {$type}");
        }
        $users = self::expand($recipients);
        if ($users === []) {
            return [];
        }
        $forced = in_array($type, $rules['forcedChannels'], true);
        $json = Json::encode($payload);
        $values = [];
        $bindings = [];
        $add = function (string $userId, string $channel, string $status) use (&$values, &$bindings, $type, $json): void {
            $values[] = '(?, ?, ?::jsonb, ?, ?)';
            array_push($bindings, $userId, $type, $json, $channel, $status);
        };
        foreach ($users as $u) {
            $add($u->id, 'IN_APP', 'DELIVERED');
            if ($u->email === true || $forced) {
                $add($u->id, 'EMAIL', 'PENDING');
            }
            if ($u->linked === true && ($u->telegram === true || $forced)) {
                $add($u->id, 'TELEGRAM', 'PENDING');
            }
        }
        $pending = [];
        foreach (array_chunk($values, 500, true) as $chunk) {
            $first = array_key_first($chunk);
            $slice = array_slice($bindings, $first * 5, count($chunk) * 5);
            foreach (DB::select('INSERT INTO notifications (user_id, type, payload, channel, delivery_status) VALUES '
                .implode(', ', $chunk).' RETURNING id, delivery_status', $slice) as $r) {
                if ($r->delivery_status === 'PENDING') {
                    $pending[] = $r->id;
                }
            }
        }

        return $pending;
    }

    /**
     * A PostgreSQL array literal of plain tokens (uuids, role codes).
     *
     * @param  list<string>  $values
     */
    private static function pgArray(array $values): string
    {
        return '{'.implode(',', array_map(fn (string $v) => '"'.addcslashes($v, '"\\').'"', array_values(array_unique($values)))).'}';
    }
}
