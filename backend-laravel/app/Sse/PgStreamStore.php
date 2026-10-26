<?php

namespace App\Sse;

use App\Actions\Notifications\NotificationsActions;
use App\Infrastructure\Db\SlotHolder;
use Illuminate\Support\Facades\DB;

/** StreamStore on the application's connection (a DbSlots slot while a query runs, released by release()). */
final class PgStreamStore implements StreamStore
{
    public const LATE_COMMIT_WINDOW_SEC = 60;

    public function maxSeq(string $userId): int
    {
        return (int) DB::selectOne("SELECT coalesce(max(seq), 0)::text AS max FROM notifications
             WHERE user_id = ? AND channel = 'IN_APP'", [$userId])->max;
    }

    public function replay(string $userId, int $lastSeq, int $after, int $limit): array
    {
        $rows = DB::select('SELECT '.self::cols('n')." FROM notifications n
             WHERE n.user_id = ? AND n.channel = 'IN_APP' AND n.seq > ?::bigint
               AND (n.seq > ?::bigint
                    OR (n.seq < ?::bigint AND NOT n.is_read
                        AND n.created_at >= (SELECT l.created_at - make_interval(secs => ?)
                                               FROM notifications l
                                              WHERE l.seq = ?::bigint AND l.user_id = ?)))
             ORDER BY n.seq LIMIT ?",
            [$userId, $after, $lastSeq, $lastSeq, self::LATE_COMMIT_WINDOW_SEC, $lastSeq, $userId, $limit]);

        return array_map(NotificationsActions::view(...), $rows);
    }

    public function catchUp(string $userId, int $watermark, string $sinceIso, int $after, int $limit): array
    {
        $rows = DB::select('SELECT '.self::cols('n')." FROM notifications n
             WHERE n.user_id = ? AND n.channel = 'IN_APP' AND n.seq > ?::bigint
               AND (n.seq > ?::bigint
                    OR (n.seq < ?::bigint AND NOT n.is_read
                        AND n.created_at >= ?::timestamptz - make_interval(secs => ?)))
             ORDER BY n.seq LIMIT ?",
            [$userId, $after, $watermark, $watermark, $sinceIso, self::LATE_COMMIT_WINDOW_SEC, $limit]);

        return array_map(NotificationsActions::view(...), $rows);
    }

    public function row(string $userId, string $id): ?array
    {
        $r = DB::selectOne('SELECT '.self::cols('n')." FROM notifications n
             WHERE n.id = ?::uuid AND n.user_id = ? AND n.channel = 'IN_APP'", [$id, $userId]);

        return $r === null ? null : NotificationsActions::view($r);
    }

    public function unread(string $userId): int
    {
        return NotificationsActions::unread($userId);
    }

    public function release(): void
    {
        SlotHolder::release();
    }

    private static function cols(string $t): string
    {
        return "{$t}.id, {$t}.seq::text AS seq, {$t}.type, {$t}.payload::text AS payload, {$t}.is_read, {$t}.created_at::text AS created_at";
    }
}
