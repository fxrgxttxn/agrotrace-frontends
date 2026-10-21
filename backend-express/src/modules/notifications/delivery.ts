/**
 * The delivery half of `notification.dispatch` (contracts/events/notification.dispatch.schema.json, P45, P49): after
 * the handler's transaction committed, every PENDING EMAIL/TELEGRAM row it inserted is sent with up to 3 attempts —
 * success → DELIVERED, every attempt failed → FAILED, channel not configured on the server (no SMTP host, no bot token)
 * → NOT_CONFIGURED without an attempt; an unlinked TELEGRAM row → FAILED without an attempt. Waits after a failed
 * attempt: 1 s and 2 s. Every attempt has a deadline of 30 s (ATTEMPT_TIMEOUT_MS, both channels; nodemailer's own
 * connection/greeting/socket timeouts and the Telegram request's 10 s abort sit below it) — far below the 5-minute claim
 * threshold, so a hung transport never outlives its claim.
 *
 * Claims (P49, per send, at-least-once): a row is claimed right before its first attempt — one autocommit `UPDATE …
 * SET claimed_at = now()` on the row still PENDING whose claim is absent or older than 5 minutes — and the claim is
 * renewed before every further attempt, only while `claimed_at` still equals this sender's stamp (else it stops without
 * sending). `attempts` is stored after every failed attempt and every write is guarded by the stamp, so one row has one
 * sender at a time and never more than 3 attempts. A row waiting in a slow sender's queue is not claimed yet: the
 * sweeper may take it, and the slow sender then skips it. The delivery sweeper (scheduler job `notification-delivery`)
 * takes PENDING rows whose `coalesce(claimed_at, created_at)` is older than 5 minutes the same way. A rare duplicate
 * email after a crash between a send and its status update is accepted.
 *
 * Texts: @agrotrace/i18n `notificationMessage` (`email.subject`/`email.body`, `telegram`), Russian (users have no
 * locale). At most 5 rows are sent at a time per process (one pooled SMTP transport of 5 connections).
 */
import { sql } from 'kysely';
import { createT, notificationMessage } from '@agrotrace/i18n';
import type { Db } from '../../db/db.js';
import type { Mailer } from '../../infra/mailer.js';
import type { Telegram } from '../../infra/telegram.js';
import type { Logger } from '../../logger.js';

export const DELIVERY_ATTEMPTS = 3;
export const DELIVERY_DELAYS_MS = [1000, 2000, 4000] as const;
/** A claim older than this is abandoned (its sender died); longer than any send of 3 attempts. */
export const CLAIM_STALE_SEC = 300;
/** One attempt (either channel) that has not finished within this long counts as failed (N5; far below 5 minutes). */
export const ATTEMPT_TIMEOUT_MS = 30_000;
const PARALLEL = 5;
const SWEEP_BATCH = 100;

const ru = createT('ru');

export interface Delivery {
  /** Starts sending these rows (fire-and-forget; never throws). */
  deliver(ids: readonly string[]): void;
  /** One sweep: claims stale PENDING rows and sends them (awaited); returns how many it took. */
  sweep(): Promise<number>;
  /** Resolves when every started send has finished. */
  idle(): Promise<void>;
}

export interface DeliveryRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  channel: string;
  email: string;
  telegram_chat_id: string | null;
  /** Attempts already made (by a previous sender). */
  attempts?: number;
}

export interface DeliveryOutcome {
  status: 'DELIVERED' | 'FAILED' | 'NOT_CONFIGURED';
  attempts: number;
}

/** Sends one PENDING row (no database): the outcome to store. Exported for unit tests. */
export async function sendRow(
  r: DeliveryRow,
  deps: {
    mailer: Pick<Mailer, 'sendOnce' | 'configured'>;
    telegram: Pick<Telegram, 'configured' | 'sendMessage'>;
    logger: Logger;
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /** After each failed attempt that is not the last (stores the progress). */
    onFailure?: (attempts: number) => Promise<void>;
    /** Before every attempt (renews the claim); false — the row is no longer ours: stop, store nothing (null). */
    beforeAttempt?: () => Promise<boolean>;
    /** Per-attempt deadline (tests); default ATTEMPT_TIMEOUT_MS. */
    attemptTimeoutMs?: number;
  },
): Promise<DeliveryOutcome | null> {
  const { mailer, telegram, logger } = deps;
  const delays = deps.delaysMs ?? DELIVERY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const done = r.attempts ?? 0;
  if (r.channel === 'TELEGRAM' && !telegram.configured) return { status: 'NOT_CONFIGURED', attempts: done };
  if (r.channel === 'EMAIL' && !mailer.configured) return { status: 'NOT_CONFIGURED', attempts: done };
  if (r.channel === 'TELEGRAM' && r.telegram_chat_id === null) return { status: 'FAILED', attempts: done };
  if (done >= DELIVERY_ATTEMPTS) return { status: 'FAILED', attempts: done };
  const send =
    r.channel === 'EMAIL'
      ? () =>
          mailer.sendOnce({
            kind: `notification.${r.type}`,
            to: r.email,
            subject: notificationMessage(r.type, r.payload, 'email.subject', ru),
            text: notificationMessage(r.type, r.payload, 'email.body', ru),
          })
      : () =>
          telegram.sendMessage(r.telegram_chat_id!, notificationMessage(r.type, r.payload, 'telegram', ru));
  for (let attempt = done + 1; ; attempt++) {
    if (deps.beforeAttempt && !(await deps.beforeAttempt())) return null;
    try {
      await withDeadline(send(), deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
      return { status: 'DELIVERED', attempts: attempt };
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, notificationId: r.id, channel: r.channel, attempt },
        'notification send failed',
      );
      if (attempt >= DELIVERY_ATTEMPTS) return { status: 'FAILED', attempts: attempt };
      await deps.onFailure?.(attempt);
      await sleep(delays[attempt - 1] ?? 0);
    }
  }
}

