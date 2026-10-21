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
 * Every event type of the envelope is relayed (the worker has a handler for each). Retention (R59): the sweeper pass
 * also deletes this backend's `outbox_events` published more than 7 days ago and its `processed_events` older than
 * 30 days.
 *
 * Callers: the API publishes the ids a request collected right after its response (app.ts `publishAfterResponse`,
 * context.ts) and some operations publish explicitly after their commit; worker handlers publish the rows they wrote;
 * scheduler jobs leave theirs to the sweeper. A second publish of the same id finds the row published (or locked)
 * and does nothing.
 */
import { sql, type Transaction } from 'kysely';
import type { ConfirmChannel } from 'amqplib';
import type { RequestHandler } from 'express';
import { currentContext } from '../context.js';
import type { Db } from '../db/db.js';
import type { DB } from '../db/types.generated.js';
import type { Logger } from '../logger.js';
import { EXCHANGE, type Amqp } from './amqp.js';

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
      if (advisory) {
        // R59 retention, under the same sweeper lock.
        await sql`DELETE FROM outbox_events
                   WHERE backend = 'express' AND published_at < now() - interval '7 days'`.execute(tx);
        await sql`DELETE FROM processed_events
                   WHERE backend = 'express' AND processed_at < now() - interval '30 days'`.execute(tx);
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

/**
 * Publishes the outbox rows a request wrote (`enqueue` collects their ids in the request context) once the response
 * has gone out — every transaction of the request has committed by then (handlers answer after `withTx` resolves).
 */
export function publishAfterResponse(relay: OutboxRelay): RequestHandler {
  return (_req, res, next) => {
    const ctx = currentContext();
    res.on('close', () => {
      const ids = ctx?.events ?? [];
      if (ids.length > 0) void relay.publish(ids.splice(0));
    });
    next();
  };
}
