/**
 * Worker side of the queue (R55, R56, R92, P56; contracts/events/envelope.schema.json): consumes
 * `agrotrace.express.jobs` on two channels, each with basic.qos prefetch 1, and dispatches every envelope to the
 * handler of its `type`.
 *
 * - At most ONE `vsd.import` handler runs per process (it may hold its delivery for about two minutes during a Mercury
 *   outage). A `vsd.import` delivered while the other channel handles one is re-scheduled (P56): the same message is
 *   published to `agrotrace.express.jobs.delay` (infra/rabbitmq/definitions.json: queue TTL 5 s, then it dead-letters
 *   to the TAIL of the jobs queue) as `mandatory` with a publisher confirm, and only then acknowledged (a basic.return
 *   or a negative confirm: not acked, logged, nack-requeued after 1 s as the last resort). The channel is free at once,
 *   so the events behind it keep flowing. A requeue (basic.nack requeue=true) is never the busy path: it puts the message back
 *   at the head, where the only channel with credit receives it again and again (final review I1).
 *   Without the delay queue (a broker that did not load the current definitions) the message is republished to the
 *   tail of the jobs queue after a 1 s pause instead — still never at the head.
 * - A failing handler is retried in-process after 2, 4, 8, 16 and 32 s (each attempt its own transaction — the handler's
 *   business), then the message is rejected without requeue and dead-letters to `agrotrace.express.jobs.dlq`.
 * - Handlers claim the event in `processed_events` themselves, as the first statement of their transaction (R56).
 * - A channel closed by the broker while the connection stays up (consumer_timeout, PRECONDITION_FAILED …) is opened
 *   again after 1 s; a lost connection is handled by infra/amqp.ts (every reconnect opens both channels again).
 * - stop(): cancels both consumers (no new deliveries), waits for the running handlers to settle, then closes.
 */
import type { ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { runWithContext } from '../context.js';
import type { Logger } from '../logger.js';
import { EXCHANGE, JOBS_DELAY_QUEUE, JOBS_QUEUE, type Amqp } from './amqp.js';
import type { EventEnvelope, EventType } from './outbox.js';

export type EventHandler = (event: EventEnvelope) => Promise<void>;

export const HANDLER_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000] as const;
/** Pause before the tail republish when the delay queue is missing (fallback only). */
const VSD_FALLBACK_PAUSE_MS = 1000;
const CHANNEL_REOPEN_MS = 1000;
const CHANNELS = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Consumer {
  stop(): Promise<void>;
}

interface Slot {
  ch: ConfirmChannel;
  tag: string | null;
}

/** The properties of a delivery, to publish it again unchanged (message_id, content type, headers, persistence). */
export function republishOptions(msg: Pick<ConsumeMessage, 'properties'>): Options.Publish {
  const p = msg.properties;
  return {
    persistent: true,
    contentType: p.contentType as string | undefined,
    contentEncoding: p.contentEncoding as string | undefined,
    messageId: p.messageId as string | undefined,
    correlationId: p.correlationId as string | undefined,
    type: p.type as string | undefined,
    appId: p.appId as string | undefined,
    timestamp: p.timestamp as number | undefined,
    headers: p.headers,
  };
}

/** Per channel: message ids the broker returned (basic.return) — a mandatory copy that reached no queue. */
const returnedBy = new WeakMap<ConfirmChannel, Set<string>>();

function confirmed(send: (cb: (err: unknown) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => send((err) => (err ? reject(err) : resolve())));
}

