<?php

namespace App\Actions\Notifications;

use App\Contract\RulesRepo;
use App\Http\Problem\Problem;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\NotificationSchemas;
use App\Infrastructure\Db\Tx;
use App\Security\Principal;
use App\Support\Iso;
use App\Support\JsNumber;
use App\Support\Json;
use App\Support\UtcDays;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * Notification center (contracts/openapi/paths/notifications.yaml, FR-NOTIF-01…04; Express
 * modules/notifications/service.ts): the user's own IN_APP rows — EMAIL/TELEGRAM rows are delivery records, never
 * listed — and marking them read. After a mark the transaction runs
 * `pg_notify('notifications', json_build_object('user_id', :userId, 'unread', true)::text)`, delivered to every LISTEN
 * session at commit, so the user's SSE streams on any implementation get a fresh `unread`. Marking has no audit row
 * (the audit_log CHECK has no notification entity).
 */
final class NotificationsActions
{
    /** The columns of a Notification view (seq as text: bigint). */
    public const COLUMNS = 'id, seq::text AS seq, type, payload::text AS payload, is_read, created_at::text AS created_at';

    /** @return array{items: list<array<string, mixed>>, page: int, size: int, total: int} */
    public static function list(Principal $p, QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(['seq'], 'seq,desc');
        $isRead = $q->bool('isRead');
        $types = $q->enums('type', array_keys(RulesRepo::json('notifications')['types']));
        ['from' => $from, 'to' => $to] = $q->dateRange();
        $q->done();

        $where = ['user_id = ?', "channel = 'IN_APP'"];
        $bindings = [$p->userId];
        if ($isRead !== null) {
            $where[] = 'is_read = ?';
            $bindings[] = $isRead;
        }
        if ($types !== null) {
            $where[] = 'type IN ('.implode(',', array_fill(0, count($types), '?')).')';
            array_push($bindings, ...$types);
        }
        // from/to — by the UTC date of createdAt.
        [$days, $dayBindings] = UtcDays::range('created_at', $from, $to);
        array_push($where, ...$days);
        array_push($bindings, ...$dayBindings);
        $cond = implode(' AND ', $where);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM notifications WHERE {$cond}", $bindings)->total;
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $rows = DB::select('SELECT '.self::COLUMNS." FROM notifications WHERE {$cond}
             ORDER BY notifications.seq {$dir}, notifications.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]);

        return ['items' => array_map(self::view(...), $rows), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /**
     * markNotificationsRead — `ids` (each the caller's own IN_APP row, else 400 `ids[i]` validation.notFound and
     * nothing marked) or `upToSeq`; idempotent; returns the unread count.
     *
     * @return array{count: int}
     */
    public static function markRead(Principal $p, mixed $raw): array
    {
        /** @var array{ids?: list<string>, upToSeq?: int|float} $body */
        $body = NotificationSchemas::markRead()->parse($raw);

        return Tx::run(function () use ($p, $body): array {
            if (isset($body['ids'])) {
                $ids = array_map('strtolower', $body['ids']);
                $place = implode(',', array_fill(0, count($ids), '?::uuid'));
                $own = array_flip(array_map(fn (stdClass $r) => (string) $r->id, DB::select(
                    "SELECT id FROM notifications WHERE id IN ({$place}) AND user_id = ? AND channel = 'IN_APP'",
                    [...$ids, $p->userId])));
                $errors = [];
                foreach ($ids as $i => $id) {
                    if (! isset($own[$id])) {
                        $errors["ids[{$i}]"] = ['validation.notFound'];
                    }
                }
                if ($errors !== []) {
                    throw Problem::validation($errors);
                }
                DB::update("UPDATE notifications SET is_read = true
                     WHERE user_id = ? AND channel = 'IN_APP' AND is_read = false AND id IN ({$place})", [$p->userId, ...$ids]);
            } else {
                DB::update("UPDATE notifications SET is_read = true
                     WHERE user_id = ? AND channel = 'IN_APP' AND is_read = false AND seq <= ?::bigint",
                    [$p->userId, JsNumber::text($body['upToSeq'] ?? 0)]);
            }
            DB::select("SELECT pg_notify('notifications', json_build_object('user_id', ?::uuid, 'unread', true)::text)", [$p->userId]);

            return ['count' => self::unread($p->userId)];
        });
    }

    /** The user's unread IN_APP count. */
    public static function unread(string $userId): int
    {
        return (int) DB::selectOne("SELECT count(*) AS n FROM notifications
             WHERE user_id = ? AND channel = 'IN_APP' AND is_read = false", [$userId])->n;
    }

    /**
     * A row of COLUMNS as the contract's Notification (Express notificationView).
     *
     * @return array{id: string, seq: int, type: string, payload: stdClass, isRead: bool, createdAt: string}
     */
    public static function view(stdClass $r): array
    {
        $payload = $r->payload === null ? null : Json::decode((string) $r->payload);

        return [
            'id' => (string) $r->id,
            'seq' => (int) $r->seq,
            'type' => (string) $r->type,
            'payload' => $payload instanceof stdClass ? $payload : new stdClass,
            'isRead' => (bool) $r->is_read,
            'createdAt' => (string) Iso::fromPg((string) $r->created_at),
        ];
    }
}
