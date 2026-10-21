/**
 * SSE hub of the API process (contracts/openapi/paths/events.yaml, spec 8.4, R33): ONE PostgreSQL session holds
 * `LISTEN notifications` and fans the payloads out to this process's open streams. The `notifications` trigger emits
 * `{"id", "user_id"}` for every IN_APP row any implementation inserts (cross-backend delivery); markNotificationsRead
 * emits `{"user_id", "unread": true}`.
 *
 * - payload with `id`: the row is read once and every stream of the user gets `notification` (`id:` = seq) then
 *   `unread`;
 * - payload without `id`: `unread` only;
 * - payloads are handled one after another (a serial queue), so a user's events keep the commit order of NOTIFY;
 * - a stream never sends the same notification twice (per-stream set of sent ids; a stream lives ≤ 15 minutes);
 * - the LISTEN session reconnects with back-off; after a reconnect every stream is re-synchronised (rows with a seq
 *   above the stream's highest sent seq, then `unread`), since NOTIFY sent while disconnected are lost.
 *
 * Connect (streamEvents): register the stream first (live events are buffered), replay the missed rows, flush the
 * buffer, send `unread`; `ping` every 25 s; `reauth` at the token's `exp`, then the stream ends.
 *
 * Replay for `Last-Event-ID` / `lastEventId` = L (contract text): the user's IN_APP rows with `seq > L`, plus unread
 * rows with `seq < L` created at most 60 s before row L — `seq` is taken at INSERT, so a transaction that inserted
 * earlier but committed after row L was sent has a lower seq (the T3-5 note for SSE); ordered by seq.
 */
import { sql } from 'kysely';
import pg from 'pg';
import type { Response } from 'express';
import type { Db } from '../db/db.js';
import type { Logger } from '../logger.js';
import { notificationView, unreadCount, type NotificationView } from '../modules/notifications/service.js';

export const PING_MS = 25_000;
export const LATE_COMMIT_WINDOW_SEC = 60;
const SENT_CAP = 10_000;

const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

