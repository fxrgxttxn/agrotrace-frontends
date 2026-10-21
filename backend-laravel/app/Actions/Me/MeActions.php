<?php

namespace App\Actions\Me;

use App\Http\Multipart\Upload;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Validation\Schemas\ProfileSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Files\Files;
use App\Infrastructure\Images\Images;
use App\Infrastructure\Redis\SharedRedis;
use App\Queries\Views;
use App\Security\Principal;
use App\Support\Iso;
use App\Support\Json;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Profile operations (contracts/openapi/paths/me.yaml; Express modules/me/service.ts): FR-IAM-07 (name, phone,
 * avatar), FR-NOTIF-02/03 (channels, the Telegram link code). MinIO objects are written before the row that points at
 * them, Redis after; image decoding and S3 run with no DB slot held (P61).
 */
final class MeActions
{
    public const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

    private const TGCODE_TTL_SEC = 600;

    private const TGCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    /**
     * R82/R90: `tgcode:{code}` = {"userId"} (NX — a code is never shared) and `tgcode-user:{userId}` = code, both 600 s;
     * the previous code of the user is deleted in the same script. 0 — the new code collides with a live one.
     * Verbatim the script of Express (modules/me/service.ts).
     */
    private const TGCODE_SCRIPT = <<<'LUA'

