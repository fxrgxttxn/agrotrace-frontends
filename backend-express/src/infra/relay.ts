/**
 * Outbox relay and sweeper, publishing side (R55, R56, contracts/events/envelope.schema.json). A row of
 * `outbox_events` is published to the exchange `agrotrace.express` with routing key = `type` (persistent,
 * application/json, message_id = id) on a confirm channel, then marked:
 * `UPDATE … SET published_at = now(), attempts = attempts + 1 WHERE id = :id AND published_at IS NULL`.
 *
 * - relay: `publish(ids)` right after the causing transaction committed (rows locked `FOR UPDATE SKIP LOCKED`, so a
 *   sweeper that holds one is never waited for);
 * - sweeper: every 5 s, only while `pg_try_advisory_xact_lock(hashtext('agrotrace.outbox.express'))` succeeds, the
 *   oldest 100 unpublished rows of this backend.
 *
 * Only the event types with a consumer in the worker are relayed (`RELAYED_TYPES`; P1): vsd.import (Task 6),
 * recall.requested and rating.recalculate (Task 10). Rows of the other types (notification.dispatch, lab.escalate) stay
 * unpublished in the outbox until Task 12 adds their consumers and widens the list to every type.
 */
import { sql, type Transaction } from 'kysely';
import type { ConfirmChannel } from 'amqplib';
import type { Db } from '../db/db.js';
import type { DB } from '../db/types.generated.js';
import type { Logger } from '../logger.js';
import { EXCHANGE, type Amqp } from './amqp.js';
import type { EventType } from './outbox.js';

/** Event types the worker consumes so far (Task 12: every type of the envelope). */
export const RELAYED_TYPES: readonly EventType[] = ['vsd.import', 'recall.requested', 'rating.recalculate'];

const SWEEP_INTERVAL_MS = 5000;
const SWEEP_BATCH = 100;

export interface OutboxRelay {
  start(): void;
  /** Publishes these rows now (after their transaction committed); never throws — the sweeper retries. */
  publish(ids: readonly string[]): Promise<void>;
  /** One sweeper pass (exported for the interval and tests). */
  sweep(): Promise<number>;
  stop(): Promise<void>;
}

interface Row {
  id: string;
  type: string;
  payload: unknown;
}

export function createOutboxRelay(deps: { db: Db; amqp: Amqp; logger: Logger }): OutboxRelay {
  const { db, amqp, logger } = deps;
  let channel: Promise<ConfirmChannel> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function confirmChannel(): Promise<ConfirmChannel> {
    const conn = amqp.connection;
    if (!conn) return Promise.reject(new Error('rabbitmq not connected'));
    channel ??= conn.createConfirmChannel().then((ch) => {
      ch.on('error', (err: Error) => logger.warn({ err: err.message }, 'outbox channel error'));
      ch.on('close', () => {
        channel = null;
      });
      return ch;
    });
    channel.catch(() => {
      channel = null;
    });
    return channel;
  }

  async function publishRow(ch: ConfirmChannel, row: Row): Promise<void> {
    const body = Buffer.from(typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload));
    await new Promise<void>((resolve, reject) => {
      ch.publish(
        EXCHANGE,
        row.type,
        body,
        { persistent: true, contentType: 'application/json', messageId: row.id },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  /** Publishes and marks the picked rows inside one transaction (the rows stay locked until marked). */
  async function publishLocked(
    pick: (q: ReturnType<typeof base>) => ReturnType<typeof base>,
    advisory: boolean,
  ): Promise<number> {
    const ch = await confirmChannel();
    return db.transaction().execute(async (tx) => {
      if (advisory) {
        const got = await sql<{ ok: boolean }>`
          SELECT pg_try_advisory_xact_lock(hashtext('agrotrace.outbox.express')) AS ok`.execute(tx);
        if (!got.rows[0]?.ok) return 0;
      }
      const rows = (await pick(base(tx)).execute()) as Row[];
      for (const row of rows) {
        await publishRow(ch, row);
        await tx
          .updateTable('outbox_events')
          .set({ published_at: sql`now()`, attempts: sql`attempts + 1` })
          .where('id', '=', row.id)
          .where('published_at', 'is', null)
          .execute();
      }
      return rows.length;
    });
  }

  function base(tx: Transaction<DB>) {
    return tx
      .selectFrom('outbox_events')
      .select(['id', 'type', 'payload'])
      .where('backend', '=', 'express')
      .where('published_at', 'is', null)
      .where('type', 'in', [...RELAYED_TYPES])
      .forUpdate()
      .skipLocked();
  }

  const relay: OutboxRelay = {
    start() {
      timer = setInterval(() => {
        void relay
          .sweep()
          .catch((err: unknown) => logger.warn({ err: (err as Error).message }, 'outbox sweep failed'));
      }, SWEEP_INTERVAL_MS);
      timer.unref();
    },
    async publish(ids) {
      if (ids.length === 0 || stopped) return;
      try {
        await publishLocked((q) => q.where('id', 'in', [...ids]), false);
      } catch (err) {
        logger.warn({ err: (err as Error).message, ids }, 'outbox relay failed; the sweeper retries');
      }
    },
    async sweep() {
      if (stopped || !amqp.connection) return 0;
      return publishLocked((q) => q.orderBy('created_at').limit(SWEEP_BATCH), true);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      const ch = channel;
      channel = null;
      await ch?.then((c) => c.close()).catch(() => undefined);
    },
  };
  return relay;
}
