<?php

namespace App\Actions\Auth;

use App\Contract\RulesRepo;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Validation\Schemas\AuthSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Dadata\Dadata;
use App\Infrastructure\Dadata\DadataResult;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Mail\Mailer;
use App\Infrastructure\RateLimit\RateLimiter;
use App\Infrastructure\Redis\SharedRedis;
use App\Queries\Views;
use App\Security\Jwt;
use App\Security\OpaqueTokens;
use App\Security\Passwords;
use App\Security\Principal;
use App\Security\Totp;
use App\Support\Iso;
use App\Support\Json;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use RuntimeException;
use stdClass;

/**
 * The auth operations (contracts/openapi/paths/auth.yaml; Express modules/auth/service.ts), check orders step by step.
 * Redis keys and values are the contract's "Shared Redis keys" (R82), JSON written compactly. P61 holder discipline:
 * the DB slot is given back (SlotHolder::release) before Argon2, DaData and other slow work, and taken again for the writes.
 */
final class AuthActions
{
    private const LOCK_AFTER = 5;

    private const LOCK_MINUTES = 15;

    private const CHALLENGE_TTL_SEC = 300;

    private const CHALLENGE_MAX_FAILS = 5;

    private const TOTP_USED_TTL_SEC = 90;

    private const PWRESET_TTL_SEC = 3600;

    public const ROLE_OF_TYPE = [
        'FARM' => 'FARMER', 'PROCESSOR' => 'PROCESSOR', 'LAB' => 'LAB', 'RETAILER' => 'RETAILER',
        'AUTHORITY' => 'INSPECTOR', 'PLATFORM' => 'ADMIN',
    ];

    // ── login (R31) ──────────────────────────────────────────────────────────────────────────────────────────────

    /**
     * R31: 1. the login-ip limit; 2. the body; 3. email lower-cased; 4. unknown → dummy Argon2, INVALID_CREDENTIALS;
     * 5. locked (DB clock) → ACCOUNT_LOCKED without checking the password; 6. wrong password → one UPDATE counting
     * the failure (5 → locked 15 min, counter 0); 7. right → the conditional reset (a lock set meanwhile wins, I1);
     * 8. statuses BLOCKED → INVITED → organization not ACTIVE; 9. a 2FA challenge or the session.
     *
     * @return array{twoFactorRequired: true, challengeId: string}|array{twoFactorRequired: false, session: array<string, mixed>}
     */
    public static function login(?string $ip, mixed $body): array
    {
        RateLimiter::hit('login-ip', $ip ?? 'unknown');
        $input = AuthSchemas::login()->parse($body);
        $email = mb_strtolower($input['email']);
        $u = self::authUser('u.email = ?', $email);
        SlotHolder::release(); // Argon2 next: no slot held (P61)
        if ($u === null) {
            Passwords::dummyVerify($input['password']);
            throw new Problem(401, ProblemCode::INVALID_CREDENTIALS);
        }
        if ($u->is_locked) {
            throw self::locked($u->locked_until);
        }
        if (! Passwords::verify($input['password'], $u->password_hash)) {
            // One statement: concurrent failures never lose a count, and a lock is set exactly once.
            $r = DB::selectOne(
                'UPDATE users SET
                   failed_logins = CASE WHEN failed_logins + 1 >= ? THEN 0 ELSE failed_logins + 1 END,
                   locked_until = CASE WHEN failed_logins + 1 >= ? THEN now() + make_interval(mins => ?) ELSE locked_until END
                 WHERE id = ? AND (locked_until IS NULL OR locked_until <= now())
                 RETURNING locked_until::text AS locked_until, (locked_until IS NOT NULL AND locked_until > now()) AS locked',
                [self::LOCK_AFTER, self::LOCK_AFTER, self::LOCK_MINUTES, $u->id],
            );
            $lockedUntil = $r !== null && $r->locked ? $r->locked_until : null;
            if ($r === null) {
                // Locked by a concurrent attempt in between: report that lock.
                $lockedUntil = self::authUser('u.id = ?', $u->id)?->locked_until;
            }
            if ($lockedUntil !== null) {
                throw self::locked($lockedUntil);
            }
            throw new Problem(401, ProblemCode::INVALID_CREDENTIALS);
        }
        // A burst of wrong passwords may have locked the account while this one was verified: the reset applies only
        // to an unlocked row; otherwise that lock is reported.
        $reset = DB::selectOne(
            'UPDATE users SET failed_logins = 0 WHERE id = ? AND (locked_until IS NULL OR locked_until <= now()) RETURNING id',
            [$u->id],
        );
        if ($reset === null) {
            $again = self::authUser('u.id = ?', $u->id);
            throw self::locked($again->locked_until ?? DB::selectOne('SELECT now()::text AS now')->now);
        }
        $denied = self::statusProblem($u);
        if ($denied !== null) {
            throw $denied;
        }
        if ($u->totp_enabled) {
            $challengeId = (string) Str::uuid();
            SharedRedis::client()->set(
                "2fa:{$challengeId}",
                Json::encode(['userId' => $u->id, 'exp' => time() + self::CHALLENGE_TTL_SEC]),
                ['EX' => self::CHALLENGE_TTL_SEC],
            );

            return ['twoFactorRequired' => true, 'challengeId' => $challengeId];
        }

        return ['twoFactorRequired' => false, 'session' => self::openSession($u->id)];
    }

