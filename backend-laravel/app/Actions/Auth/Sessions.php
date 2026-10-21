<?php

namespace App\Actions\Auth;

use App\Infrastructure\Db\Tx;
use App\Security\OpaqueTokens;
use Illuminate\Support\Facades\DB;

/**
 * Refresh tokens (R32, R40, P12; Express modules/auth/sessions.ts): an opaque token in the `at_refresh` cookie,
 * stored as its sha256 in the shared `refresh_tokens`, 14 days (`expires_at = now() + 14 d` in SQL, P43). Every
 * refresh rotates: the presented row gets `revoked_at` and `replaced_by` = the new row, so one session is a chain. A
 * row revoked with `replaced_by` null was revoked by logout, a password reset, a 403 on refresh, blocking or a chain
 * revocation — never by rotation.
 */
final class Sessions
{
    public const TTL_SEC = 1209600;

    /** R32: a token rotated at most this long ago is a race between tabs, not a reuse. */
    public const GRACE_MS = 10_000;

    /**
     * Inserts a new refresh token row; returns [id, token] (only the hash is stored).
     *
     * @return array{0: string, 1: string}
     */
    public static function create(string $userId): array
    {
        $token = OpaqueTokens::new();
        $row = DB::selectOne(
            "INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
             VALUES (?, ?, now() + ? * interval '1 second') RETURNING id",
            [$userId, OpaqueTokens::hash($token), self::TTL_SEC],
        );

        return [$row->id, $token];
    }

    /**
     * P12: every transaction that revokes or rotates several refresh tokens of a user first takes this per-user
     * advisory lock (the contract's lock order: before any row lock).
     */
    public static function lockUser(string $userId): void
    {
        DB::select("SELECT pg_advisory_xact_lock(hashtext('refresh:' || ?::text))", [$userId]);
    }

    /** Every live refresh token of the user (password reset, blocking) — under the user's advisory lock. */
    public static function revokeAll(string $userId, string $now): void
    {
        self::lockUser($userId);
        DB::update('UPDATE refresh_tokens SET revoked_at = ?::timestamptz WHERE user_id = ? AND revoked_at IS NULL', [$now, $userId]);
    }

    /** logout: revokes the presented token if it is live (idempotent). */
    public static function revoke(?string $token): void
    {
        if (! self::wellFormed($token)) {
            return;
        }
        DB::update('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = ? AND revoked_at IS NULL', [OpaqueTokens::hash($token)]);
    }

    public static function wellFormed(?string $token): bool
    {
        return $token !== null && strlen($token) >= 16 && strlen($token) <= 256
            && strspn($token, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-') === strlen($token);
    }

    /**
     * refreshToken: the owner by hash without a lock, then the user's advisory lock, then the row FOR NO KEY UPDATE —
     * two parallel refreshes with one token rotate once (the second sees the row just rotated: grace → 401 without
     * cookie deletion); parallel stale tokens of one chain are handled one at a time.
     *
     * @return array{kind: 'rotated', userId: string, token: string}|array{kind: 'expired', clearCookie: bool}|array{kind: 'forbidden', reason: string}
     */
    public static function rotate(?string $token): array
    {
        if (! self::wellFormed($token)) {
            return ['kind' => 'expired', 'clearCookie' => true];
        }
        $hash = OpaqueTokens::hash($token);

        return Tx::run(function () use ($hash): array {
            $owner = DB::selectOne('SELECT user_id FROM refresh_tokens WHERE token_hash = ?', [$hash]);
            if ($owner === null) {
                return ['kind' => 'expired', 'clearCookie' => true];
            }
            self::lockUser($owner->user_id);
            $now = Tx::now();
            $row = DB::selectOne(
                'SELECT id, user_id, revoked_at::text AS revoked_at, replaced_by,
                        (expires_at <= ?::timestamptz) AS expired,
                        (revoked_at IS NOT NULL AND ?::timestamptz - revoked_at <= ? * interval \'1 millisecond\') AS in_grace
                   FROM refresh_tokens WHERE token_hash = ? FOR NO KEY UPDATE',
                [$now, $now, self::GRACE_MS, $hash],
            );
            if ($row === null) {
                return ['kind' => 'expired', 'clearCookie' => true];
            }
            if ($row->revoked_at !== null) {
                if ($row->replaced_by === null) {
                    return ['kind' => 'expired', 'clearCookie' => true];
                }
                if ($row->in_grace) {
                    return ['kind' => 'expired', 'clearCookie' => false];
                }
                self::revokeChain($row->id, $now);

                return ['kind' => 'expired', 'clearCookie' => true];
            }
            if ($row->expired) {
                return ['kind' => 'expired', 'clearCookie' => true];
            }
            $u = DB::selectOne(
                'SELECT u.status, u.deleted_at IS NOT NULL AS deleted, o.status AS org_status, o.deleted_at IS NOT NULL AS org_deleted
                   FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = ?',
                [$row->user_id],
            );
            $revoke = fn () => DB::update('UPDATE refresh_tokens SET revoked_at = ?::timestamptz WHERE id = ?', [$now, $row->id]);
            if ($u === null || $u->deleted || $u->status === 'INVITED') {
                $revoke();

                return ['kind' => 'expired', 'clearCookie' => true];
            }
            if ($u->status === 'BLOCKED') {
                $revoke();

                return ['kind' => 'forbidden', 'reason' => 'USER_BLOCKED'];
            }
            if ($u->org_status !== 'ACTIVE' || $u->org_deleted) {
                $revoke();

                return ['kind' => 'forbidden', 'reason' => 'ORGANIZATION_NOT_ACTIVE'];
            }
            [$nextId, $nextToken] = self::create($row->user_id);
            DB::update('UPDATE refresh_tokens SET revoked_at = ?::timestamptz, replaced_by = ? WHERE id = ?', [$now, $nextId, $row->id]);

            return ['kind' => 'rotated', 'userId' => $row->user_id, 'token' => $nextToken];
        });
    }

    /**
     * R40: revokes the rotation chain of $id — its ancestors and descendants through `replaced_by` (the active one
     * included); other sessions of the user are untouched. Under the user's advisory lock.
     */
    private static function revokeChain(string $id, string $now): void
    {
        DB::update(<<<'SQL'
            WITH RECURSIVE down(id, replaced_by) AS (
              SELECT id, replaced_by FROM refresh_tokens WHERE id = ?
              UNION
              SELECT r.id, r.replaced_by FROM refresh_tokens r JOIN down d ON r.id = d.replaced_by
            ), up(id) AS (
              SELECT id FROM refresh_tokens WHERE id = ?
              UNION
              SELECT r.id FROM refresh_tokens r JOIN up u ON r.replaced_by = u.id
            )
            UPDATE refresh_tokens SET revoked_at = ?::timestamptz
             WHERE revoked_at IS NULL AND id IN (SELECT id FROM down UNION SELECT id FROM up)
            SQL, [$id, $id, $now]);
    }
}
