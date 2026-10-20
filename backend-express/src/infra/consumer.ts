/**
 * Worker side of the queue (R55, R56, R92; contracts/events/envelope.schema.json): consumes `agrotrace.express.jobs`
 * on two channels, each with basic.qos prefetch 1, and dispatches every envelope to the handler of its `type`.
 *
 * - At most ONE `vsd.import` handler runs per process (it may hold its delivery for about two minutes during a Mercury
 *   outage): a `vsd.import` delivered while the other channel handles one is returned with basic.nack requeue=true
 *   after a 1 s pause, so one channel always keeps handling the other event types.
 * - A failing handler is retried in-process after 2, 4, 8, 16 and 32 s (each attempt its own transaction — the handler's
 *   business), then the message is rejected without requeue and dead-letters to `agrotrace.express.jobs.dlq`.
 * - Handlers claim the event in `processed_events` themselves, as the first statement of their transaction (R56).
 *
 * Task 6 registers `vsd.import`, Task 10 `recall.requested` and `rating.recalculate`; Task 12 adds the other handlers
 * (the relay publishes only registered types until then, infra/relay.ts).
 */
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from '../logger.js';
import { JOBS_QUEUE, type Amqp } from './amqp.js';
import type { EventEnvelope, EventType } from './outbox.js';

export type EventHandler = (event: EventEnvelope) => Promise<void>;

export const HANDLER_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000] as const;
const VSD_BUSY_PAUSE_MS = 1000;
const CHANNELS = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Consumer {
  stop(): Promise<void>;
}

export function startConsumer(deps: {
  amqp: Amqp;
  logger: Logger;
  handlers: Partial<Record<EventType, EventHandler>>;
  retryDelaysMs?: readonly number[];
}): Consumer {
  const { amqp, logger, handlers } = deps;
  const delays = deps.retryDelaysMs ?? HANDLER_RETRY_DELAYS_MS;
  let channels: Channel[] = [];
  let vsdBusy = false;
  let stopping = false;
  const inFlight = new Set<Promise<void>>();

  async function runHandler(handler: EventHandler, event: EventEnvelope): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await handler(event);
        return true;
      } catch (err) {
        if (attempt >= delays.length || stopping) {
          logger.error({ err, eventId: event.id, type: event.type }, 'event handler failed; dead-lettering');
          return false;
        }
        logger.warn(
          { err: (err as Error).message, eventId: event.id, type: event.type, attempt: attempt + 1 },
          'event handler failed; retrying',
        );
        await sleep(delays[attempt]!);
      }
    }
  }

  async function onMessage(ch: Channel, msg: ConsumeMessage): Promise<void> {
    let event: EventEnvelope;
    try {
      event = JSON.parse(msg.content.toString('utf8')) as EventEnvelope;
      if (typeof event?.id !== 'string' || typeof event.type !== 'string') throw new Error('not an envelope');
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'unreadable queue message; dead-lettering');
      ch.reject(msg, false);
      return;
    }
    const handler = handlers[event.type];
    if (!handler) {
      logger.error({ eventId: event.id, type: event.type }, 'no handler for the event type; dead-lettering');
      ch.reject(msg, false);
      return;
    }
    const isVsd = event.type === 'vsd.import';
    if (isVsd && vsdBusy) {
      await sleep(VSD_BUSY_PAUSE_MS);
      ch.nack(msg, false, true);
      return;
    }
    if (isVsd) vsdBusy = true;
    try {
      const ok = await runHandler(handler, event);
      if (ok) ch.ack(msg);
      else ch.reject(msg, false);
    } finally {
      if (isVsd) vsdBusy = false;
    }
  }

  amqp.onConnect((conn) => {
    if (stopping) return;
    channels = [];
    for (let i = 0; i < CHANNELS; i++) {
      void (async () => {
        try {
          const ch = await conn.createChannel();
          ch.on('error', (err: Error) => logger.warn({ err: err.message }, 'consumer channel error'));
          await ch.prefetch(1);
          await ch.consume(JOBS_QUEUE, (msg) => {
            if (!msg) return;
            const p = onMessage(ch, msg).catch((err: unknown) =>
              logger.error({ err }, 'queue message handling crashed'),
            );
            inFlight.add(p);
            void p.finally(() => inFlight.delete(p));
          });
          channels.push(ch);
          logger.info({ queue: JOBS_QUEUE, channel: i + 1 }, 'worker consuming');
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'consumer channel setup failed');
        }
      })();
    }
  });

  return {
    async stop() {
      stopping = true;
      await Promise.allSettled(channels.map((ch) => ch.close()));
      await Promise.allSettled([...inFlight]);
    },
  };
}
