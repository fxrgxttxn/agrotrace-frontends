import {
  AcceptInviteRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RegisterOrganizationRequestSchema,
  ResetPasswordRequestSchema,
  TwoFactorSetupRequestSchema,
  TwoFactorVerifyRequestSchema,
} from '@agrotrace/validation';
import tr from '../../../../contracts/rules/trust-rating.json' with { type: 'json' };
import { parseBody } from '../http/body.js';
import { json, noContent, problemResponse, type Ctx, type Handler } from '../http/context.js';
import { ApiError, forbidden, validation } from '../http/problem.js';
import { CLIENT_IP, hitRateLimit } from '../domain/limits.js';
import {
  ACCESS_TTL_SEC,
  issueAccessToken,
  matchTotpStep,
  newTotpSecret,
  otpauthUrl,
} from '../domain/tokens.js';
import { opaqueToken, randomUuid, sha256hex } from '../lib/crypto.js';
import { iso } from '../lib/time.js';
import type { Mock } from '../runtime.js';
import type { RoleCode, UserRow } from '../store/types.js';
import { meView } from '../views/users.js';

const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
const CHALLENGE_TTL_SEC = 300;
const CHALLENGE_MAX_FAILS = 5;
const TOTP_USED_TTL_SEC = 90;
const PWRESET_TTL_SEC = 3600;
export const INVITE_TTL_SEC = 7 * 24 * 3600;
const REFRESH_TTL_SEC = 14 * 24 * 3600;
const ROTATION_GRACE_MS = 10_000;

const COOKIE_ATTRS = 'Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict';
const setCookie = (token: string): string => `at_refresh=${token}; Max-Age=${REFRESH_TTL_SEC}; ${COOKIE_ATTRS}`;
const CLEAR_COOKIE = `at_refresh=; Max-Age=0; ${COOKIE_ATTRS}`;
const NO_STORE = { 'Cache-Control': 'no-store' };

export const ROLE_OF_TYPE: Record<string, RoleCode> = {
  FARM: 'FARMER',
  PROCESSOR: 'PROCESSOR',
  LAB: 'LAB',
  RETAILER: 'RETAILER',
  AUTHORITY: 'INSPECTOR',
  PLATFORM: 'ADMIN',
};

function keyValue(m: Mock, raw: unknown): { userId: string; exp: number } | null {
  const v = raw as { userId?: unknown; exp?: unknown } | undefined;
  if (!v || typeof v.userId !== 'string' || typeof v.exp !== 'number') return null;
  return v.exp * 1000 < m.store.now() ? null : { userId: v.userId, exp: v.exp };
}

const liveUser = (m: Mock, id: string): UserRow | undefined => {
  const u = m.store.get('users', id);
  return u && u.deleted_at === null ? u : undefined;
};

function statusProblem(m: Mock, u: UserRow): ApiError | null {
  if (u.status === 'BLOCKED') return forbidden({ reason: 'USER_BLOCKED' });
  if (u.status === 'INVITED') return forbidden({ reason: 'USER_INVITED' });
  const org = m.store.must('organizations', u.organization_id);
  if (org.status !== 'ACTIVE' || org.deleted_at !== null) return forbidden({ reason: 'ORGANIZATION_NOT_ACTIVE' });
  return null;
}

export function accessTokenFor(m: Mock, u: UserRow): string {
  return issueAccessToken(
    m.cfg.secret,
    { userId: u.id, orgId: u.organization_id, roles: u.roles, orgAdmin: u.is_org_admin },
    m.store.now(),
  );
}

function newRefreshToken(m: Mock, userId: string): { id: string; token: string } {
  const token = opaqueToken();
  const id = m.store.id('refresh_token');
  m.store.insert('refresh_tokens', {
    id,
    user_id: userId,
    token: sha256hex(token),
    expires_at: iso(m.store.now() + REFRESH_TTL_SEC * 1000),
    revoked_at: null,
    replaced_by: null,
  });
  return { id, token };
}

function session(m: Mock, u: UserRow): Response {
  const { token } = newRefreshToken(m, u.id);
  m.store.markDirty();
  m.store.cookies.set('at_refresh', token);
  return json(
    200,
    { twoFactorRequired: false, accessToken: accessTokenFor(m, u), expiresIn: ACCESS_TTL_SEC, user: meView(m, u) },
    { ...NO_STORE, 'Set-Cookie': setCookie(token) },
  );
}