class Stream {
  private readonly sent = new Set<string>();
  maxSeq = 0;
  /** Live notifications that arrived while the connect replay was running. */
  buffer: NotificationView[] | null = [];
  closed = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    readonly userId: string,
    private readonly res: Response,
  ) {}

  write(chunk: string): void {
    if (!this.closed) this.res.write(chunk);
  }

  notification(n: NotificationView): void {
    if (this.buffer) {
      this.buffer.push(n);
      return;
    }
    this.replay(n);
  }

  /** Sends now, also during the connect replay (deduplicated). */
  replay(n: NotificationView): void {
    if (this.sent.has(n.id)) return;
    if (this.sent.size >= SENT_CAP) this.sent.clear();
    this.sent.add(n.id);
    this.maxSeq = Math.max(this.maxSeq, n.seq);
    this.write(`id: ${n.seq}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`);
  }

  unread(count: number): void {
    if (this.buffer) return; // the connect sequence ends with its own `unread`
    this.write(`event: unread\ndata: ${JSON.stringify({ count })}\n\n`);
  }

  /** Ends the replay phase: buffered live notifications go out (deduplicated). */
  flush(): void {
    const buffered = this.buffer ?? [];
    this.buffer = null;
    for (const n of buffered.sort((a, b) => a.seq - b.seq)) this.notification(n);
  }

  timer(t: NodeJS.Timeout): void {
    this.timers.push(t);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.res.end();
  }

  dispose(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

export interface SseHub {
  start(): void;
  /** streamEvents after authentication: takes over the response until it ends. */
  open(res: Response, opts: { userId: string; exp: number; lastSeq: string | null }): Promise<void>;
  /** Open streams (tests, logs). */
  readonly size: number;
  close(): Promise<void>;
}

type Row = Parameters<typeof notificationView>[0];

export function createSseHub(deps: { db: Db; databaseUrl: string; logger: Logger; pingMs?: number }): SseHub {
  const { db, logger } = deps;
  const pingMs = deps.pingMs ?? PING_MS;
  const streams = new Map<string, Set<Stream>>();
  let client: pg.Client | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let queue: Promise<void> = Promise.resolve();

  const userStreams = (userId: string) => [...(streams.get(userId) ?? [])].filter((s) => !s.closed);

  async function rowById(id: string): Promise<NotificationView | null> {
    const r = await db
      .selectFrom('notifications')
      .select(['id', 'seq', 'type', 'payload', 'is_read', 'created_at'])
      .where('id', '=', id)
      .where('channel', '=', 'IN_APP')
      .executeTakeFirst();
    return r ? notificationView(r as Row) : null;
  }

  async function handle(payload: string | undefined): Promise<void> {
    let msg: { id?: unknown; user_id?: unknown };
    try {
      msg = JSON.parse(payload ?? '') as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.user_id !== 'string') return;
    const targets = userStreams(msg.user_id);
    if (targets.length === 0) return;
    if (typeof msg.id === 'string') {
      const n = await rowById(msg.id);
      if (n) for (const s of targets) s.notification(n);
    }
    const count = await unreadCount(db, msg.user_id);
    for (const s of userStreams(msg.user_id)) s.unread(count);
  }

  /** After a LISTEN reconnect: rows above each stream's highest seq, then `unread`. */
  async function resync(): Promise<void> {
    for (const [userId, set] of streams) {
      for (const s of set) {
        if (s.closed || s.buffer) continue;
        const rows = await db
          .selectFrom('notifications')
          .select(['id', 'seq', 'type', 'payload', 'is_read', 'created_at'])
          .where('user_id', '=', userId)
          .where('channel', '=', 'IN_APP')
          .where('seq', '>', String(s.maxSeq))
          .orderBy('seq')
          .execute();
        for (const r of rows) s.notification(notificationView(r as Row));
      }
      const count = await unreadCount(db, userId);
      for (const s of userStreams(userId)) s.unread(count);
    }
  }

  function enqueue(job: () => Promise<void>): void {
    queue = queue
      .then(job)
      .catch((err: unknown) => logger.warn({ err: (err as Error).message }, 'sse event failed'));
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const c = new pg.Client({
      connectionString: deps.databaseUrl,
      application_name: 'agrotrace-express-sse',
      options: '-c TimeZone=UTC',
    });
    c.on('notification', (m) => {
      if (m.channel === 'notifications') enqueue(() => handle(m.payload));
    });
    const lost = (err?: Error) => {
      if (client !== c) return;
      client = null;
      c.removeAllListeners('notification');
      void c.end().catch(() => undefined);
      if (!stopped) {
        logger.warn({ err: err?.message }, 'sse listen session lost; reconnecting');
        schedule();
      }
    };
    c.on('error', lost);
    c.on('end', () => lost());
    try {
      await c.connect();
      await c.query('LISTEN notifications');
      if (stopped) {
        await c.end().catch(() => undefined);
        return;
      }
      client = c;
      const reconnected = attempt > 0;
      attempt = 0;
      if (reconnected) enqueue(resync);
    } catch (err) {
      await c.end().catch(() => undefined);
      if (attempt === 0) logger.warn({ err: (err as Error).message }, 'sse listen unavailable; retrying');
      schedule();
    }
  }

  function schedule(): void {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(500 * 2 ** attempt, 10_000);
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  return {
    start() {
      void connect();
    },
    get size() {
      let n = 0;
      for (const set of streams.values()) n += set.size;
      return n;
    },
    async open(res, { userId, exp, lastSeq }) {
      const s = new Stream(userId, res);
      let set = streams.get(userId);
      if (!set) streams.set(userId, (set = new Set()));
      set.add(s);
      const remove = () => {
        s.dispose();
        set.delete(s);
        if (set.size === 0 && streams.get(userId) === set) streams.delete(userId);
      };
      res.on('close', remove);
      s.timer(
        setInterval(
          () => s.write(`event: ping\ndata: ${JSON.stringify({ ts: isoSec(new Date()) })}\n\n`),
          pingMs,
        ),
      );
      s.timer(
        setTimeout(
          () => {
            s.write(`event: reauth\ndata: ${JSON.stringify({ reason: 'TOKEN_EXPIRED' })}\n\n`);
            s.end();
          },
          Math.min(2 ** 31 - 1, Math.max(0, exp * 1000 - Date.now())),
        ),
      );
      try {
        if (lastSeq !== null) {
          const rows = await sql<Row>`
            SELECT n.id, n.seq, n.type, n.payload, n.is_read, n.created_at
              FROM notifications n
             WHERE n.user_id = ${userId} AND n.channel = 'IN_APP'
               AND (n.seq > ${lastSeq}::bigint
                    OR (n.seq < ${lastSeq}::bigint AND NOT n.is_read
                        AND n.created_at >= (SELECT l.created_at - make_interval(secs => ${LATE_COMMIT_WINDOW_SEC})
                                               FROM notifications l
                                              WHERE l.seq = ${lastSeq}::bigint AND l.user_id = ${userId})))
             ORDER BY n.seq`.execute(db);
          for (const r of rows.rows) s.replay(notificationView(r));
        }
      } finally {
        s.flush();
      }
      s.unread(await unreadCount(db, userId));
    },
    async close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const set of streams.values()) for (const s of set) s.end();
      streams.clear();
      const c = client;
      client = null;
      await c?.end().catch(() => undefined);
      await queue;
    },
  };
}
