/**
 * Auth operations (contracts/openapi/paths/auth.yaml). Check orders are the contract's, step by step; Redis keys and
 * their values are the contract's "Shared Redis keys" (R82). Transactions touch only the database (withTx may re-run
 * them); Redis writes and mail happen outside them.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  AcceptInviteRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RegisterOrganizationRequestSchema,
  ResetPasswordRequestSchema,
  TwoFactorSetupRequestSchema,
  TwoFactorVerifyRequestSchema,
} from '@agrotrace/validation';
import { createT } from '@agrotrace/i18n';
import trustRating from '../../../../contracts/rules/trust-rating.json' with { type: 'json' };
import type { Container } from '../../container.js';
import { withTx } from '../../db/tx.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import { hitRateLimit } from '../../http/rate-limit.js';
import { issueAccessToken, ACCESS_TTL_SEC, type Principal, type RoleCode } from '../../security/jwt.js';
import { dummyVerify, hashPassword, verifyPassword } from '../../security/passwords.js';
import { newOpaqueToken, sha256hex } from '../../security/tokens.js';
import { generateTotpSecret, matchStep, otpauthUrl } from '../../security/totp.js';
import { auditDiff, auditService, SECRET } from '../audit/service.js';
import { loadMe, type MeView } from '../me/view.js';
import {
  createRefreshToken,
  revokeAllRefreshTokens,
  rotateRefreshToken,
  type RefreshOutcome,
} from './sessions.js';

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const CHALLENGE_TTL_SEC = 300;
const CHALLENGE_MAX_FAILS = 5;
const TOTP_USED_TTL_SEC = 90;
const PWRESET_TTL_SEC = 3600;

const ru = createT('ru');
const iso = (d: Date) => d.toISOString();
const nowSec = () => Math.floor(Date.now() / 1000);

const ROLE_OF_TYPE: Record<string, RoleCode> = {
  FARM: 'FARMER',
  PROCESSOR: 'PROCESSOR',
  LAB: 'LAB',
  RETAILER: 'RETAILER',
  AUTHORITY: 'INSPECTOR',
};

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: MeView;
}

export type LoginResult =
  ({ twoFactorRequired: false } & Session) | { twoFactorRequired: true; challengeId: string };

const forbidden = (reason: string) => new AppProblem(403, 'FORBIDDEN', { params: { reason } });
const tokenExpired = (status: 400 | 401, title?: string) =>
  new AppProblem(status, 'TOKEN_EXPIRED', title ? { title } : {});

/** `{"userId", "exp"}` values of pwreset/invite/2fa keys (R82). */
function parseKeyValue(raw: string | null): { userId: string; exp: number } | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { userId?: unknown; exp?: unknown };
    if (typeof v.userId !== 'string' || typeof v.exp !== 'number' || v.exp < nowSec()) return null;
    return { userId: v.userId, exp: v.exp };
  } catch {
    return null;
  }
}