    // ── 2FA (R35) ────────────────────────────────────────────────────────────────────────────────────────────────

    /**
     * verifyTwoFactor: a single-use challenge, 5 minutes, at most 5 wrong codes. Every attempt reserves one of the 5
     * slots BEFORE its code is checked (EXISTS + INCR + EXPIRE NX in one MULTI); on a right code the step must be
     * unused, then GETDEL decides the winner (a consumed challenge never burns the step), then SET totp-used NX.
     *
     * @return array<string, mixed> the session
     */
    public static function verifyTwoFactor(mixed $body): array
    {
        $input = AuthSchemas::twoFactorVerify()->parse($body);
        $key = "2fa:{$input['challengeId']}";
        $failKey = "2fa-fail:{$input['challengeId']}";
        $expired = fn () => new Problem(401, ProblemCode::TOKEN_EXPIRED, title: 'Two-factor challenge expired');
        $r = SharedRedis::client();
        $challenge = self::keyValue($r->get($key));
        if ($challenge === null) {
            throw $expired();
        }
        $u = self::authUser('u.id = ?', $challenge['userId']);
        SlotHolder::release();
        if ($u === null || ! $u->totp_enabled || $u->totp_secret === null || self::statusProblem($u) !== null) {
            // Blocked, TOTP lost or the organization suspended after the password step.
            $r->del($key, $failKey);
            throw $expired();
        }
        $res = $r->multi()->exists($key)->incr($failKey)->expire($failKey, self::CHALLENGE_TTL_SEC, 'NX')->exec();
        $alive = is_array($res) && (int) $res[0] === 1;
        $attempt = is_array($res) && is_int($res[1]) ? $res[1] : self::CHALLENGE_MAX_FAILS + 1;
        if (! $alive || $attempt > self::CHALLENGE_MAX_FAILS) {
            $r->del($key, $failKey);
            throw $expired();
        }
        $wrong = function () use ($r, $key, $failKey, $attempt): Problem {
            if ($attempt >= self::CHALLENGE_MAX_FAILS) {
                $r->del($key, $failKey);
            }

            return new Problem(401, ProblemCode::INVALID_TWO_FACTOR_CODE, params: ['attemptsLeft' => self::CHALLENGE_MAX_FAILS - $attempt]);
        };
        $step = Totp::verify($u->totp_secret, $input['code'], time());
        if ($step === null || (int) $r->exists(self::totpUsedKey($u->id, $step)) === 1) {
            throw $wrong();
        }
        if ($r->getDel($key) === false) {
            throw $expired();
        }
        $r->del($failKey);
        if (! self::markTotpUsed($u->id, $step)) {
            // The same code won a parallel race for another challenge (replay): this challenge is gone.
            throw new Problem(401, ProblemCode::INVALID_TWO_FACTOR_CODE, params: ['attemptsLeft' => 0]);
        }

        return self::openSession($u->id);
    }