export function createDelivery(deps: {
  db: Db;
  mailer: Mailer;
  telegram: Telegram;
  logger: Logger;
  delaysMs?: readonly number[];
}): Delivery {
  const { db, logger } = deps;
  const inFlight = new Set<Promise<void>>();
  const stale = sql`now() - make_interval(secs => ${CLAIM_STALE_SEC})`;

  /**
   * Claims ONE row right before its first attempt (P49 per send): `fresh` — a row of this sender's own batch, taken
   * unless someone holds a live claim; `stale` — a sweeper's take-over of a row nobody handled for 5 minutes. Returns
   * the row and the claim stamp (exact text), or null when another sender holds it or it is no longer PENDING.
   */
  async function claimOne(
    id: string,
    mode: 'fresh' | 'stale',
  ): Promise<{ row: DeliveryRow; stamp: string } | null> {
    const pred =
      mode === 'fresh'
        ? sql`(n.claimed_at IS NULL OR n.claimed_at < ${stale})`
        : sql`coalesce(n.claimed_at, n.created_at) < ${stale}`;
    const r = await sql<DeliveryRow & { stamp: string }>`
      WITH taken AS (
        UPDATE notifications n SET claimed_at = now()
         WHERE n.id = ${id} AND n.delivery_status = 'PENDING' AND n.channel <> 'IN_APP' AND ${pred}
        RETURNING n.id, n.type, n.payload, n.channel, n.attempts, n.user_id, n.claimed_at::text AS stamp)
      SELECT t.id, t.type, t.payload, t.channel, t.attempts, t.stamp, u.email,
             u.telegram_chat_id::text AS telegram_chat_id
        FROM taken t JOIN users u ON u.id = t.user_id`.execute(db);
    const row = r.rows[0];
    return row ? { row, stamp: row.stamp } : null;
  }

  async function one(id: string, mode: 'fresh' | 'stale'): Promise<void> {
    const claimed = await claimOne(id, mode);
    if (!claimed) return;
    let stamp = claimed.stamp;
    // Every write of this sender is guarded by its own claim stamp.
    const mine = (values: { attempts: number; delivery_status?: string }) =>
      db
        .updateTable('notifications')
        .set(values)
        .where('id', '=', id)
        .where('delivery_status', '=', 'PENDING')
        .where(sql<boolean>`claimed_at = ${stamp}::timestamptz`)
        .execute();
    const out = await sendRow(claimed.row, {
      ...deps,
      // Before every attempt the claim is renewed — only while it is still ours: a sender never sends a row
      // another one took over, so the 3-attempt budget is never exceeded.
      beforeAttempt: async () => {
        const r = await sql<{ stamp: string }>`
          UPDATE notifications SET claimed_at = now()
           WHERE id = ${id} AND delivery_status = 'PENDING' AND claimed_at = ${stamp}::timestamptz
          RETURNING claimed_at::text AS stamp`.execute(db);
        if (!r.rows[0]) return false;
        stamp = r.rows[0].stamp;
        return true;
      },
      onFailure: async (attempts) => {
        await mine({ attempts });
      },
    });
    if (out === null) return;
    await mine({ delivery_status: out.status, attempts: out.attempts });
  }

  // At most PARALLEL sends in the whole process (the SMTP pool has as many connections): a row is claimed only when a
  // slot is free, so its claim never ages while it waits.
  let active = 0;
  const waiting: (() => void)[] = [];
  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    // A released slot is handed straight to the next waiter (no newcomer can slip in between).
    if (active >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  async function sendAll(ids: readonly string[], mode: 'fresh' | 'stale'): Promise<void> {
    await Promise.all(
      ids.map((id) =>
        slot(() => one(id, mode)).catch((err: unknown) =>
          logger.error({ err, notificationId: id }, 'notification delivery crashed'),
        ),
      ),
    );
  }

  return {
    deliver(ids) {
      if (ids.length === 0) return;
      const p = sendAll(ids, 'fresh').catch((err: unknown) =>
        logger.error({ err }, 'notification delivery failed'),
      );
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    },
    async sweep() {
      const candidates = await sql<{ id: string }>`
        SELECT id FROM notifications
         WHERE delivery_status = 'PENDING' AND channel <> 'IN_APP' AND coalesce(claimed_at, created_at) < ${stale}
         ORDER BY created_at LIMIT ${SWEEP_BATCH}`.execute(db);
      const ids = candidates.rows.map((r) => r.id);
      await sendAll(ids, 'stale');
      return ids.length;
    },
    async idle() {
      await Promise.allSettled([...inFlight]);
    },
  };
}

/** Rejects when `p` has not settled within `ms` (the attempt is then counted as failed). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`attempt timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