        local previous = redis.call('GET', KEYS[2])
        if not redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3], 'NX') then return 0 end
        if previous and previous ~= ARGV[2] then redis.call('DEL', 'tgcode:' .. previous) end
        redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
        return 1
        LUA;

    /** @return array<string, mixed> */
    public static function me(string $userId): array
    {
        // A deleted account's token lives out its 15 minutes: it no longer identifies a user.
        return Views::me($userId) ?? throw new Problem(401, ProblemCode::UNAUTHORIZED);
    }

    /**
     * updateMe — fullName and phone only (never trimmed, R36); `phone: null` removes the phone.
     *
     * @return array<string, mixed>
     */
    public static function updateMe(Principal $p, mixed $body): array
    {
        $input = ProfileSchemas::meUpdate()->parse($body);
        Tx::run(function () use ($p, $input): void {
            $u = DB::selectOne('SELECT full_name, phone FROM users WHERE id = ? AND deleted_at IS NULL FOR NO KEY UPDATE', [$p->userId]);
            if ($u === null) {
                throw new Problem(401, ProblemCode::UNAUTHORIZED);
            }
            $before = ['fullName' => $u->full_name, 'phone' => $u->phone];
            $after = [
                'fullName' => $input['fullName'] ?? $u->full_name,
                'phone' => array_key_exists('phone', $input) ? $input['phone'] : $u->phone,
            ];
            $diff = AuditLog::diff($before, $after);
            if ($diff === []) {
                return;
            }
            DB::update('UPDATE users SET full_name = ?, phone = ?, updated_at = now() WHERE id = ?', [$after['fullName'], $after['phone'], $p->userId]);
            AuditLog::write($p->userId, 'updateMe', 'user', $p->userId, $diff);
        });

        return self::me($p->userId);
    }

    /**
     * uploadMyAvatar — JPEG/PNG/WebP ≤ 2 MiB → WebP 96/480; the previous avatar file is soft-deleted.
     *
     * @return array<string, mixed>
     */
    public static function uploadAvatar(Principal $p, Upload $upload): array
    {
        SlotHolder::release();
        $file = Files::prepare($upload, 'AVATAR', $p->userId, Images::RASTER);
        Files::store($file);
        Tx::run(function () use ($p, $file): void {
            $u = DB::selectOne('SELECT avatar_file_id FROM users WHERE id = ? AND deleted_at IS NULL FOR NO KEY UPDATE', [$p->userId]);
            if ($u === null) {
                throw new Problem(401, ProblemCode::UNAUTHORIZED);
            }
            $now = Tx::now();
            Files::insert($file);
            DB::update('UPDATE users SET avatar_file_id = ?, updated_at = ?::timestamptz WHERE id = ?', [$file->id(), $now, $p->userId]);
            AuditLog::write($p->userId, 'uploadMyAvatar', 'file', $file->id(), AuditLog::diff(null, Files::auditView($file)));
            AuditLog::write($p->userId, 'uploadMyAvatar', 'user', $p->userId, ['avatarFileId' => [$u->avatar_file_id, $file->id()]]);
            if (Files::softDelete($u->avatar_file_id, $now)) {
                AuditLog::write($p->userId, 'uploadMyAvatar', 'file', $u->avatar_file_id, ['deletedAt' => [null, Iso::fromPg($now)]]);
            }
        });
        $r = $file->row;

        return Files::ref($r['id'], 'AVATAR', $r['mime'], $r['size_bytes'], $r['original_name']);
    }

    /** deleteMyAvatar — idempotent: 204 whether or not there was an avatar. */
    public static function deleteAvatar(Principal $p): void
    {
        Tx::run(function () use ($p): void {
            $u = DB::selectOne('SELECT avatar_file_id FROM users WHERE id = ? AND deleted_at IS NULL FOR NO KEY UPDATE', [$p->userId]);
            if ($u === null || $u->avatar_file_id === null) {
                return;
            }
            $now = Tx::now();
            DB::update('UPDATE users SET avatar_file_id = NULL, updated_at = ?::timestamptz WHERE id = ?', [$now, $p->userId]);
            Files::softDelete($u->avatar_file_id, $now);
            AuditLog::write($p->userId, 'deleteMyAvatar', 'user', $p->userId, ['avatarFileId' => [$u->avatar_file_id, null]]);
            AuditLog::write($p->userId, 'deleteMyAvatar', 'file', $u->avatar_file_id, ['deletedAt' => [null, Iso::fromPg($now)]]);
        });
    }

    /** @return array{email: bool, telegram: bool, telegramLinked: bool} */
    public static function channels(string $userId): array
    {
        return self::me($userId)['channels'];
    }

    /**
     * updateMyChannels — `telegram: true` needs a linked Telegram (400 validation.telegram.notLinked).
     *
     * @return array{email: bool, telegram: bool, telegramLinked: bool}
     */
    public static function updateChannels(Principal $p, mixed $body): array
    {
        $input = ProfileSchemas::channelsUpdate()->parse($body);
        Tx::run(function () use ($p, $input): void {
            $u = DB::selectOne('SELECT notification_channels::text AS channels, telegram_chat_id FROM users
                WHERE id = ? AND deleted_at IS NULL FOR NO KEY UPDATE', [$p->userId]);
            if ($u === null) {
                throw new Problem(401, ProblemCode::UNAUTHORIZED);
            }
            if ($input['telegram'] && $u->telegram_chat_id === null) {
                throw Problem::validation(['telegram' => ['validation.telegram.notLinked']]);
            }
            $before = Views::channels($u->channels);
            $after = ['email' => $input['email'], 'telegram' => $input['telegram']];
            if ($before === $after) {
                return;
            }
            DB::update('UPDATE users SET notification_channels = ?::jsonb, updated_at = now() WHERE id = ?', [Json::encode($after), $p->userId]);
            AuditLog::write($p->userId, 'updateMyChannels', 'user', $p->userId, ['channels' => [$before, $after]]);
        });

        return self::channels($p->userId);
    }

    /**
     * createTelegramCode — 8 characters [A-Z0-9], 10 minutes; a new code cancels the previous one (R82/R90).
     *
     * @return array{code: string, expiresAt: string, botUsername: string}
     */
    public static function createTelegramCode(Principal $p): array
    {
        $token = config('agrotrace.telegram.token');
        if (! is_string($token) || $token === '') {
            throw new Problem(503, ProblemCode::EXTERNAL_UNAVAILABLE, params: ['service' => 'telegram']);
        }
        self::me($p->userId);
        SlotHolder::release();
        $r = SharedRedis::client();
        for ($attempt = 0; $attempt < 5; $attempt++) {
            $code = '';
            for ($i = 0; $i < 8; $i++) {
                $code .= self::TGCODE_ALPHABET[random_int(0, strlen(self::TGCODE_ALPHABET) - 1)];
            }
            $issued = time();
            $ok = $r->eval(self::TGCODE_SCRIPT, [
                "tgcode:{$code}", "tgcode-user:{$p->userId}",
                Json::encode(['userId' => $p->userId]), $code, (string) self::TGCODE_TTL_SEC,
            ], 2);
            if ((int) $ok === 1) {
                return [
                    'code' => $code,
                    'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $issued + self::TGCODE_TTL_SEC),
                    'botUsername' => (string) config('agrotrace.telegram.username', 'agrotrace_bot'),
                ];
            }
        }
        throw new RuntimeException('createTelegramCode: could not draw a free code');
    }
}
