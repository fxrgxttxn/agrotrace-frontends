/**
 * Notification center (contracts/openapi/paths/notifications.yaml, FR-NOTIF-01…04): the user's own IN_APP rows
 * (EMAIL/TELEGRAM rows are delivery records, never listed) and marking them read. After a mark the transaction runs
 * `SELECT pg_notify('notifications', json_build_object('user_id', :userId, 'unread', true)::text)` — delivered to
 * every LISTEN session at commit, so the SSE streams of the user on any implementation get a fresh `unread`.
 * Marking has no audit row: the audit entity types (audit_log CHECK) have no notification.
 */
import { sql } from 'kysely';
import type { Request } from 'express';
import { MarkReadRequestSchema } from '@agrotrace/validation';
import rules from '../../../../contracts/rules/notifications.json' with { type: 'json' };
import type { Container } from '../../container.js';
import type { Db } from '../../db/db.js';
import { withTx } from '../../db/tx.js';
import { parseBody } from '../../http/body.js';
import { dayAfter, QueryReader } from '../../http/params.js';
import { validationProblem } from '../../http/problem.js';
import type { Principal } from '../../security/jwt.js';
import { iso } from '../batches/view.js';

const SORT = { fields: ['seq'], default: 'seq,desc' } as const;
const TYPES = Object.keys(rules.types) as (keyof typeof rules.types)[];

export interface NotificationView {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

export const notificationView = (r: {
  id: string;
  seq: string | number;
  type: string;
  payload: unknown;
  is_read: boolean;
  created_at: unknown;
}): NotificationView => ({
  id: r.id,
  seq: Number(r.seq),
  type: r.type,
  payload: (r.payload ?? {}) as Record<string, unknown>,
  isRead: r.is_read,
  createdAt: iso(r.created_at),
});

/** The user's unread IN_APP count. */
export async function unreadCount(db: Db, userId: string): Promise<number> {
  const r = await db
    .selectFrom('notifications')
    .select(sql<string>`count(*)`.as('n'))
    .where('user_id', '=', userId)
    .where('channel', '=', 'IN_APP')
    .where('is_read', '=', false)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

export function notificationsService(c: Container) {
  const { db } = c;
  return {
    async list(p: Principal, query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(SORT);
      const isRead = q.bool('isRead');
      const types = q.enumList('type', TYPES);
      const { from, to } = q.dateRange();
      q.done();
      let base = db
        .selectFrom('notifications')
        .where('user_id', '=', p.userId)
        .where('channel', '=', 'IN_APP');
      if (isRead !== undefined) base = base.where('is_read', '=', isRead);
      if (types) base = base.where('type', 'in', types);
      // from/to — by the UTC date of createdAt.
      if (from) base = base.where('created_at', '>=', new Date(`${from}T00:00:00Z`));
      if (to) base = base.where('created_at', '<', dayAfter(to));
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const rows = await base
        .select(['id', 'seq', 'type', 'payload', 'is_read', 'created_at'])
        .orderBy('seq', sort.dir)
        .orderBy(sql`id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return { items: rows.map(notificationView), page, size, total: Number(total) };
    },

    /** markNotificationsRead — `ids` (each own IN_APP, else 400 `ids[i]` notFound, nothing marked) or `upToSeq`. */
    async markRead(p: Principal, raw: unknown) {
      const body = parseBody(MarkReadRequestSchema, raw);
      return withTx(db, async (tx) => {
        let marked = tx
          .updateTable('notifications')
          .set({ is_read: true })
          .where('user_id', '=', p.userId)
          .where('channel', '=', 'IN_APP')
          .where('is_read', '=', false);
        if ('ids' in body) {
          const ids = body.ids.map((x) => x.toLowerCase());
          const own = new Set(
            (
              await tx
                .selectFrom('notifications')
                .select('id')
                .where('id', 'in', ids)
                .where('user_id', '=', p.userId)
                .where('channel', '=', 'IN_APP')
                .execute()
            ).map((r) => r.id),
          );
          const errors: Record<string, string[]> = {};
          ids.forEach((id, i) => {
            if (!own.has(id)) errors[`ids[${i}]`] = ['validation.notFound'];
          });
          if (Object.keys(errors).length > 0) throw validationProblem(errors);
          marked = marked.where('id', 'in', ids);
        } else marked = marked.where('seq', '<=', String(body.upToSeq));
        await marked.execute();
        await sql`SELECT pg_notify('notifications',
                    json_build_object('user_id', ${p.userId}::uuid, 'unread', true)::text)`.execute(tx);
        const r = await tx
          .selectFrom('notifications')
          .select(sql<string>`count(*)`.as('n'))
          .where('user_id', '=', p.userId)
          .where('channel', '=', 'IN_APP')
          .where('is_read', '=', false)
          .executeTakeFirstOrThrow();
        return { count: Number(r.n) };
      });
    },
  };
}
