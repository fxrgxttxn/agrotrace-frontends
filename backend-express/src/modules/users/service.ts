/**
 * Users (contracts/openapi/paths/users.yaml, FR-IAM-02): a head manages the own organization's employees, ADMIN every
 * user. A user outside that scope is invisible (404). Check order (info.description): 401 → 403 by role / head →
 * 400 schema → 404 → 409 INVALID_TRANSITION → 400 by references.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createT } from '@agrotrace/i18n';
import { UserInviteSchema, UserPatchSchema } from '@agrotrace/validation';
import type { Request } from 'express';
import type { Container } from '../../container.js';
import { txNow, withTx } from '../../db/tx.js';
import { QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import type { Principal, RoleCode } from '../../security/jwt.js';
import { newOpaqueToken, sha256hex } from '../../security/tokens.js';
import { auditDiff, auditService } from '../audit/service.js';
import { lockUserRefresh, revokeAllRefreshTokens } from '../auth/sessions.js';
import { rolesFitType } from './roles.js';
import { loadUserViews, type UserView } from './view.js';

const ru = createT('ru');
const INVITE_TTL_SEC = 7 * 24 * 3600;
const USER_STATUSES = ['INVITED', 'ACTIVE', 'BLOCKED'] as const;
const ROLE_CODES = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'] as const;
const LIST_SORT = { fields: ['fullName', 'email', 'createdAt'], default: 'fullName,asc' } as const;

const isAdmin = (p: Principal) => p.roles.includes('ADMIN');

export interface UserPage {
  items: UserView[];
  page: number;
  size: number;
  total: number;
}

export function usersService(c: Container) {
  const { db } = c;

  async function view(id: string): Promise<UserView> {
    const [v] = await loadUserViews(db, c.fileUrls, [id]);
    if (!v) throw new Error(`user ${id} vanished`);
    return v;
  }

  return {
    /** listUsers — own organization for a head, everybody (organizationId filter) for ADMIN (R51). */
    async list(p: Principal, query: Request['query']): Promise<UserPage> {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(LIST_SORT);
      const text = q.q();
      let organizationId = q.uuid('organizationId');
      if (q.has('organizationId') && !isAdmin(p)) {
        q.errors.organizationId = ['validation.organizationId.notAllowed'];
        organizationId = undefined;
      }
      const status = q.enumOf('status', USER_STATUSES);
      const role = q.enumOf('role', ROLE_CODES);
      q.done();

      let base = db.selectFrom('users as u').where('u.deleted_at', 'is', null);
      const orgId = isAdmin(p) ? organizationId : p.orgId;
      if (orgId) base = base.where('u.organization_id', '=', orgId);
      if (status) base = base.where('u.status', '=', status);
      if (role)
        base = base.where(({ exists, selectFrom }) =>
          exists(
            selectFrom('user_roles as ur')
              .innerJoin('roles as r', 'r.id', 'ur.role_id')
              .select(sql`1`.as('one'))
              .whereRef('ur.user_id', '=', 'u.id')
              .where('r.code', '=', role),
          ),
        );
      if (text !== undefined) {
        // Substring, case-insensitive; `%`, `_`, `\` are ordinary characters (no LIKE).
        base = base.where(
          sql<boolean>`(position(lower(${text}) in lower(u.full_name)) > 0
                        OR position(lower(${text}) in lower(u.email::text)) > 0)`,
        );
      }
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const order = {
        fullName: sql`u.full_name COLLATE "C"`,
        email: sql`u.email::text COLLATE "C"`,
        createdAt: sql`u.created_at`,
      }[sort.field as 'fullName' | 'email' | 'createdAt'];
      const rows = await base
        .select('u.id')
        .orderBy(sort.dir === 'asc' ? sql`${order} ASC NULLS LAST` : sql`${order} DESC NULLS LAST`)
        .orderBy(sql`u.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return {
        items: await loadUserViews(
          db,
          c.fileUrls,
          rows.map((r) => r.id),
        ),
        page,
        size,
        total: Number(total),
      };
    },

    /** inviteUser — INVITED user + `invite:{sha256hex(token)}` (7 days, R82) + the letter with the link. */
    async invite(p: Principal, body: unknown): Promise<UserView> {
      const input = UserInviteSchema.parse(body);
      const email = input.email.toLowerCase();
      const errors: Record<string, string[]> = {};
      let orgId = p.orgId;
      if (input.organizationId !== undefined) {
        if (isAdmin(p)) orgId = input.organizationId.toLowerCase();
        else errors.organizationId = ['validation.organizationId.notAllowed'];
      }
      const [org, taken] = await Promise.all([
        db
          .selectFrom('organizations')
          .select(['id', 'name', 'type'])
          .where('id', '=', orgId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
        db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst(),
      ]);
      if (taken) errors.email = ['validation.email.taken'];
      if (!org) errors.organizationId = ['validation.notFound'];
      else if (!rolesFitType(input.roles, org.type) || (input.roles.includes('ADMIN') && !isAdmin(p)))
        errors.roles = ['validation.notAllowed'];
      if (Object.keys(errors).length > 0) throw validationProblem(errors);

      const userId = randomUUID();
      const token = newOpaqueToken();
      // Written before the row: a key whose user never got committed is harmless (acceptInvite → TOKEN_EXPIRED).
      await c.redis.set(
        `invite:${sha256hex(token)}`,
        JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SEC }),
        'EX',
        INVITE_TTL_SEC,
      );
      const roles = input.roles as RoleCode[];
      try {
        await withTx(db, async (tx) => {
          await tx
            .insertInto('users')
            .values({
              id: userId,
              organization_id: org!.id,
              email,
              // No password until the invitation is accepted: '!' is no PHC hash and never verifies.
              password_hash: '!',
              full_name: input.fullName,
              is_org_admin: input.isOrgAdmin,
              status: 'INVITED',
              created_by: p.userId,
            })
            .execute();
          await tx
            .insertInto('user_roles')
            .columns(['user_id', 'role_id'])
            .expression(
              tx
                .selectFrom('roles')
                .select([sql<string>`${userId}::uuid`.as('user_id'), 'id as role_id'])
                .where('code', 'in', roles),
            )
            .execute();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'inviteUser',
            entityType: 'user',
            entityId: userId,
            diff: auditDiff(null, {
              email,
              fullName: input.fullName,
              roles,
              isOrgAdmin: input.isOrgAdmin,
              status: 'INVITED',
              organizationId: org!.id,
            }),
          });
        });
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'users_email_key')
          throw validationProblem({ email: ['validation.email.taken'] });
        throw err;
      }
      const link = `${c.config.PUBLIC_BASE_URL}/invite/${token}`;
      void c.mailer.send({
        kind: 'invite',
        to: email,
        subject: ru('mail.invite.subject', { organizationName: org!.name }),
        text: ru('mail.invite.body', { organizationName: org!.name, link }),
      });
      return view(userId);
    },

    /** updateUser — roles, head flag, status ACTIVE ↔ BLOCKED (blocking revokes refresh tokens), R37. */
    async update(p: Principal, id: string, body: unknown): Promise<UserView> {
      const input = UserPatchSchema.parse(body);
      await withTx(db, async (tx) => {
        // P12: the per-user refresh lock comes before any row lock of a transaction that revokes tokens.
        if (input.status === 'BLOCKED') await lockUserRefresh(tx, id);
        const u = await tx
          .selectFrom('users as u')
          .innerJoin('organizations as o', 'o.id', 'u.organization_id')
          .select(['u.id', 'u.organization_id', 'u.status', 'u.is_org_admin', 'o.type as org_type'])
          .where('u.id', '=', id)
          .where('u.deleted_at', 'is', null)
          .forNoKeyUpdate('u')
          .executeTakeFirst();
        if (!u || (!isAdmin(p) && u.organization_id !== p.orgId)) throw new AppProblem(404, 'NOT_FOUND');
        if (input.status !== undefined && u.status === 'INVITED')
          throw new AppProblem(409, 'INVALID_TRANSITION', { params: { from: 'INVITED', to: input.status } });

        const errors: Record<string, string[]> = {};
        if (u.id === p.userId)
          for (const field of ['roles', 'isOrgAdmin', 'status'] as const)
            if (input[field] !== undefined) errors[field] = ['validation.notAllowed'];
        if (input.roles !== undefined && !errors.roles && !rolesFitType(input.roles, u.org_type))
          errors.roles = ['validation.notAllowed'];
        if (Object.keys(errors).length > 0) throw validationProblem(errors);

        const current = await tx
          .selectFrom('user_roles as ur')
          .innerJoin('roles as r', 'r.id', 'ur.role_id')
          .select('r.code')
          .where('ur.user_id', '=', id)
          .orderBy('r.id')
          .execute();
        const beforeRoles = current.map((r) => r.code);
        const before = { roles: beforeRoles, isOrgAdmin: u.is_org_admin, status: u.status };
        const after = {
          roles: input.roles ? ROLE_ORDER.filter((r) => input.roles!.includes(r)) : beforeRoles,
          isOrgAdmin: input.isOrgAdmin ?? u.is_org_admin,
          status: input.status ?? u.status,
        };
        const diff = auditDiff(before, after);
        if (Object.keys(diff).length === 0) return;
        const now = await txNow(tx);
        if (diff.roles) {
          await tx.deleteFrom('user_roles').where('user_id', '=', id).execute();
          await tx
            .insertInto('user_roles')
            .columns(['user_id', 'role_id'])
            .expression(
              tx
                .selectFrom('roles')
                .select([sql<string>`${id}::uuid`.as('user_id'), 'id as role_id'])
                .where('code', 'in', after.roles),
            )
            .execute();
        }
        await tx
          .updateTable('users')
          .set({ is_org_admin: after.isOrgAdmin, status: after.status, updated_at: now })
          .where('id', '=', id)
          .execute();
        if (diff.status && after.status === 'BLOCKED') await revokeAllRefreshTokens(tx, id, now);
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'updateUser',
          entityType: 'user',
          entityId: id,
          diff,
        });
      });
      return view(id);
    },
  };
}

const ROLE_ORDER: RoleCode[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];

export type UsersService = ReturnType<typeof usersService>;