export function startConsumer(deps: {
  amqp: Amqp;
  logger: Logger;
  handlers: Partial<Record<EventType, EventHandler>>;
  retryDelaysMs?: readonly number[];
}): Consumer {
  const { amqp, logger, handlers } = deps;
  const delays = deps.retryDelaysMs ?? HANDLER_RETRY_DELAYS_MS;
  const slots = new Set<Slot>();
  let vsdBusy = false;
  let stopping = false;
  let delayQueue = false;
  const inFlight = new Set<Promise<void>>();

  /** `ok` — ack; `dead` — retries exhausted, reject to the DLQ; `stopped` — the process is stopping (PL13): neither
   * ack nor reject, the broker returns the delivery to the queue when the channel closes. */
  async function runHandler(handler: EventHandler, event: EventEnvelope): Promise<'ok' | 'dead' | 'stopped'> {
    for (let attempt = 0; ; attempt++) {
      try {
        // The handled event's requestId tags the handler's log lines (correlation with the API request, spec 14.5);
        // audit entries stay system (request_id null) and handlers copy it into the events they enqueue themselves.
        await runWithContext({ requestId: null, ip: null, eventRequestId: event.requestId }, () =>
          handler(event),
        );
        return 'ok';
      } catch (err) {
        if (stopping) {
          logger.warn(
            { err: (err as Error).message, eventId: event.id, type: event.type, requestId: event.requestId },
            'event handler failed while stopping; left to the broker',
          );
          return 'stopped';
        }
        if (attempt >= delays.length) {
          logger.error(
            { err, eventId: event.id, type: event.type, requestId: event.requestId },
            'event handler failed; dead-lettering',
          );
          return 'dead';
        }
        logger.warn(
          {
            err: (err as Error).message,
            eventId: event.id,
            type: event.type,
            attempt: attempt + 1,
            requestId: event.requestId,
          },
          'event handler failed; retrying',
        );
        await sleep(delays[attempt]!);
      }
    }
  }

  /** Whether the broker has the delay queue (checked once per connection, on a throwaway channel). */
  async function hasDelayQueue(conn: ChannelModel): Promise<boolean> {
    let ch;
    try {
      ch = await conn.createChannel();
      ch.on('error', () => undefined);
      await ch.checkQueue(JOBS_DELAY_QUEUE);
      return true;
    } catch {
      logger.error(
        { queue: JOBS_DELAY_QUEUE },
        'delay queue missing (infra/rabbitmq/definitions.json not loaded); a busy vsd.import goes to the tail instead',
      );
      return false;
    } finally {
      await ch?.close().catch(() => undefined);
    }
  }

  /** P56: the busy `vsd.import` leaves this channel at once and comes back at the tail of the queue later. */
  async function reschedule(ch: ConfirmChannel, msg: ConsumeMessage, event: EventEnvelope): Promise<void> {
    // mandatory (final re-review m1): a copy that reaches no queue (delay queue deleted, binding missing) comes back
    // as basic.return before its confirm — a failure, never acknowledged as re-scheduled.
    const messageId = (msg.properties.messageId as string | undefined) ?? event.id;
    const opts = { ...republishOptions(msg), messageId, mandatory: true };
    if (delayQueue) {
      await confirmed((cb) => ch.sendToQueue(JOBS_DELAY_QUEUE, msg.content, opts, cb));
    } else {
      await sleep(VSD_FALLBACK_PAUSE_MS);
      await confirmed((cb) => ch.publish(EXCHANGE, event.type, msg.content, opts, cb));
    }
    if (returnedBy.get(ch)?.delete(messageId)) throw new Error('copy unroutable (basic.return)');
    // Acknowledged only after the broker confirmed the copy: a crash in between leaves a duplicate, never a loss
    // (the handler's processed_events claim absorbs it).
    ch.ack(msg);
    logger.debug({ eventId: event.id, delayQueue }, 'vsd.import busy; re-scheduled');
  }

  async function onMessage(ch: ConfirmChannel, msg: ConsumeMessage): Promise<void> {
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
      try {
        await reschedule(ch, msg, event);
      } catch (err) {
        // The copy was refused (nack) or returned unroutable: the delivery is not acknowledged. Last resort (a
        // broker-side failure only): after a 1 s pause it is nack-requeued.
        logger.error(
          { err: (err as Error).message, eventId: event.id },
          'vsd.import re-schedule failed; requeueing',
        );
        await sleep(VSD_FALLBACK_PAUSE_MS);
        try {
          ch.nack(msg, false, true);
        } catch {
          // The channel is gone: the broker requeues the unacknowledged delivery itself.
        }
      }
      return;
    }
    if (isVsd) vsdBusy = true;
    try {
      const outcome = await runHandler(handler, event);
      if (outcome === 'ok') ch.ack(msg);
      else if (outcome === 'dead') ch.reject(msg, false);
    } finally {
      if (isVsd) vsdBusy = false;
    }
  }

  function reopenLater(conn: ChannelModel, n: number): void {
    if (stopping || amqp.connection !== conn) return;
    setTimeout(() => void openChannel(conn, n), CHANNEL_REOPEN_MS).unref();
  }

  async function openChannel(conn: ChannelModel, n: number): Promise<void> {
    if (stopping || amqp.connection !== conn) return;
    try {
      const ch = await conn.createConfirmChannel();
      const slot: Slot = { ch, tag: null };
      const returned = new Set<string>();
      returnedBy.set(ch, returned);
      ch.on('return', (m: ConsumeMessage) => {
        const id = m.properties.messageId as string | undefined;
        if (id) returned.add(id);
      });
      ch.on('error', (err: Error) => logger.warn({ err: err.message, channel: n }, 'consumer channel error'));
      ch.on('close', () => {
        slots.delete(slot);
        if (stopping || amqp.connection !== conn) return;
        logger.warn({ channel: n }, 'consumer channel closed while the connection is up; reopening');
        reopenLater(conn, n);
      });
      slots.add(slot);
      await ch.prefetch(1);
      const { consumerTag } = await ch.consume(JOBS_QUEUE, (msg) => {
        if (!msg) return;
        const p = onMessage(ch, msg).catch((err: unknown) =>
          logger.error({ err }, 'queue message handling crashed'),
        );
        inFlight.add(p);
        void p.finally(() => inFlight.delete(p));
      });
      slot.tag = consumerTag;
      logger.info({ queue: JOBS_QUEUE, channel: n }, 'worker consuming');
    } catch (err) {
      logger.warn({ err: (err as Error).message, channel: n }, 'consumer channel setup failed');
      reopenLater(conn, n);
    }
  }

  amqp.onConnect((conn) => {
    if (stopping) return;
    void (async () => {
      delayQueue = await hasDelayQueue(conn);
      for (let n = 1; n <= CHANNELS; n++) await openChannel(conn, n);
    })();
  });

  return {
    async stop() {
      stopping = true;
      // No new deliveries; the running handlers settle theirs on open channels; then close.
      await Promise.allSettled([...slots].map((s) => (s.tag ? s.ch.cancel(s.tag) : undefined)));
      await Promise.allSettled([...inFlight]);
      await Promise.allSettled([...slots].map((s) => s.ch.close()));
    },
  };
}
