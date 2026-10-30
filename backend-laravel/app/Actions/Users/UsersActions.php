<?php

namespace App\Actions\Users;

use App\Actions\Auth\AuthActions;
use App\Actions\Auth\Sessions;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\ProfileSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Mail\Mailer;
use App\Infrastructure\Redis\SharedRedis;
use App\Queries\Views;
use App\Security\OpaqueTokens;
use App\Security\Principal;
use App\Support\Json;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * Users (contracts/openapi/paths/users.yaml, FR-IAM-02; Express modules/users/service.ts): a head manages the own
 * organization's employees, ADMIN every user; a user outside that scope is invisible (404). Order (info.description):
 * 401 → 403 → 400 schema → 404 → 409 INVALID_TRANSITION → 400 by references.
 */
final class UsersActions
{
    private const INVITE_TTL_SEC = 7 * 24 * 3600;

    private const STATUSES = ['INVITED', 'ACTIVE', 'BLOCKED'];

    /**
     * listUsers — the own organization for a head, everybody (organizationId filter) for ADMIN (R51).
     *
     * @return array<string, mixed>
     */
    public static function list(Principal $p, QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(['fullName', 'email', 'createdAt'], 'fullName,asc');
        $text = $q->q();
        $organizationId = $q->uuid('organizationId');
        if ($q->has('organizationId') && ! $p->isAdmin()) {
            $q->errors['organizationId'] = ['validation.organizationId.notAllowed'];
            $organizationId = null;
        }
        $status = $q->enum('status', self::STATUSES);
        $role = $q->enum('role', Principal::ROLES);
        $q->done();

        $where = ['u.deleted_at IS NULL'];
        $bindings = [];
        $orgId = $p->isAdmin() ? $organizationId : $p->orgId;
        if ($orgId !== null) {
            $where[] = 'u.organization_id = ?';
            $bindings[] = $orgId;
        }
        if ($status !== null) {
            $where[] = 'u.status = ?';
            $bindings[] = $status;
        }
        if ($role !== null) {
            $where[] = 'EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = ?)';
            $bindings[] = $role;
        }
        if ($text !== null) {
            // Substring, case-insensitive; `%`, `_`, `\` are ordinary characters (no LIKE).
            $where[] = '(position(lower(?) in lower(u.full_name)) > 0 OR position(lower(?) in lower(u.email::text)) > 0)';
            array_push($bindings, $text, $text);
        }
        $cond = implode(' AND ', $where);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM users u WHERE {$cond}", $bindings)->total;
        $order = ['fullName' => 'u.full_name COLLATE "C"', 'email' => 'u.email::text COLLATE "C"', 'createdAt' => 'u.created_at'][$sort['field']];
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $rows = DB::select("SELECT u.id FROM users u WHERE {$cond} ORDER BY {$order} {$dir} NULLS LAST, u.id::text COLLATE \"C\"
            LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]);