    /**
     * setupTwoFactor — two steps (R29): without `code` a new secret (repeated start replaces it); with `code` TOTP is
     * enabled when the code matches the stored secret; already enabled → 409 INVALID_TRANSITION {from: ENABLED}.
     *
     * @return array<string, mixed>
     */
    public static function setupTwoFactor(Principal $p, mixed $body): array
    {
        $input = AuthSchemas::twoFactorSetup()->parse($body);
        $u = DB::selectOne('SELECT id, email::text AS email, totp_enabled, totp_secret FROM users WHERE id = ? AND deleted_at IS NULL', [$p->userId]);
        if ($u === null) {
            throw new Problem(401, ProblemCode::UNAUTHORIZED);
        }
        $enabled = fn () => new Problem(409, ProblemCode::INVALID_TRANSITION, params: ['from' => 'ENABLED']);
        if ($u->totp_enabled) {
            throw $enabled();
        }
        if (! array_key_exists('code', $input)) {
            $secret = Totp::newSecret();
            $updated = Tx::run(function () use ($u, $secret, $p): bool {
                $n = DB::update('UPDATE users SET totp_secret = ?, updated_at = now() WHERE id = ? AND totp_enabled = false', [$secret, $u->id]);
                if ($n === 0) {
                    return false;
                }
                AuditLog::write($p->userId, 'setupTwoFactor', 'user', $u->id, [
                    'totpSecret' => [$u->totp_secret === null ? null : AuditLog::SECRET, AuditLog::SECRET],
                ]);

                return true;
            });
            if (! $updated) {
                throw $enabled();
            }

            return ['totpEnabled' => false, 'secret' => $secret, 'otpauthUrl' => Totp::otpauthUrl(mb_strtolower($u->email), $secret)];
        }
        $invalidCode = fn () => new Problem(400, ProblemCode::INVALID_TWO_FACTOR_CODE);
        if ($u->totp_secret === null) {
            throw $invalidCode();
        }
        $step = Totp::verify($u->totp_secret, $input['code'], time());
        if ($step === null || (int) SharedRedis::client()->exists(self::totpUsedKey($u->id, $step)) === 1) {
            throw $invalidCode();
        }
        $secret = $u->totp_secret;
        $outcome = Tx::run(function () use ($u, $secret, $p): string {
            $n = DB::update(
                'UPDATE users SET totp_enabled = true, updated_at = now() WHERE id = ? AND totp_enabled = false AND totp_secret = ?',
                [$u->id, $secret],
            );
            if ($n === 0) {
                $now = DB::selectOne('SELECT totp_enabled FROM users WHERE id = ?', [$u->id]);

                return $now?->totp_enabled ? 'enabled' : 'replaced';
            }
            AuditLog::write($p->userId, 'setupTwoFactor', 'user', $u->id, ['totpEnabled' => [false, true]]);

            return 'ok';
        });
        if ($outcome === 'enabled') {
            throw $enabled();
        }
        if ($outcome === 'replaced') {
            throw $invalidCode(); // a parallel first step replaced the secret the code was checked against
        }
        self::markTotpUsed($u->id, $step); // only once TOTP is really enabled; never accepted again

        return ['totpEnabled' => true];
    }

    // ── refresh ──────────────────────────────────────────────────────────────────────────────────────────────────

    public static function accessTokenFor(string $userId): string
    {
        $me = Views::me($userId) ?? throw new RuntimeException("accessTokenFor: user {$userId} vanished");

        return Jwt::issue($userId, $me['organization']['id'], $me['roles'], $me['isOrgAdmin']);
    }

    // ── password reset ───────────────────────────────────────────────────────────────────────────────────────────