function refreshCookie(ctx: Ctx): string | null {
  const header = ctx.request.headers.get('cookie');
  if (header !== null) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0 && part.slice(0, eq).trim() === 'at_refresh') return part.slice(eq + 1).trim() || null;
    }
    return null;
  }
  return ctx.store.cookies.get('at_refresh') ?? null;
}

function clearCookie(ctx: Ctx): void {
  if (ctx.request.headers.get('cookie') === null) {
    ctx.store.markDirty();
    ctx.store.cookies.delete('at_refresh');
  }
}

const totpUsedKey = (userId: string, step: number): string => `totp-used:${userId}:${step}`;

function revokeAll(m: Mock, userId: string): void {
  const now = m.store.nowIso();
  for (const r of m.store.t.refresh_tokens)
    if (r.user_id === userId && r.revoked_at === null) m.store.patch(r, { revoked_at: now });
}

export { revokeAll as revokeAllRefreshTokens };

export const authHandlers: Record<string, Handler> = {
  async login(ctx) {
    hitRateLimit(ctx, 'login-ip', CLIENT_IP);
    const input = parseBody(LoginRequestSchema, await ctx.json());
    const email = input.email.toLowerCase();
    const u = ctx.store.t.users.find((x) => x.email === email && x.deleted_at === null);
    if (!u) throw new ApiError(401, 'INVALID_CREDENTIALS');
    const now = ctx.store.now();
    if (u.locked_until && Date.parse(u.locked_until) > now)
      throw new ApiError(401, 'ACCOUNT_LOCKED', { params: { lockedUntil: u.locked_until } });
    if (u.password === null || u.password !== input.password) {
      if (u.failed_logins + 1 >= LOCK_AFTER) {
        const lockedUntil = iso(now + LOCK_MS);
        ctx.store.patch(u, { failed_logins: 0, locked_until: lockedUntil });
        return problemResponse(new ApiError(401, 'ACCOUNT_LOCKED', { params: { lockedUntil } }));
      }
      ctx.store.patch(u, { failed_logins: u.failed_logins + 1 });
      return problemResponse(new ApiError(401, 'INVALID_CREDENTIALS'));
    }
    if (u.failed_logins !== 0) ctx.store.patch(u, { failed_logins: 0 });
    const denied = statusProblem(ctx, u);
    if (denied) return problemResponse(denied);
    if (u.totp_enabled) {
      const challengeId = randomUuid();
      ctx.store.kvSet(`2fa:${challengeId}`, { userId: u.id, exp: Math.floor(now / 1000) + CHALLENGE_TTL_SEC }, CHALLENGE_TTL_SEC);
      return json(200, { twoFactorRequired: true, challengeId }, NO_STORE);
    }
    return session(ctx, u);
  },

  async verifyTwoFactor(ctx) {
    const input = parseBody(TwoFactorVerifyRequestSchema, await ctx.json());
    const key = `2fa:${input.challengeId.toLowerCase()}`;
    const failKey = `2fa-fail:${input.challengeId.toLowerCase()}`;
    const expired = () => new ApiError(401, 'TOKEN_EXPIRED', { title: 'Two-factor challenge expired' });
    const challenge = keyValue(ctx, ctx.store.kvGet(key));
    if (!challenge) throw expired();
    const u = liveUser(ctx, challenge.userId);
    if (!u || !u.totp_enabled || !u.totp_secret || statusProblem(ctx, u)) {
      ctx.store.kvDel(key);
      ctx.store.kvDel(failKey);
      return problemResponse(expired());
    }
    const step = matchTotpStep(u.totp_secret, input.code, ctx.store.now());
    if (step === null || ctx.store.kvGet(totpUsedKey(u.id, step)) !== undefined) {
      const attempt = (ctx.store.kvGet<number>(failKey) ?? 0) + 1;
      if (attempt >= CHALLENGE_MAX_FAILS) {
        ctx.store.kvDel(key);
        ctx.store.kvDel(failKey);
      } else ctx.store.kvSet(failKey, attempt, CHALLENGE_TTL_SEC);
      return problemResponse(
        new ApiError(401, 'INVALID_TWO_FACTOR_CODE', { params: { attemptsLeft: CHALLENGE_MAX_FAILS - attempt } }),
      );
    }
    ctx.store.kvDel(key);
    ctx.store.kvDel(failKey);
    ctx.store.kvSet(totpUsedKey(u.id, step), '1', TOTP_USED_TTL_SEC);
    return session(ctx, u);
  },

  async setupTwoFactor(ctx) {
    const p = ctx.user();
    const input = parseBody(TwoFactorSetupRequestSchema, await ctx.json());
    const u = liveUser(ctx, p.userId);
    if (!u) throw new ApiError(401, 'UNAUTHORIZED');
    if (u.totp_enabled) throw new ApiError(409, 'INVALID_TRANSITION', { params: { from: 'ENABLED' } });
    if (input.code === undefined) {
      const secret = newTotpSecret();
      ctx.store.audit({ entityType: 'user', entityId: u.id, diff: { totpSecret: [u.totp_secret === null ? null : '***', '***'] } });
      ctx.store.patch(u, { totp_secret: secret, updated_at: ctx.store.nowIso() });
      return json(200, { totpEnabled: false, secret, otpauthUrl: otpauthUrl(u.email, secret) }, NO_STORE);
    }
    const step = u.totp_secret ? matchTotpStep(u.totp_secret, input.code, ctx.store.now()) : null;
    if (step === null || ctx.store.kvGet(totpUsedKey(u.id, step)) !== undefined)
      throw new ApiError(400, 'INVALID_TWO_FACTOR_CODE');
    ctx.store.touch('user', u);
    ctx.store.patch(u, { totp_enabled: true, updated_at: ctx.store.nowIso() });
    ctx.store.kvSet(totpUsedKey(u.id, step), '1', TOTP_USED_TTL_SEC);
    return json(200, { totpEnabled: true }, NO_STORE);
  },

  refreshToken(ctx) {
    const expired = (clear: boolean): Response => {
      if (clear) clearCookie(ctx);
      return new Response(JSON.stringify(new ApiError(401, 'TOKEN_EXPIRED', { title: 'Refresh token expired' }).body()), {
        status: 401,
        headers: { 'Content-Type': 'application/problem+json', ...(clear ? { 'Set-Cookie': CLEAR_COOKIE } : {}) },
      });
    };
    const token = refreshCookie(ctx);
    if (token === null) return expired(true);
    const row = ctx.store.t.refresh_tokens.find((r) => r.token === sha256hex(token));
    if (!row) return expired(true);
    const now = ctx.store.now();
    if (row.revoked_at) {
      if (row.replaced_by === null) return expired(true);
      if (now - Date.parse(row.revoked_at) <= ROTATION_GRACE_MS) return expired(false);
      const chain = new Set<string>([row.id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const r of ctx.store.t.refresh_tokens) {
          if (chain.has(r.id) && r.replaced_by && !chain.has(r.replaced_by)) {
            chain.add(r.replaced_by);
            grew = true;
          }
          if (r.replaced_by && chain.has(r.replaced_by) && !chain.has(r.id)) {
            chain.add(r.id);
            grew = true;
          }
        }
      }
      for (const r of ctx.store.t.refresh_tokens)
        if (chain.has(r.id) && r.revoked_at === null) ctx.store.patch(r, { revoked_at: iso(now) });
      return expired(true);
    }
    if (Date.parse(row.expires_at) <= now) return expired(true);
    const u = ctx.store.get('users', row.user_id);
    const revoke = () => ctx.store.patch(row, { revoked_at: iso(now) });
    if (!u || u.deleted_at !== null || u.status === 'INVITED') {
      revoke();
      return expired(true);
    }
    const org = ctx.store.must('organizations', u.organization_id);
    const reason =
      u.status === 'BLOCKED'
        ? 'USER_BLOCKED'
        : org.status !== 'ACTIVE' || org.deleted_at !== null
          ? 'ORGANIZATION_NOT_ACTIVE'
          : null;
    if (reason) {
      revoke();
      clearCookie(ctx);
      return new Response(JSON.stringify(forbidden({ reason }).body()), {
        status: 403,
        headers: { 'Content-Type': 'application/problem+json', 'Set-Cookie': CLEAR_COOKIE },
      });
    }
    const next = newRefreshToken(ctx, u.id);
    ctx.store.patch(row, { revoked_at: iso(now), replaced_by: next.id });
    if (ctx.request.headers.get('cookie') === null) {
      ctx.store.markDirty();
      ctx.store.cookies.set('at_refresh', next.token);
    }
    return json(
      200,
      { accessToken: accessTokenFor(ctx, u), expiresIn: ACCESS_TTL_SEC },
      { ...NO_STORE, 'Set-Cookie': setCookie(next.token) },
    );
  },

  logout(ctx) {
    const token = refreshCookie(ctx);
    if (token !== null) {
      const row = ctx.store.t.refresh_tokens.find((r) => r.token === sha256hex(token) && r.revoked_at === null);
      if (row) ctx.store.patch(row, { revoked_at: ctx.store.nowIso() });
    }
    clearCookie(ctx);
    return noContent({ 'Set-Cookie': CLEAR_COOKIE });
  },

  async forgotPassword(ctx) {
    const input = parseBody(ForgotPasswordRequestSchema, await ctx.json());
    const email = input.email.toLowerCase();
    hitRateLimit(ctx, 'forgot', email);
    const u = ctx.store.t.users.find((x) => x.email === email && x.deleted_at === null);
    if (u) {
      const token = opaqueToken();
      ctx.store.kvSet(`pwreset:${sha256hex(token)}`, { userId: u.id, exp: Math.floor(ctx.store.now() / 1000) + PWRESET_TTL_SEC }, PWRESET_TTL_SEC);
      const link = `${ctx.cfg.publicBaseUrl.replace(/\/+$/, '')}/password/reset/${token}`;
      ctx.store.afterCommit(() => ctx.cfg.onMail({ kind: 'passwordReset', to: email, link, token, at: ctx.store.nowIso() }));
    }
    return noContent();
  },

  async resetPassword(ctx) {
    const input = parseBody(ResetPasswordRequestSchema, await ctx.json());
    const entry = keyValue(ctx, ctx.store.kvTake(`pwreset:${sha256hex(input.token)}`));
    const u = entry ? liveUser(ctx, entry.userId) : undefined;
    if (!u) throw new ApiError(400, 'TOKEN_EXPIRED');
    ctx.store.patch(u, { password: input.password, failed_logins: 0, locked_until: null, updated_at: ctx.store.nowIso() });
    revokeAll(ctx, u.id);
    ctx.store.audit({ actorId: u.id, entityType: 'user', entityId: u.id, diff: { password: ['***', '***'] } });
    return noContent();
  },

  async registerOrganization(ctx) {
    const input = parseBody(RegisterOrganizationRequestSchema, await ctx.json());
    const email = input.admin.email.toLowerCase();
    const errors: Record<string, string[]> = {};
    const region = ctx.store.t.regions.find((r) => r.code === input.regionCode);
    if (ctx.store.t.organizations.some((o) => o.inn === input.inn)) errors.inn = ['validation.inn.taken'];
    if (!region) errors.regionCode = ['validation.notFound'];
    if (ctx.store.t.users.some((u) => u.email === email)) errors['admin.email'] = ['validation.email.taken'];
    if (Object.keys(errors).length > 0) throw validation(errors);
    const now = ctx.store.nowIso();
    const orgId = ctx.store.id('organization');
    const userId = ctx.store.id('user');
    const org = ctx.store.insert('organizations', {
      id: orgId,
      type: input.type,
      name: input.name ?? `Организация ИНН ${input.inn}`,
      inn: input.inn,
      address: null,
      region_id: region!.id,
      trust_rating: input.type === 'FARM' ? tr.initial : null,
      status: 'PENDING',
      logo_file_id: null,
      created_at: now,
      updated_at: now,
      created_by: userId,
      deleted_at: null,
    });
    const user = ctx.store.insert('users', {
      id: userId,
      organization_id: orgId,
      email,
      password: input.admin.password,
      full_name: input.admin.fullName,
      phone: null,
      is_org_admin: true,
      roles: [ROLE_OF_TYPE[input.type]!],
      totp_secret: null,
      totp_enabled: false,
      telegram_chat_id: null,
      notification_channels: { email: true, telegram: false },
      avatar_file_id: null,
      failed_logins: 0,
      locked_until: null,
      status: 'ACTIVE',
      created_at: now,
      updated_at: now,
      created_by: null,
      deleted_at: null,
    });
    ctx.store.created('organization', org);
    ctx.store.created('user', user);
    return json(201, { organizationId: orgId, status: 'PENDING' });
  },

  async acceptInvite(ctx) {
    const input = parseBody(AcceptInviteRequestSchema, await ctx.json());
    const entry = keyValue(ctx, ctx.store.kvTake(`invite:${sha256hex(input.token)}`));
    const u = entry ? liveUser(ctx, entry.userId) : undefined;
    if (!u || u.status !== 'INVITED') throw new ApiError(400, 'TOKEN_EXPIRED');
    ctx.store.touch('user', u);
    ctx.store.patch(u, {
      full_name: input.fullName,
      password: input.password,
      status: 'ACTIVE',
      failed_logins: 0,
      locked_until: null,
      updated_at: ctx.store.nowIso(),
    });
    return noContent();
  },
};
