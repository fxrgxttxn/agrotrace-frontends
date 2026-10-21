/**
 * The delivery half of `notification.dispatch` (contracts/events/notification.dispatch.schema.json): after the
 * handler's transaction committed, every PENDING EMAIL/TELEGRAM row it inserted is sent with up to 3 attempts —
 * success → DELIVERED, every attempt failed → FAILED, channel not configured on the server (no bot token; Express
 * always has an SMTP host, `SMTP_HOST` defaults to the dev Mailpit) → NOT_CONFIGURED without an attempt; `attempts`
 * counts the send attempts. The waits after a failed attempt are 1 s and 2 s (the schema's "delays 1 s, 2 s, 4 s":
 * the third failure ends the row, so its wait is never used).
 *
 * Texts: @agrotrace/i18n `notificationMessage` (`email.subject`/`email.body`, `telegram`), Russian (users have no
 * locale). Sending runs detached from the queue delivery (the message is acknowledged after the commit — R56: a
 * redelivered event never repeats an external send); `idle()` lets the worker finish them on shutdown. A row that is
 * no longer PENDING (another sender got it first) is left alone: every update is `… WHERE delivery_status = 'PENDING'`.
 */
import { createT, notificationMessage } from '@agrotrace/i18n';
import type { Db } from '../../db/db.js';
import type { Mailer } from '../../infra/mailer.js';
import type { Telegram } from '../../infra/telegram.js';
import type { Logger } from '../../logger.js';

export const DELIVERY_ATTEMPTS = 3;
export const DELIVERY_DELAYS_MS = [1000, 2000, 4000] as const;

const ru = createT('ru');

export interface Delivery {
  /** Starts sending these rows (fire-and-forget; never throws). */
  deliver(ids: readonly string[]): void;
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
}

export interface DeliveryOutcome {
  status: 'DELIVERED' | 'FAILED' | 'NOT_CONFIGURED';
  attempts: number;
}

/** Sends one PENDING row (no database): the outcome to store. Exported for unit tests. */
export async function sendRow(
  r: DeliveryRow,
  deps: {
    mailer: Pick<Mailer, 'sendOnce'>;
    telegram: Pick<Telegram, 'configured' | 'sendMessage'>;
    logger: Logger;
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DeliveryOutcome> {
  const { mailer, telegram, logger } = deps;
  const delays = deps.delaysMs ?? DELIVERY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  if (r.channel === 'TELEGRAM' && !telegram.configured) return { status: 'NOT_CONFIGURED', attempts: 0 };
  if (r.channel === 'TELEGRAM' && r.telegram_chat_id === null) return { status: 'FAILED', attempts: 0 };
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
  for (let attempt = 1; ; attempt++) {
    try {
      await send();
      return { status: 'DELIVERED', attempts: attempt };
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, notificationId: r.id, channel: r.channel, attempt },
        'notification send failed',
      );
      if (attempt >= DELIVERY_ATTEMPTS) return { status: 'FAILED', attempts: attempt };
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
    const out = await sendRow(r, deps);
    await db
      .updateTable('notifications')
      .set({ delivery_status: out.status, attempts: out.attempts })
      .where('id', '=', r.id)
      .where('delivery_status', '=', 'PENDING')
      .execute();
  }

  async function run(ids: readonly string[]): Promise<void> {
    const rows = (await db
      .selectFrom('notifications as n')
      .innerJoin('users as u', 'u.id', 'n.user_id')
      .select(['n.id', 'n.type', 'n.payload', 'n.channel', 'u.email', 'u.telegram_chat_id'])
      .where('n.id', 'in', [...ids])
      .where('n.delivery_status', '=', 'PENDING')
      .where('n.channel', 'in', ['EMAIL', 'TELEGRAM'])
      .execute()) as DeliveryRow[];
    await Promise.all(
      rows.map((r) =>
        one(r).catch((err: unknown) =>
          logger.error({ err, notificationId: r.id }, 'notification delivery crashed'),
        ),
      ),
    );
  }

  return {
    deliver(ids) {
      if (ids.length === 0) return;
      const p = run(ids).catch((err: unknown) => logger.error({ err }, 'notification delivery failed'));
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    },
    async idle() {
      await Promise.allSettled([...inFlight]);
    },
  };
}