    /** forgotPassword — body → the `forgot` limit (lower-cased email) → a letter only if the account exists; 204. */
    public static function forgotPassword(mixed $body): void
    {
        $input = AuthSchemas::forgotPassword()->parse($body);
        $email = mb_strtolower($input['email']);
        RateLimiter::hit('forgot', $email);
        $u = DB::selectOne('SELECT id, email::text AS email, full_name FROM users WHERE email = ? AND deleted_at IS NULL', [$email]);
        if ($u === null) {
            return;
        }
        $token = OpaqueTokens::new();
        SharedRedis::client()->set(
            'pwreset:'.OpaqueTokens::hash($token),
            Json::encode(['userId' => $u->id, 'exp' => time() + self::PWRESET_TTL_SEC]),
            ['EX' => self::PWRESET_TTL_SEC],
        );
        $link = config('agrotrace.public_base_url')."/password/reset/{$token}";
        Mailer::send(mb_strtolower($u->email), 'mail.passwordReset.subject', 'mail.passwordReset.body',
            ['link' => $link, 'fullName' => $u->full_name], 'passwordReset');
    }

    /** resetPassword — the body is validated BEFORE the token is consumed (GETDEL, R92); sessions revoked, lock lifted. */
    public static function resetPassword(mixed $body): void
    {
        $input = AuthSchemas::resetPassword()->parse($body);
        $entry = self::keyValue(self::getDel('pwreset:'.OpaqueTokens::hash($input['token'])));
        if ($entry === null) {
            throw new Problem(400, ProblemCode::TOKEN_EXPIRED);
        }
        $hash = Passwords::hash($input['password']);
        Tx::run(function () use ($entry, $hash): void {
            $now = Tx::now();
            // The contract's lock order: the `refresh:` advisory lock before the users row, as updateUser(BLOCKED)
            // takes them — Express locks the row first, so a reset racing a block can deadlock there (review M5).
            Sessions::lockUser($entry['userId']);
            $n = DB::update(
                'UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ?::timestamptz
                  WHERE id = ? AND deleted_at IS NULL',
                [$hash, $now, $entry['userId']],
            );
            if ($n === 0) {
                throw new Problem(400, ProblemCode::TOKEN_EXPIRED);
            }
            Sessions::revokeAll($entry['userId'], $now);
            AuditLog::write($entry['userId'], 'resetPassword', 'user', $entry['userId'], ['password' => [AuditLog::SECRET, AuditLog::SECRET]]);
        });
    }

    // ── registration (R66) ───────────────────────────────────────────────────────────────────────────────────────

