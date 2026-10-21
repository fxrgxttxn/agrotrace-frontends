/**
 * The delivery half of `notification.dispatch` (contracts/events/notification.dispatch.schema.json, P45, P49): after
 * the handler's transaction committed, every PENDING EMAIL/TELEGRAM row it inserted is sent with up to 3 attempts —
 * success → DELIVERED, every attempt failed → FAILED, channel not configured on the server (no SMTP host, no bot token)
 * → NOT_CONFIGURED without an attempt; an unlinked TELEGRAM row → FAILED without an attempt. Waits after a failed
 * attempt: 1 s and 2 s.
 *
 * Claims (P49, at-least-once): a sender first claims rows — `claimed_at = now()` on rows still PENDING whose claim is
 * absent or older than 5 minutes, under `FOR UPDATE SKIP LOCKED` — and sends only what it claimed; `attempts` is
 * stored after every failed attempt, so a row taken over continues the same 3-attempt budget. The delivery sweeper
 * (scheduler job `notification-delivery`) claims PENDING rows whose `coalesce(claimed_at, created_at)` is older than 5
 * minutes — their sender died (crash, shutdown timeout) — and sends them the same way. A rare duplicate email after a
 * crash between the send and the status update is accepted. Every final update is `… WHERE delivery_status =
 * 'PENDING'`.
 *
 * Texts: @agrotrace/i18n `notificationMessage` (`email.subject`/`email.body`, `telegram`), Russian (users have no
 * locale). At most 5 rows of one batch are sent at a time (one pooled SMTP transport).
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
  },
): Promise<DeliveryOutcome> {
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
    try {
      await send();
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

  async function one(r: DeliveryRow): Promise<void> {
    const out = await sendRow(r, {
      ...deps,
      onFailure: async (attempts) => {
        await db
          .updateTable('notifications')
          .set({ attempts })
          .where('id', '=', r.id)
          .where('delivery_status', '=', 'PENDING')
          .execute();
      },
    });
    await db
      .updateTable('notifications')
      .set({ delivery_status: out.status, attempts: out.attempts })
      .where('id', '=', r.id)
      .where('delivery_status', '=', 'PENDING')
      .execute();
  }

  /** Claims rows (see the header) — `ids` given, or the stale ones — and returns them with their recipients. */
  async function claim(ids: readonly string[] | null): Promise<DeliveryRow[]> {
    const pick =
      ids === null
        ? sql`SELECT id FROM notifications
               WHERE delivery_status = 'PENDING' AND channel <> 'IN_APP'
                 AND coalesce(claimed_at, created_at) < now() - make_interval(secs => ${CLAIM_STALE_SEC})
               ORDER BY created_at LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED`
        : sql`SELECT id FROM notifications
               WHERE id = ANY(${[...ids]}::uuid[]) AND delivery_status = 'PENDING' AND channel <> 'IN_APP'
                 AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${CLAIM_STALE_SEC}))
               FOR UPDATE SKIP LOCKED`;
    const r = await sql<DeliveryRow>`
      WITH taken AS (UPDATE notifications SET claimed_at = now() WHERE id IN (${pick}) RETURNING id, type, payload,
                     channel, attempts, user_id)
      SELECT t.id, t.type, t.payload, t.channel, t.attempts, u.email, u.telegram_chat_id::text AS telegram_chat_id
        FROM taken t JOIN users u ON u.id = t.user_id`.execute(db);
    return r.rows;
  }

  async function sendAll(rows: DeliveryRow[]): Promise<void> {
    let next = 0;
    const lane = async () => {
      while (next < rows.length) {
        const r = rows[next++]!;
        await one(r).catch((err: unknown) =>
          logger.error({ err, notificationId: r.id }, 'notification delivery crashed'),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, rows.length) }, lane));
  }

  return {
    deliver(ids) {
      if (ids.length === 0) return;
      const p = claim(ids)
        .then(sendAll)
        .catch((err: unknown) => logger.error({ err }, 'notification delivery failed'));
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    },
    async sweep() {
      const rows = await claim(null);
      await sendAll(rows);
      return rows.length;
    },
    async idle() {
      await Promise.allSettled([...inFlight]);
    },
  };
}