        return ['items' => Views::users(array_map(fn ($r) => $r->id, $rows)), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /**
     * inviteUser — an INVITED user + `invite:{sha256hex(token)}` (7 days, R82, written before the row) + the letter.
     *
     * @return array<string, mixed>
     */
    public static function invite(Principal $p, mixed $body): array
    {
        $input = ProfileSchemas::userInvite()->parse($body);
        $email = mb_strtolower($input['email']);
        $errors = [];
        $orgId = $p->orgId;
        if (array_key_exists('organizationId', $input)) {
            if ($p->isAdmin()) {
                $orgId = strtolower($input['organizationId']);
            } else {
                $errors['organizationId'] = ['validation.organizationId.notAllowed'];
            }
        }
        $org = DB::selectOne('SELECT id, name, type FROM organizations WHERE id = ? AND deleted_at IS NULL', [$orgId]);
        $taken = DB::selectOne('SELECT id FROM users WHERE email = ?', [$email]);
        if ($taken !== null) {
            $errors['email'] = ['validation.email.taken'];
        }
        if ($org === null) {
            $errors['organizationId'] = ['validation.notFound'];
        } elseif (! self::rolesFitType($input['roles'], $org->type) || (in_array('ADMIN', $input['roles'], true) && ! $p->isAdmin())) {
            $errors['roles'] = ['validation.notAllowed'];
        }
        if ($errors !== []) {
            throw Problem::validation($errors);
        }
        $userId = (string) Str::uuid();
        $token = OpaqueTokens::new();
        // Written before the row: a key whose user never got committed is harmless (acceptInvite → TOKEN_EXPIRED).
        SharedRedis::client()->set(
            'invite:'.OpaqueTokens::hash($token),
            Json::encode(['userId' => $userId, 'exp' => time() + self::INVITE_TTL_SEC]),
            ['EX' => self::INVITE_TTL_SEC],
        );
        $roles = $input['roles'];
        try {
            Tx::run(function () use ($p, $input, $email, $org, $userId, $roles): void {
                // No password until the invitation is accepted: '!' is no PHC hash and never verifies.
                DB::insert(
                    "INSERT INTO users (id, organization_id, email, password_hash, full_name, is_org_admin, status, created_by)
                     VALUES (?, ?, ?, '!', ?, ?, 'INVITED', ?)",
                    [$userId, $org->id, $email, $input['fullName'], $input['isOrgAdmin'], $p->userId],
                );
                self::insertRoles($userId, $roles);
                AuditLog::write($p->userId, 'inviteUser', 'user', $userId, AuditLog::diff(null, [
                    'email' => $email,
                    'fullName' => $input['fullName'],
                    'roles' => $roles,
                    'isOrgAdmin' => $input['isOrgAdmin'],
                    'status' => 'INVITED',
                    'organizationId' => $org->id,
                ]));
            });
        } catch (QueryException $e) {
            if (AuthActions::uniqueViolation($e) === 'users_email_key') {
                throw Problem::validation(['email' => ['validation.email.taken']]);
            }
            throw $e;
        }
        $link = config('agrotrace.public_base_url')."/invite/{$token}";
        Mailer::send($email, 'mail.invite.subject', 'mail.invite.body', ['organizationName' => $org->name, 'link' => $link], 'invite');

        return self::view($userId);
    }

    /**
     * updateUser — roles, head flag, status ACTIVE ↔ BLOCKED (blocking revokes refresh tokens), R37.
     *
     * @return array<string, mixed>
     */
    public static function update(Principal $p, string $id, mixed $body): array
    {
        $input = ProfileSchemas::userPatch()->parse($body);
        Tx::run(function () use ($p, $id, $input): void {
            // P12: the per-user refresh lock comes before any row lock of a transaction that revokes tokens.
            if (($input['status'] ?? null) === 'BLOCKED') {
                Sessions::lockUser($id);
            }
            $u = DB::selectOne(
                'SELECT u.id, u.organization_id, u.status, u.is_org_admin, o.type AS org_type
                   FROM users u JOIN organizations o ON o.id = u.organization_id
                  WHERE u.id = ? AND u.deleted_at IS NULL FOR NO KEY UPDATE OF u',
                [$id],
            );
            if ($u === null || (! $p->isAdmin() && $u->organization_id !== $p->orgId)) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            if (array_key_exists('status', $input) && $u->status === 'INVITED') {
                throw new Problem(409, ProblemCode::INVALID_TRANSITION, params: ['from' => 'INVITED', 'to' => $input['status']]);
            }
            $errors = [];
            if ($u->id === $p->userId) {
                foreach (['roles', 'isOrgAdmin', 'status'] as $field) {
                    if (array_key_exists($field, $input)) {
                        $errors[$field] = ['validation.notAllowed'];
                    }
                }
            }
            if (array_key_exists('roles', $input) && ! isset($errors['roles']) && ! self::rolesFitType($input['roles'], $u->org_type)) {
                $errors['roles'] = ['validation.notAllowed'];
            }
            if ($errors !== []) {
                throw Problem::validation($errors);
            }
            $beforeRoles = array_map(fn ($r) => $r->code, DB::select(
                'SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.id', [$id]));
            $before = ['roles' => $beforeRoles, 'isOrgAdmin' => (bool) $u->is_org_admin, 'status' => $u->status];
            $after = [
                'roles' => array_key_exists('roles', $input) ? array_values(array_filter(Principal::ROLES, fn ($r) => in_array($r, $input['roles'], true))) : $beforeRoles,
                'isOrgAdmin' => $input['isOrgAdmin'] ?? (bool) $u->is_org_admin,
                'status' => $input['status'] ?? $u->status,
            ];
            $diff = AuditLog::diff($before, $after);
            if ($diff === []) {
                return;
            }
            $now = Tx::now();
            if (isset($diff['roles'])) {
                DB::delete('DELETE FROM user_roles WHERE user_id = ?', [$id]);
                self::insertRoles($id, $after['roles']);
            }
            DB::update('UPDATE users SET is_org_admin = ?, status = ?, updated_at = ?::timestamptz WHERE id = ?',
                [$after['isOrgAdmin'], $after['status'], $now, $id]);
            if (isset($diff['status']) && $after['status'] === 'BLOCKED') {
                Sessions::revokeAll($id, $now);
            }
            AuditLog::write($p->userId, 'updateUser', 'user', $id, $diff);
        });

        return self::view($id);
    }

    /**
     * Roles are valid for an organization of `type` only as exactly its one role (R37).
     *
     * @param  list<string>  $roles
     */
    public static function rolesFitType(array $roles, string $type): bool
    {
        return count($roles) === 1 && $roles[0] === (AuthActions::ROLE_OF_TYPE[$type] ?? null);
    }

    /** @param  list<string>  $roles */
    private static function insertRoles(string $userId, array $roles): void
    {
        if ($roles === []) {
            return;
        }
        $marks = implode(',', array_fill(0, count($roles), '?'));
        DB::insert("INSERT INTO user_roles (user_id, role_id) SELECT ?::uuid, id FROM roles WHERE code IN ({$marks})", [$userId, ...$roles]);
    }

    /** @return array<string, mixed> */
    private static function view(string $id): array
    {
        return Views::users([$id])[0] ?? throw new RuntimeException("user {$id} vanished");
    }
}