    /**
     * registerOrganization: the schema (INN checksum included) → one 400 with every reference error (`inn` taken,
     * `admin.email` taken, `regionCode` notFound) → DaData (found → PENDING; notFound → `inn notFound`; unavailable →
     * MANUAL_CHECK with the request's name, else `name required`) → one transaction (region FOR KEY SHARE, P23); a
     * parallel duplicate (23505) → "taken".
     *
     * @return array{organizationId: string, status: string}
     */
    public static function registerOrganization(mixed $body): array
    {
        $input = AuthSchemas::registerOrganization()->parse($body);
        $email = mb_strtolower($input['admin']['email']);
        $region = DB::selectOne('SELECT id FROM regions WHERE code = ?', [$input['regionCode']]);
        $innTaken = DB::selectOne('SELECT id FROM organizations WHERE inn = ?', [$input['inn']]);
        $emailTaken = DB::selectOne('SELECT id FROM users WHERE email = ?', [$email]);
        $errors = [];
        if ($innTaken !== null) {
            $errors['inn'] = ['validation.inn.taken'];
        }
        if ($region === null) {
            $errors['regionCode'] = ['validation.notFound'];
        }
        if ($emailTaken !== null) {
            $errors['admin.email'] = ['validation.email.taken'];
        }
        if ($errors !== []) {
            throw Problem::validation($errors);
        }
        SlotHolder::release(); // DaData (up to 3 × 3 s) and Argon2: no slot held (P61)
        $identity = self::registrationIdentity(Dadata::findParty($input['inn']), $input['name'] ?? null);
        $type = $input['type'];
        $trustRating = $type === 'FARM' ? (int) RulesRepo::json('trust-rating')['initial'] : null;
        $role = self::ROLE_OF_TYPE[$type];
        $hash = Passwords::hash($input['admin']['password']);
        try {
            return Tx::run(function () use ($input, $email, $region, $identity, $type, $trustRating, $role, $hash): array {
                if (DB::selectOne('SELECT id FROM regions WHERE id = ? FOR KEY SHARE', [$region->id]) === null) {
                    throw Problem::validation(['regionCode' => ['validation.notFound']]);
                }
                $o = DB::selectOne(
                    'INSERT INTO organizations (type, name, inn, address, region_id, trust_rating, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
                    [$type, $identity['name'], $input['inn'], $identity['address'], $region->id, $trustRating, $identity['status']],
                );
                $u = DB::selectOne(
                    "INSERT INTO users (organization_id, email, password_hash, full_name, is_org_admin, status)
                     VALUES (?, ?, ?, ?, true, 'ACTIVE') RETURNING id",
                    [$o->id, $email, $hash, $input['admin']['fullName']],
                );
                DB::insert('INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?', [$u->id, $role]);
                DB::update('UPDATE organizations SET created_by = ? WHERE id = ?', [$u->id, $o->id]);
                AuditLog::write($u->id, 'registerOrganization', 'organization', $o->id, AuditLog::diff(null, [
                    'name' => $identity['name'],
                    'type' => $type,
                    'inn' => $input['inn'],
                    'address' => $identity['address'],
                    'regionCode' => $input['regionCode'],
                    'status' => $identity['status'],
                    'trustRating' => $trustRating,
                ]));
                AuditLog::write($u->id, 'registerOrganization', 'user', $u->id, AuditLog::diff(null, [
                    'email' => $email,
                    'fullName' => $input['admin']['fullName'],
                    'roles' => [$role],
                    'isOrgAdmin' => true,
                    'status' => 'ACTIVE',
                    'organizationId' => $o->id,
                    'password' => AuditLog::SECRET,
                ]));

                return ['organizationId' => $o->id, 'status' => $identity['status']];
            });
        } catch (QueryException $e) {
            $constraint = self::uniqueViolation($e);
            if ($constraint === 'organizations_inn_key') {
                throw Problem::validation(['inn' => ['validation.inn.taken']]);
            }
            if ($constraint === 'users_email_key') {
                throw Problem::validation(['admin.email' => ['validation.email.taken']]);
            }
            throw $e;
        }
    }

    /** @return array{name: string, address: ?string, status: string} */
    public static function registrationIdentity(DadataResult $party, ?string $requestName): array
    {
        if ($party->status === 'found') {
            return ['name' => (string) $party->name, 'address' => $party->address, 'status' => 'PENDING'];
        }
        if ($party->status === 'notFound') {
            throw Problem::validation(['inn' => ['validation.inn.notFound']]);
        }
        if ($requestName === null) {
            throw Problem::validation(['name' => ['validation.required']]);
        }

        return ['name' => $requestName, 'address' => null, 'status' => 'MANUAL_CHECK'];
    }

    // ── invitations ──────────────────────────────────────────────────────────────────────────────────────────────