export function authService(c: Container) {
  const { db, redis } = c;

  /** Access token + a new refresh token + Me for an active user. */
  async function openSession(userId: string): Promise<Session> {
    const user = await loadMe(db, c.fileUrls, userId);
    if (!user) throw new Error(`openSession: user ${userId} vanished`);
    const principal: Principal = {
      userId,
      orgId: user.organization.id,
      roles: user.roles,
      orgAdmin: user.isOrgAdmin,
    };
    const { token } = await createRefreshToken(db, userId);
    return {
      accessToken: await issueAccessToken(c.config.JWT_SECRET, principal),
      expiresIn: ACCESS_TTL_SEC,
      refreshToken: token,
      user,
    };
  }

  async function loadAuthUser(where: { email: string } | { id: string }) {
    let q = db
      .selectFrom('users as u')
      .innerJoin('organizations as o', 'o.id', 'u.organization_id')
      .select([
        'u.id',
        'u.email',
        'u.full_name',
        'u.password_hash',
        'u.status',
        'u.failed_logins',
        'u.locked_until',
        'u.totp_enabled',
        'u.totp_secret',
        'o.status as org_status',
        'o.deleted_at as org_deleted_at',
      ])
      .where('u.deleted_at', 'is', null);
    q = 'email' in where ? q.where('u.email', '=', where.email) : q.where('u.id', '=', where.id);
    return q.executeTakeFirst();
  }

  /** R31 step 5: 403 reason after a correct password (and before 2FA). */
  function statusProblem(u: {
    status: string;
    org_status: string;
    org_deleted_at: Date | null;
  }): AppProblem | null {
    if (u.status === 'BLOCKED') return forbidden('USER_BLOCKED');
    if (u.status === 'INVITED') return forbidden('USER_INVITED');
    if (u.org_status !== 'ACTIVE' || u.org_deleted_at !== null) return forbidden('ORGANIZATION_NOT_ACTIVE');
    return null;
  }

  /** Accepts a TOTP code once: the step must match (±1) and not have been accepted for the user before (R35). */
  async function acceptTotp(userId: string, secret: string, code: string): Promise<boolean> {
    const step = matchStep(secret, code);
    if (step === null) return false;
    const set = await redis.set(`totp-used:${userId}:${step}`, '1', 'EX', TOTP_USED_TTL_SEC, 'NX');
    return set === 'OK';
  }

  return {
    /** login — R31, steps 1–6. */
    async login(ip: string | null, body: unknown): Promise<LoginResult> {
      await hitRateLimit(redis, 'login-ip', ip ?? 'unknown');
      const input = LoginRequestSchema.parse(body);
      const email = input.email.toLowerCase();
      const u = await loadAuthUser({ email });
      if (!u) {
        await dummyVerify(input.password);
        throw new AppProblem(401, 'INVALID_CREDENTIALS');
      }
      if (u.locked_until && u.locked_until.getTime() > Date.now())
        throw new AppProblem(401, 'ACCOUNT_LOCKED', { params: { lockedUntil: iso(u.locked_until) } });

      if (!(await verifyPassword(u.password_hash, input.password))) {
        // One statement: concurrent failures never lose a count, and a lock is set exactly once.
        const r = await sql<{ locked_until: Date | null; locked: boolean }>`
          UPDATE users SET
            failed_logins = CASE WHEN failed_logins + 1 >= ${LOCK_AFTER} THEN 0 ELSE failed_logins + 1 END,
            locked_until = CASE WHEN failed_logins + 1 >= ${LOCK_AFTER}
                                THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE locked_until END
           WHERE id = ${u.id} AND (locked_until IS NULL OR locked_until <= now())
          RETURNING locked_until, (locked_until IS NOT NULL AND locked_until > now()) AS locked
        `.execute(db);
        let lockedUntil = r.rows[0]?.locked ? r.rows[0].locked_until : null;
        if (!r.rows[0]) {
          // Locked by a concurrent attempt in between: report that lock.
          const again = await loadAuthUser({ id: u.id });
          lockedUntil = again?.locked_until ?? null;
        }
        if (lockedUntil)
          throw new AppProblem(401, 'ACCOUNT_LOCKED', { params: { lockedUntil: iso(lockedUntil) } });
        throw new AppProblem(401, 'INVALID_CREDENTIALS');
      }

      if (u.failed_logins > 0)
        await db.updateTable('users').set({ failed_logins: 0 }).where('id', '=', u.id).execute();
      const denied = statusProblem(u);
      if (denied) throw denied;

      if (u.totp_enabled) {
        const challengeId = randomUUID();
        await redis.set(
          `2fa:${challengeId}`,
          JSON.stringify({ userId: u.id, exp: nowSec() + CHALLENGE_TTL_SEC }),
          'EX',
          CHALLENGE_TTL_SEC,
        );
        return { twoFactorRequired: true, challengeId };
      }
      return { twoFactorRequired: false, ...(await openSession(u.id)) };
    },

    /** verifyTwoFactor — R35: single-use challenge, 5 minutes, at most 5 wrong codes. */
    async verifyTwoFactor(body: unknown): Promise<Session> {
      const input = TwoFactorVerifyRequestSchema.parse(body);
      const key = `2fa:${input.challengeId}`;
      const failKey = `2fa-fail:${input.challengeId}`;
      const expired = () => tokenExpired(401, 'Two-factor challenge expired');
      const challenge = parseKeyValue(await redis.get(key));
      if (!challenge) throw expired();
      const u = await loadAuthUser({ id: challenge.userId });
      if (!u || !u.totp_enabled || !u.totp_secret || statusProblem(u)) {
        // The user was blocked, lost TOTP or the organization was suspended after the password step.
        await redis.del(key, failKey);
        throw expired();
      }
      if (!(await acceptTotp(u.id, u.totp_secret, input.code))) {
        const res = await redis.multi().incr(failKey).expire(failKey, CHALLENGE_TTL_SEC, 'NX').exec();
        const fails = Number(res?.[0]?.[1] ?? CHALLENGE_MAX_FAILS);
        if (fails >= CHALLENGE_MAX_FAILS) await redis.del(key, failKey);
        throw new AppProblem(401, 'INVALID_TWO_FACTOR_CODE', {
          params: { attemptsLeft: Math.max(0, CHALLENGE_MAX_FAILS - fails) },
        });
      }
      // Single use: whoever deletes the challenge first wins (a parallel verify or the 5th wrong code).
      if ((await redis.getdel(key)) === null) throw expired();
      await redis.del(failKey);
      return openSession(u.id);
    },

    /** setupTwoFactor — two steps (R29), TOTP parameters R35. */
    async setupTwoFactor(principal: Principal, body: unknown) {
      const input = TwoFactorSetupRequestSchema.parse(body);
      const u = await db
        .selectFrom('users')
        .select(['id', 'email', 'totp_enabled', 'totp_secret'])
        .where('id', '=', principal.userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!u) throw new AppProblem(401, 'UNAUTHORIZED');
      const enabled = () => new AppProblem(409, 'INVALID_TRANSITION', { params: { from: 'ENABLED' } });
      if (u.totp_enabled) throw enabled();

      if (input.code === undefined) {
        const secret = generateTotpSecret();
        const updated = await withTx(db, async (tx) => {
          const r = await tx
            .updateTable('users')
            .set({ totp_secret: secret, updated_at: new Date() })
            .where('id', '=', u.id)
            .where('totp_enabled', '=', false)
            .executeTakeFirst();
          if (r.numUpdatedRows === 0n) return false;
          await auditService.record(tx, {
            actorId: principal.userId,
            action: 'setupTwoFactor',
            entityType: 'user',
            entityId: u.id,
            diff: { totpSecret: [u.totp_secret === null ? null : SECRET, SECRET] },
          });
          return true;
        });
        if (!updated) throw enabled();
        return { totpEnabled: false as const, secret, otpauthUrl: otpauthUrl(u.email.toLowerCase(), secret) };
      }

      const invalidCode = () => new AppProblem(400, 'INVALID_TWO_FACTOR_CODE');
      if (!u.totp_secret) throw invalidCode();
      if (!(await acceptTotp(u.id, u.totp_secret, input.code))) throw invalidCode();
      const secret = u.totp_secret;
      const outcome = await withTx(db, async (tx) => {
        const r = await tx
          .updateTable('users')
          .set({ totp_enabled: true, updated_at: new Date() })
          .where('id', '=', u.id)
          .where('totp_enabled', '=', false)
          .where('totp_secret', '=', secret)
          .executeTakeFirst();
        if (r.numUpdatedRows === 0n) {
          const now = await tx
            .selectFrom('users')
            .select('totp_enabled')
            .where('id', '=', u.id)
            .executeTakeFirst();
          return now?.totp_enabled ? 'enabled' : 'replaced';
        }
        await auditService.record(tx, {
          actorId: principal.userId,
          action: 'setupTwoFactor',
          entityType: 'user',
          entityId: u.id,
          diff: { totpEnabled: [false, true] },
        });
        return 'ok';
      });
      if (outcome === 'enabled') throw enabled();
      // A parallel first step replaced the secret the code was checked against.
      if (outcome === 'replaced') throw invalidCode();
      return { totpEnabled: true as const };
    },

    refresh: (token: string | null): Promise<RefreshOutcome> => rotateRefreshToken(db, token),

    async accessTokenFor(userId: string): Promise<string> {
      const me = await loadMe(db, c.fileUrls, userId);
      if (!me) throw new Error(`accessTokenFor: user ${userId} vanished`);
      return issueAccessToken(c.config.JWT_SECRET, {
        userId,
        orgId: me.organization.id,
        roles: me.roles,
        orgAdmin: me.isOrgAdmin,
      });
    },

    /** forgotPassword — always 204 for a valid body under the limit; the letter only if the account exists. */
    async forgotPassword(body: unknown): Promise<void> {
      const input = ForgotPasswordRequestSchema.parse(body);
      const email = input.email.toLowerCase();
      await hitRateLimit(redis, 'forgot', email);
      const u = await db
        .selectFrom('users')
        .select(['id', 'email', 'full_name'])
        .where('email', '=', email)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!u) return;
      const token = newOpaqueToken();
      await redis.set(
        `pwreset:${sha256hex(token)}`,
        JSON.stringify({ userId: u.id, exp: nowSec() + PWRESET_TTL_SEC }),
        'EX',
        PWRESET_TTL_SEC,
      );
      const link = `${c.config.PUBLIC_BASE_URL}/password/reset/${token}`;
      void c.mailer.send({
        kind: 'passwordReset',
        to: u.email.toLowerCase(),
        subject: ru('mail.passwordReset.subject'),
        text: ru('mail.passwordReset.body', { link, fullName: u.full_name }),
      });
    },

    /** resetPassword — the body is validated BEFORE the token is consumed (GETDEL, R82/R92). */
    async resetPassword(body: unknown): Promise<void> {
      const input = ResetPasswordRequestSchema.parse(body);
      const entry = parseKeyValue(await redis.getdel(`pwreset:${sha256hex(input.token)}`));
      if (!entry) throw tokenExpired(400);
      const hash = await hashPassword(input.password);
      await withTx(db, async (tx) => {
        const now = new Date();
        const r = await tx
          .updateTable('users')
          .set({ password_hash: hash, failed_logins: 0, locked_until: null, updated_at: now })
          .where('id', '=', entry.userId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (r.numUpdatedRows === 0n) throw tokenExpired(400);
        await revokeAllRefreshTokens(tx, entry.userId, now);
        await auditService.record(tx, {
          actorId: entry.userId,
          action: 'resetPassword',
          entityType: 'user',
          entityId: entry.userId,
          diff: { password: [SECRET, SECRET] },
        });
      });
    },

    /** registerOrganization — FR-IAM-01; DaData never blocks (MANUAL_CHECK). */
    async registerOrganization(
      body: unknown,
    ): Promise<{ organizationId: string; status: 'PENDING' | 'MANUAL_CHECK' }> {
      const input = RegisterOrganizationRequestSchema.parse(body);
      const email = input.admin.email.toLowerCase();
      const errors: Record<string, string[]> = {};
      const [region, innTaken, emailTaken] = await Promise.all([
        db.selectFrom('regions').select('id').where('code', '=', input.regionCode).executeTakeFirst(),
        db.selectFrom('organizations').select('id').where('inn', '=', input.inn).executeTakeFirst(),
        db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst(),
      ]);
      if (innTaken) errors.inn = ['validation.inn.taken'];
      if (!region) errors.regionCode = ['validation.notFound'];
      if (emailTaken) errors['admin.email'] = ['validation.email.taken'];
      if (Object.keys(errors).length > 0) throw validationProblem(errors);

      const party = await c.dadata.findParty(input.inn);
      if (party.status === 'notFound') throw validationProblem({ inn: ['validation.inn.notFound'] });
      if (party.status === 'unavailable' && input.name === undefined)
        throw validationProblem({ name: ['validation.required'] });
      const org = {
        type: input.type,
        name: party.status === 'found' ? party.name : input.name!,
        inn: input.inn,
        address: party.status === 'found' ? party.address : null,
        status: party.status === 'found' ? ('PENDING' as const) : ('MANUAL_CHECK' as const),
        trustRating: input.type === 'FARM' ? trustRating.initial : null,
      };
      const role = ROLE_OF_TYPE[input.type]!;
      const hash = await hashPassword(input.admin.password);

      try {
        return await withTx(db, async (tx) => {
          const o = await tx
            .insertInto('organizations')
            .values({
              type: org.type,
              name: org.name,
              inn: org.inn,
              address: org.address,
              region_id: region!.id,
              trust_rating: org.trustRating,
              status: org.status,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const u = await tx
            .insertInto('users')
            .values({
              organization_id: o.id,
              email,
              password_hash: hash,
              full_name: input.admin.fullName,
              is_org_admin: true,
              status: 'ACTIVE',
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await tx
            .insertInto('user_roles')
            .values({
              user_id: u.id,
              role_id: tx.selectFrom('roles').select('id').where('code', '=', role),
            })
            .execute();
          await tx.updateTable('organizations').set({ created_by: u.id }).where('id', '=', o.id).execute();
          await auditService.record(tx, {
            actorId: u.id,
            action: 'registerOrganization',
            entityType: 'organization',
            entityId: o.id,
            diff: auditDiff(null, {
              name: org.name,
              type: org.type,
              inn: org.inn,
              address: org.address,
              regionCode: input.regionCode,
              status: org.status,
              trustRating: org.trustRating,
            }),
          });
          await auditService.record(tx, {
            actorId: u.id,
            action: 'registerOrganization',
            entityType: 'user',
            entityId: u.id,
            diff: auditDiff(null, {
              email,
              fullName: input.admin.fullName,
              roles: [role],
              isOrgAdmin: true,
              status: 'ACTIVE',
              organizationId: o.id,
              password: SECRET,
            }),
          });
          return { organizationId: o.id, status: org.status };
        });
      } catch (err) {
        // A parallel registration with the same INN or email won the race (unique constraints).
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'organizations_inn_key')
          throw validationProblem({ inn: ['validation.inn.taken'] });
        if (e.code === '23505' && e.constraint === 'users_email_key')
          throw validationProblem({ 'admin.email': ['validation.email.taken'] });
        throw err;
      }
    },

    /** acceptInvite — INVITED → ACTIVE; the body is validated BEFORE the token is consumed (R92). */
    async acceptInvite(body: unknown): Promise<void> {
      const input = AcceptInviteRequestSchema.parse(body);
      const entry = parseKeyValue(await redis.getdel(`invite:${sha256hex(input.token)}`));
      if (!entry) throw tokenExpired(400);
      const hash = await hashPassword(input.password);
      await withTx(db, async (tx) => {
        const u = await tx
          .selectFrom('users')
          .select(['id', 'full_name', 'status'])
          .where('id', '=', entry.userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!u || u.status !== 'INVITED') throw tokenExpired(400);
        await tx
          .updateTable('users')
          .set({
            full_name: input.fullName,
            password_hash: hash,
            status: 'ACTIVE',
            failed_logins: 0,
            locked_until: null,
            updated_at: new Date(),
          })
          .where('id', '=', u.id)
          .execute();
        await auditService.record(tx, {
          actorId: u.id,
          action: 'acceptInvite',
          entityType: 'user',
          entityId: u.id,
          diff: {
            ...auditDiff(
              { fullName: u.full_name, status: u.status },
              { fullName: input.fullName, status: 'ACTIVE' },
            ),
            password: [SECRET, SECRET],
          },
        });
      });
    },
  };
}

export type AuthService = ReturnType<typeof authService>;
