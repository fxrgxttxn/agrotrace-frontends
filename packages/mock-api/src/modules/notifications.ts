/**
 * Notifications (paths/notifications.yaml) and the SSE stream (paths/events.yaml): `notification` (id: = seq) then
 * `unread` for every new row, `unread` alone after marks, `ping` every 25 s, `reauth` when the access token expires
 * (then the stream closes). On connect: the notifications missed since `Last-Event-ID` / `lastEventId`, then `unread`.
 */
import { MarkReadRequestSchema } from '@agrotrace/validation';
import { onNotification, unreadCount } from '../domain/notify.js';
import { verifyAccessToken } from '../domain/tokens.js';
import { parseBody } from '../http/body.js';
import { json, type Handler } from '../http/context.js';
import { inDateRange, paginate } from '../http/params.js';
import { validation } from '../http/problem.js';
import { sortBy } from '../lib/sort.js';
import { iso } from '../lib/time.js';
import type { Store } from '../store/store.js';
import type { NotificationRow } from '../store/types.js';

const TYPES = ['LAB_ASSIGNED', 'LAB_RESULT', 'WAYBILL_INCOMING', 'RECALL', 'RECALL_TASK', 'OVERDUE', 'COMPLAINT', 'LAB_OVERDUE'] as const;
export const PING_MS = 25_000;

export const notificationView = (n: NotificationRow) => ({
  id: n.id,
  seq: n.seq,
  type: n.type,
  payload: n.payload,
  isRead: n.is_read,
  createdAt: n.created_at,
});

interface Stream {
  userId: string;
  send(chunk: string): void;
  close(): void;
}

/** Open SSE streams of one mock instance. */
export class EventHub {
  private readonly streams = new Set<Stream>();

  constructor(private readonly current: () => Store) {
    this.attach(current());
  }

  private get store(): Store {
    return this.current();
  }

  /** Delivers the notifications of `store` (called again whenever the state is replaced: reset, another tab). */
  attach(store: Store): void {
    onNotification(store, (row) => {
      for (const s of this.streams)
        if (s.userId === row.user_id) {
          s.send(`id: ${row.seq}\nevent: notification\ndata: ${JSON.stringify(notificationView(row))}\n\n`);
          s.send(this.unread(row.user_id));
        }
    });
  }

  unread(userId: string): string {
    return `event: unread\ndata: ${JSON.stringify({ count: unreadCount(this.store, userId) })}\n\n`;
  }

  /** Pushes the notifications another tab created (seq above `afterSeq`) and every open stream's counter. */
  deliverFrom(afterSeq: number): void {
    for (const row of this.store.t.notifications.filter((n) => n.seq > afterSeq).sort((a, b) => a.seq - b.seq))
      for (const s of this.streams)
        if (s.userId === row.user_id) s.send(`id: ${row.seq}\nevent: notification\ndata: ${JSON.stringify(notificationView(row))}\n\n`);
    for (const s of this.streams) s.send(this.unread(s.userId));
  }

  pushUnread(userId: string): void {
    for (const s of this.streams) if (s.userId === userId) s.send(this.unread(userId));
  }

  /** SSE streams open now (a stream is gone once its client cancels it or it is closed). */
  get openCount(): number {
    return this.streams.size;
  }

  /** Closes every stream (reset / stop). */
  closeAll(): void {
    for (const s of [...this.streams]) s.close();
  }

  open(userId: string, tokenExp: number, lastSeq: number | null, now: () => number): Response {
    const enc = new TextEncoder();
    let timers: ReturnType<typeof setTimeout>[] = [];
    let stream: Stream;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        stream = {
          userId,
          send: (chunk) => {
            if (!closed) controller.enqueue(enc.encode(chunk));
          },
          close: () => {
            if (closed) return;
            closed = true;
            for (const t of timers) clearTimeout(t);
            timers = [];
            this.streams.delete(stream);
            try {
              controller.close();
            } catch {
              // already closed by the client
            }
          },
        };
        this.streams.add(stream);
        if (lastSeq !== null)
          for (const n of this.store.t.notifications.filter((x) => x.user_id === userId && x.seq > lastSeq).sort((a, b) => a.seq - b.seq))
            stream.send(`id: ${n.seq}\nevent: notification\ndata: ${JSON.stringify(notificationView(n))}\n\n`);
        stream.send(this.unread(userId));
        const ping = setInterval(() => stream.send(`event: ping\ndata: ${JSON.stringify({ ts: iso(now()) })}\n\n`), PING_MS);
        timers.push(ping as unknown as ReturnType<typeof setTimeout>);
        const untilExpiry = Math.max(0, tokenExp * 1000 - now());
        timers.push(
          setTimeout(() => {
            stream.send(`event: reauth\ndata: ${JSON.stringify({ reason: 'TOKEN_EXPIRED' })}\n\n`);
            stream.close();
          }, untilExpiry),
        );
      },
      cancel: () => {
        for (const t of timers) clearTimeout(t);
        clearInterval(timers[0] as unknown as ReturnType<typeof setInterval>);
        this.streams.delete(stream);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    });
  }
}

export function notificationsHandlers(hub: EventHub): Record<string, Handler> {
  return {
    listNotifications(ctx) {
      const p = ctx.user();
      const q = ctx.query();
      const { page, size, sort } = q.page({ fields: ['seq'], default: 'seq,desc' });
      const isRead = q.bool('isRead');
      const types = q.enumList('type', TYPES);
      const range = q.dateRange();
      q.done();
      let rows = ctx.store.t.notifications.filter((n) => n.user_id === p.userId);
      if (isRead !== undefined) rows = rows.filter((n) => n.is_read === isRead);
      if (types) rows = rows.filter((n) => (types as readonly string[]).includes(n.type));
      if (range.from || range.to) rows = rows.filter((n) => inDateRange(range, n.created_at));
      const pg = paginate(sortBy(rows, (n) => n.seq, 'number', sort.dir), page, size);
      return json(200, { ...pg, items: pg.items.map(notificationView) });
    },

    async markNotificationsRead(ctx) {
      const p = ctx.user();
      const input = parseBody(MarkReadRequestSchema, await ctx.json());
      const own = ctx.store.t.notifications.filter((n) => n.user_id === p.userId);
      let targets: NotificationRow[];
      if ('ids' in input) {
        const errors: Record<string, string[]> = {};
        targets = [];
        input.ids.forEach((id, i) => {
          const n = own.find((x) => x.id === id.toLowerCase());
          if (!n) errors[`ids[${i}]`] = ['validation.notFound'];
          else targets.push(n);
        });
        if (Object.keys(errors).length > 0) throw validation(errors);
      } else targets = own.filter((n) => n.seq <= input.upToSeq);
      for (const n of targets) if (!n.is_read) ctx.store.patch(n, { is_read: true });
      ctx.store.afterCommit(() => hub.pushUnread(p.userId));
      return json(200, { count: unreadCount(ctx.store, p.userId) });
    },

    streamEvents(ctx) {
      const token = ctx.url.searchParams.get('access_token') ?? '';
      const p = verifyAccessToken(ctx.cfg.secret, token, ctx.store.now())!;
      const header = ctx.request.headers.get('Last-Event-ID');
      const query = ctx.url.searchParams.get('lastEventId');
      const raw = header ?? query;
      // The operation declares no 400: a value that is not a sequence number is treated as absent.
      // Ids are monotonic across resets (FM19): an id from an earlier world is below every id of the current one, so the
      // client gets the whole new world's notifications for its user.
      const lastSeq = raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
      return hub.open(p.userId, p.exp, lastSeq, () => ctx.store.now());
    },
  };
}