    /** acceptInvite — INVITED → ACTIVE; the body is validated BEFORE the token is consumed (R92). */
    public static function acceptInvite(mixed $body): void
    {
        $input = AuthSchemas::acceptInvite()->parse($body);
        $entry = self::keyValue(self::getDel('invite:'.OpaqueTokens::hash($input['token'])));
        if ($entry === null) {
            throw new Problem(400, ProblemCode::TOKEN_EXPIRED);
        }
        $hash = Passwords::hash($input['password']);
        Tx::run(function () use ($entry, $input, $hash): void {
            $u = DB::selectOne('SELECT id, full_name, status FROM users WHERE id = ? AND deleted_at IS NULL FOR NO KEY UPDATE', [$entry['userId']]);
            if ($u === null || $u->status !== 'INVITED') {
                throw new Problem(400, ProblemCode::TOKEN_EXPIRED);
            }
            DB::update(
                "UPDATE users SET full_name = ?, password_hash = ?, status = 'ACTIVE', failed_logins = 0, locked_until = NULL,
                        updated_at = now() WHERE id = ?",
                [$input['fullName'], $hash, $u->id],
            );
            AuditLog::write($u->id, 'acceptInvite', 'user', $u->id, [
                ...AuditLog::diff(['fullName' => $u->full_name, 'status' => $u->status], ['fullName' => $input['fullName'], 'status' => 'ACTIVE']),
                'password' => [AuditLog::SECRET, AuditLog::SECRET],
            ]);
        });
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

    /**
     * Access token + a new refresh token + Me of an active user.
     *
     * @return array<string, mixed>
     */
    public static function openSession(string $userId): array
    {
        $me = Views::me($userId) ?? throw new RuntimeException("openSession: user {$userId} vanished");
        [, $token] = Sessions::create($userId);

        return [
            'accessToken' => Jwt::issue($userId, $me['organization']['id'], $me['roles'], $me['isOrgAdmin']),
            'expiresIn' => Jwt::TTL_SEC,
            'refreshToken' => $token,
            'user' => $me,
        ];
    }

    private static function authUser(string $where, string $value): ?stdClass
    {
        return DB::selectOne(
            "SELECT u.id, u.email::text AS email, u.full_name, u.password_hash, u.status, u.failed_logins,
                    u.locked_until::text AS locked_until, u.totp_enabled, u.totp_secret, o.status AS org_status,
                    (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked,
                    o.deleted_at IS NOT NULL AS org_deleted
               FROM users u JOIN organizations o ON o.id = u.organization_id
              WHERE u.deleted_at IS NULL AND {$where}",
            [$value],
        );
    }

    /** R31 step 8: the 403 reason after a correct password (and before 2FA). */
    private static function statusProblem(stdClass $u): ?Problem
    {
        $forbidden = fn (string $reason) => new Problem(403, ProblemCode::FORBIDDEN, params: ['reason' => $reason]);
        if ($u->status === 'BLOCKED') {
            return $forbidden('USER_BLOCKED');
        }
        if ($u->status === 'INVITED') {
            return $forbidden('USER_INVITED');
        }
        if ($u->org_status !== 'ACTIVE' || $u->org_deleted) {
            return $forbidden('ORGANIZATION_NOT_ACTIVE');
        }

        return null;
    }

    private static function locked(?string $lockedUntil): Problem
    {
        return new Problem(401, ProblemCode::ACCOUNT_LOCKED, params: ['lockedUntil' => Iso::fromPg($lockedUntil)]);
    }

    private static function totpUsedKey(string $userId, int $step): string
    {
        return "totp-used:{$userId}:{$step}";
    }

    /** SET totp-used NX EX 90; false — it already was (a parallel replay won). */
    private static function markTotpUsed(string $userId, int $step): bool
    {
        return SharedRedis::client()->set(self::totpUsedKey($userId, $step), '1', ['NX', 'EX' => self::TOTP_USED_TTL_SEC]) === true;
    }

    private static function getDel(string $key): ?string
    {
        $v = SharedRedis::client()->getDel($key);

        return is_string($v) ? $v : null;
    }

    /**
     * `{"userId", "exp"}` of pwreset/invite/2fa keys (R82); null when absent, malformed or past `exp`.
     *
     * @return array{userId: string, exp: int|float}|null
     */
    private static function keyValue(mixed $raw): ?array
    {
        if (! is_string($raw)) {
            return null;
        }
        try {
            $v = Json::decode($raw);
        } catch (\JsonException) {
            return null;
        }
        if (! $v instanceof stdClass || ! is_string($v->userId ?? null) || ! (is_int($v->exp ?? null) || is_float($v->exp ?? null)) || $v->exp < time()) {
            return null;
        }

        return ['userId' => $v->userId, 'exp' => $v->exp];
    }

    /** The constraint of a 23505 unique violation, or null. */
    public static function uniqueViolation(QueryException $e): ?string
    {
        if (($e->errorInfo[0] ?? null) !== '23505') {
            return null;
        }
        $message = (string) ($e->errorInfo[2] ?? $e->getMessage());
        foreach (['organizations_inn_key', 'users_email_key'] as $name) {
            if (str_contains($message, '"'.$name.'"')) {
                return $name;
            }
        }

        return null;
    }
}
