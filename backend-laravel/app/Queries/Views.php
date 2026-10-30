<?php

namespace App\Queries;

use App\Security\FileUrls;
use App\Support\Json;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * The contract's `Me` and `User` (users.yaml) — Express modules/me/view.ts and users/view.ts: avatar a signed URL
 * (R28), organization logo a public URL, roles in the stable order of the `roles` dictionary, email lower-cased,
 * channels from `notification_channels` (`true` only when stored as true).
 */
final class Views
{
    private const USER_COLUMNS = <<<'SQL'
        u.id, u.email::text AS email, u.full_name, u.phone, u.avatar_file_id, u.is_org_admin, u.status, u.totp_enabled,
        u.notification_channels::text AS channels, u.telegram_chat_id IS NOT NULL AS telegram_linked,
        o.id AS org_id, o.name AS org_name, o.type AS org_type, o.logo_file_id,
        COALESCE((SELECT json_agg(r.code ORDER BY r.id) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                   WHERE ur.user_id = u.id), '[]')::text AS roles
        SQL;

    /**
     * `Me` of a non-deleted user, or null.
     *
     * @return array<string, mixed>|null
     */
    public static function me(string $userId): ?array
    {
        $u = DB::selectOne('SELECT '.self::USER_COLUMNS.' FROM users u JOIN organizations o ON o.id = u.organization_id
            WHERE u.id = ? AND u.deleted_at IS NULL', [$userId]);
        if ($u === null) {
            return null;
        }
        $channels = self::channels($u->channels);

        return [
            'id' => $u->id,
            'email' => mb_strtolower($u->email),
            'fullName' => $u->full_name,
            'phone' => $u->phone,
            'avatarUrl' => $u->avatar_file_id !== null ? FileUrls::signed($u->avatar_file_id) : null,
            'roles' => Json::decode($u->roles),
            'organization' => self::orgRef($u),
            'isOrgAdmin' => (bool) $u->is_org_admin,
            'totpEnabled' => (bool) $u->totp_enabled,
            'channels' => [
                'email' => $channels['email'],
                'telegram' => $channels['telegram'],
                'telegramLinked' => (bool) $u->telegram_linked,
            ],
        ];
    }

    /**
     * `User` views of $ids in the order given (missing ids are skipped).
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    public static function users(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $rows = DB::select('SELECT '.self::USER_COLUMNS." FROM users u JOIN organizations o ON o.id = u.organization_id
            WHERE u.id IN ({$marks})", $ids);
        $byId = [];
        foreach ($rows as $u) {
            $byId[$u->id] = $u;
        }
        $out = [];
        foreach ($ids as $id) {
            $u = $byId[$id] ?? null;
            if ($u === null) {
                continue;
            }
            $out[] = [
                'id' => $u->id,
                'email' => mb_strtolower($u->email),
                'fullName' => $u->full_name,
                'phone' => $u->phone,
                'avatarUrl' => $u->avatar_file_id !== null ? FileUrls::signed($u->avatar_file_id) : null,
                'roles' => Json::decode($u->roles),
                'isOrgAdmin' => (bool) $u->is_org_admin,
                'status' => $u->status,
                'organization' => self::orgRef($u),
            ];
        }

        return $out;
    }

    /** @return array{email: bool, telegram: bool} */
    public static function channels(?string $json): array
    {
        $c = $json !== null ? Json::decode($json) : null;

        return [
            'email' => $c instanceof stdClass && ($c->email ?? null) === true,
            'telegram' => $c instanceof stdClass && ($c->telegram ?? null) === true,
        ];
    }

    /** @return array{id: string, name: string, type: string, logoUrl: string|null} */
    private static function orgRef(stdClass $u): array
    {
        return [
            'id' => $u->org_id,
            'name' => $u->org_name,
            'type' => $u->org_type,
            'logoUrl' => $u->logo_file_id !== null ? FileUrls::public($u->logo_file_id) : null,
        ];
    }
}
