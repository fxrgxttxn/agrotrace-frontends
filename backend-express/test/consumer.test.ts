/**
 * The worker consumer (R92, P56, final review I1/M4) on a fake broker: a busy `vsd.import` is copied to the delay
 * queue (confirmed) and acknowledged — never nack-requeued — so other events keep flowing; without the delay queue it
 * goes to the tail of the jobs queue; a channel the broker closes is reopened; stop() cancels the consumers first and
 * lets running handlers acknowledge before the channels close. tests/api/documents.test.ts covers it on the stand.
 */
import { describe, expect, it } from 'vitest';
import { startConsumer } from '../src/infra/consumer.js';
import type { Amqp } from '../src/infra/amqp.js';
import type { EventEnvelope } from '../src/infra/outbox.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger({ level: 'silent', process: 'worker' }, { write: () => undefined });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

interface Msg {
  content: Buffer;
  properties: Record<string, unknown>;
}

function envelope(id: string, type: string): Msg {
  const e = { id, type, occurredAt: new Date().toISOString(), backend: 'express', requestId: null, data: {} };
  return {
    content: Buffer.from(JSON.stringify(e)),
    properties: { messageId: id, contentType: 'application/json', headers: {} },
  };
}

/** A fake connection: every channel records what the consumer does with it. */
function fakeBroker(opts: { delayQueue?: boolean } = {}) {
  const log: string[] = [];
  const channels: ReturnType<typeof channel>[] = [];
  function channel(n: number) {
    const handlers: Record<string, (() => void)[]> = {};
    const ch = {
      n,
      deliver: null as ((m: Msg) => void) | null,
      on: (ev: string, fn: () => void) => void (handlers[ev] ??= []).push(fn),
      emit: (ev: string) => handlers[ev]?.forEach((fn) => fn()),
      prefetch: async () => undefined,
      consume: async (_q: string, cb: (m: Msg) => void) => {
        ch.deliver = cb;
        return { consumerTag: `tag-${n}` };
      },
      checkQueue: async (q: string) => {
        if (!opts.delayQueue) throw new Error(`NOT_FOUND - no queue '${q}'`);
        return {};
      },
      sendToQueue: (q: string, _c: Buffer, o: { messageId?: string }, cb: (e: unknown) => void) => {
        log.push(`ch${n} sendToQueue ${q} ${o.messageId}`);
        setImmediate(() => cb(null));
        return true;
      },
      publish: (ex: string, rk: string, _c: Buffer, o: { messageId?: string }, cb: (e: unknown) => void) => {
        log.push(`ch${n} publish ${ex} ${rk} ${o.messageId}`);
        setImmediate(() => cb(null));
        return true;
      },
      ack: (m: Msg) => void log.push(`ch${n} ack ${m.properties.messageId}`),
      reject: (m: Msg) => void log.push(`ch${n} reject ${m.properties.messageId}`),
      nack: (m: Msg) => void log.push(`ch${n} nack ${m.properties.messageId}`),
      cancel: async (tag: string) => void log.push(`cancel ${tag}`),
      close: async () => {
        if (n > 0) log.push(`ch${n} close`);
        ch.emit('close');
      },
    };
    return ch;
  }
  let count = 0;
  const conn = {
    createChannel: async () => channel(0),
    createConfirmChannel: async () => {
      const ch = channel(++count);
      channels.push(ch);
      return ch;
    },
  };
  const amqp = { connection: conn, onConnect: (fn: (c: unknown) => void) => fn(conn) } as unknown as Amqp;
  return { amqp, log, channels };
}

describe('worker consumer (R92, P56)', () => {
  it('a busy vsd.import is copied to the delay queue, then acked; other events keep flowing; never a nack', async () => {
    const broker = fakeBroker({ delayQueue: true });
    let finishVsd!: () => void;
    const handled: string[] = [];
    startConsumer({
      amqp: broker.amqp,
      logger,
      handlers: {
        'vsd.import': (e: EventEnvelope) =>
          new Promise<void>((r) => {
            handled.push(e.id);
            finishVsd = r;
          }),
        'notification.dispatch': async (e: EventEnvelope) => void handled.push(e.id),
      },
    });
    await tick();
    const [a, b] = broker.channels;
    a!.deliver!(envelope('vsd-1', 'vsd.import'));
    await tick();
    b!.deliver!(envelope('vsd-2', 'vsd.import'));
    await tick();
    b!.deliver!(envelope('notif-1', 'notification.dispatch'));
    await tick();
    expect(handled).toEqual(['vsd-1', 'notif-1']);
    expect(broker.log).toEqual([
      'ch2 sendToQueue agrotrace.express.jobs.delay vsd-2',
      'ch2 ack vsd-2',
      'ch2 ack notif-1',
    ]);
    finishVsd();
    await tick();
    expect(broker.log.at(-1)).toBe('ch1 ack vsd-1');
    expect(broker.log.some((l) => l.includes('nack'))).toBe(false);
  });

  it('without the delay queue a busy vsd.import is republished to the tail of the jobs queue (exchange), then acked', async () => {
    const broker = fakeBroker({ delayQueue: false });
    startConsumer({
      amqp: broker.amqp,
      logger,
      handlers: { 'vsd.import': () => new Promise<void>(() => undefined) },
    });
    await tick();
    const [a, b] = broker.channels;
    a!.deliver!(envelope('vsd-1', 'vsd.import'));
    await tick();
    b!.deliver!(envelope('vsd-2', 'vsd.import'));
    await tick(1200);
    expect(broker.log).toEqual(['ch2 publish agrotrace.express vsd.import vsd-2', 'ch2 ack vsd-2']);
  });

  it('a channel closed by the broker is reopened; stop() cancels, waits for the running handler, then closes', async () => {
    const broker = fakeBroker({ delayQueue: true });
    let finish!: () => void;
    const consumer = startConsumer({
      amqp: broker.amqp,
      logger,
      handlers: { 'rating.recalculate': () => new Promise<void>((r) => (finish = r)) },
    });
    await tick();
    expect(broker.channels.length).toBe(2);
    broker.channels[1]!.emit('close');
    await tick(1100);
    expect(broker.channels.length).toBe(3);

    broker.channels[0]!.deliver!(envelope('r-1', 'rating.recalculate'));
    await tick();
    broker.log.length = 0;
    const stopped = consumer.stop();
    await tick();
    expect(broker.log).toEqual(['cancel tag-1', 'cancel tag-3']);
    finish();
    await stopped;
    expect(broker.log).toEqual(['cancel tag-1', 'cancel tag-3', 'ch1 ack r-1', 'ch1 close', 'ch3 close']);
  });
});
