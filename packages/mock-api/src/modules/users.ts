import { UserInviteSchema, UserPatchSchema } from '@agrotrace/validation';
import { parseBody } from '../http/body.js';
import { json, type Handler } from '../http/context.js';
import { paginate, uuidParam } from '../http/params.js';
import { ApiError, notFound, validation } from '../http/problem.js';
import { opaqueToken, sha256hex } from '../lib/crypto.js';
import { contains, sortBy } from '../lib/sort.js';
import type { Principal, RoleCode, UserRow } from '../store/types.js';
import { ROLE_ORDER, userView } from '../views/users.js';
import { INVITE_TTL_SEC, revokeAllRefreshTokens, ROLE_OF_TYPE } from './auth.js';
import { imageResponse } from './files.js';

const USER_STATUSES = ['INVITED', 'ACTIVE', 'BLOCKED'] as const;
const LIST_SORT = { fields: ['fullName', 'email', 'createdAt'], default: 'fullName,asc' };

const isAdmin = (p: Principal) => p.roles.includes('ADMIN');
const rolesFitType = (roles: readonly string[], type: string): boolean =>
  roles.length === 1 && roles[0] === ROLE_OF_TYPE[type];

export const usersHandlers: Record<string, Handler> = {
  listUsers(ctx) {
    const p = ctx.user();
    const q = ctx.query();
    const { page, size, sort } = q.page(LIST_SORT);
    const text = q.q();
    let organizationId = q.uuid('organizationId');
    if (q.has('organizationId') && !isAdmin(p)) {
      q.errors.organizationId = ['validation.organizationId.notAllowed'];
      organizationId = undefined;
    }
    const status = q.enumOf('status', USER_STATUSES);
    const role = q.enumOf('role', ROLE_ORDER);
    q.done();
    const orgId = isAdmin(p) ? organizationId : p.orgId;
    let rows = ctx.store.t.users.filter((u) => u.deleted_at === null);
    if (orgId) rows = rows.filter((u) => u.organization_id === orgId);
    if (status) rows = rows.filter((u) => u.status === status);
    if (role) rows = rows.filter((u) => u.roles.includes(role));
    if (text !== undefined) rows = rows.filter((u) => contains(u.full_name, text) || contains(u.email, text));
    const key = { fullName: (u: UserRow) => u.full_name, email: (u: UserRow) => u.email, createdAt: (u: UserRow) => u.created_at }[
      sort.field as 'fullName'
    ];
    rows = sortBy(rows, key, sort.field === 'createdAt' ? 'time' : 'text', sort.dir);
    const pg = paginate(rows, page, size);
    return json(200, { ...pg, items: pg.items.map((u) => userView(ctx, u)) });
  },

  async inviteUser(ctx) {
    const p = ctx.user();
    const input = parseBody(UserInviteSchema, await ctx.json());
    const email = input.email.toLowerCase();
    const errors: Record<string, string[]> = {};
    let orgId = p.orgId;
    if (input.organizationId !== undefined) {
      if (isAdmin(p)) orgId = input.organizationId.toLowerCase();
      else errors.organizationId = ['validation.organizationId.notAllowed'];
    }
    const org = ctx.store.get('organizations', orgId);
    if (ctx.store.t.users.some((u) => u.email === email)) errors.email = ['validation.email.taken'];
    if (!org || org.deleted_at !== null) errors.organizationId = ['validation.notFound'];
    else if (!rolesFitType(input.roles, org.type) || (input.roles.includes('ADMIN') && !isAdmin(p)))
      errors.roles = ['validation.notAllowed'];
    if (Object.keys(errors).length > 0) throw validation(errors);
    const now = ctx.store.nowIso();
    const user = ctx.store.insert('users', {
      id: ctx.store.id('user'),
      organization_id: org!.id,
      email,
      password: null,
      full_name: input.fullName,
      phone: null,
      is_org_admin: input.isOrgAdmin,
      roles: input.roles as RoleCode[],
      totp_secret: null,
      totp_enabled: false,
      telegram_chat_id: null,
      notification_channels: { email: true, telegram: false },
      avatar_file_id: null,
      failed_logins: 0,
      locked_until: null,
      status: 'INVITED',
      created_at: now,
      updated_at: now,
      created_by: p.userId,
      deleted_at: null,
    });
    ctx.store.created('user', user);
    const token = opaqueToken();
    ctx.store.kvSet(`invite:${sha256hex(token)}`, { userId: user.id, exp: Math.floor(ctx.store.now() / 1000) + INVITE_TTL_SEC }, INVITE_TTL_SEC);
    const link = `${ctx.cfg.publicBaseUrl.replace(/\/+$/, '')}/invite/${token}`;
    ctx.store.afterCommit(() => ctx.cfg.onMail({ kind: 'invite', to: email, link, token, at: ctx.store.nowIso() }));
    return json(201, userView(ctx, user));
  },

  async updateUser(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const input = parseBody(UserPatchSchema, await ctx.json());
    const u = ctx.store.get('users', id);
    if (!u || u.deleted_at !== null || (!isAdmin(p) && u.organization_id !== p.orgId)) throw notFound();
    if (input.status !== undefined && u.status === 'INVITED')
      throw new ApiError(409, 'INVALID_TRANSITION', { params: { from: 'INVITED', to: input.status } });
    const errors: Record<string, string[]> = {};
    if (u.id === p.userId)
      for (const f of ['roles', 'isOrgAdmin', 'status'] as const) if (input[f] !== undefined) errors[f] = ['validation.notAllowed'];
    const orgType = ctx.store.must('organizations', u.organization_id).type;
    if (input.roles !== undefined && !errors.roles && !rolesFitType(input.roles, orgType)) errors.roles = ['validation.notAllowed'];
    if (Object.keys(errors).length > 0) throw validation(errors);
    ctx.store.touch('user', u);
    const changes: Partial<UserRow> = {};
    if (input.roles && JSON.stringify(ROLE_ORDER.filter((r) => input.roles!.includes(r))) !== JSON.stringify(u.roles))
      changes.roles = ROLE_ORDER.filter((r) => input.roles!.includes(r));
    if (input.isOrgAdmin !== undefined && input.isOrgAdmin !== u.is_org_admin) changes.is_org_admin = input.isOrgAdmin;
    if (input.status !== undefined && input.status !== u.status) changes.status = input.status;
    if (Object.keys(changes).length > 0) {
      ctx.store.patch(u, { ...changes, updated_at: ctx.store.nowIso() });
      if (changes.status === 'BLOCKED') revokeAllRefreshTokens(ctx, u.id);
    }
    return json(200, userView(ctx, u));
  },

  async getUserAvatar(ctx) {
    const id = uuidParam(ctx.params.id);
    const q = ctx.query();
    const variant = q.enumOf('variant', ['96', '480'] as const);
    q.done();
    const u = ctx.store.get('users', id);
    if (!u || u.deleted_at !== null) throw notFound();
    return imageResponse(ctx, u.avatar_file_id, variant === '96' ? 96 : 480, 'private');
  },
};
