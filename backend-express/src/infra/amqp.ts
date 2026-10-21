/**
 * RabbitMQ connection (R55 topology from infra/rabbitmq/definitions.json — nothing is declared here): connects in the
 * background, reconnects with backoff after a drop, never crashes the process. The API uses it for the outbox relay
 * (Task 12) and readiness; the worker consumes `agrotrace.express.jobs`.
 */
import amqp, { type ChannelModel, type Channel } from 'amqplib';
import type { Logger } from '../logger.js';

export const EXCHANGE = 'agrotrace.express';
export const JOBS_QUEUE = 'agrotrace.express.jobs';
/** P56: a busy `vsd.import` waits here (queue TTL 5 s), then dead-letters to the tail of JOBS_QUEUE. */
export const JOBS_DELAY_QUEUE = 'agrotrace.express.jobs.delay';

export class Amqp {
  private conn: ChannelModel | null = null;
  private closing = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(conn: ChannelModel) => void>();

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
    private readonly name: string,
  ) {}

  start(): void {
    void this.connect();
  }

  /** Called with every new connection (the first one and each reconnect). */
  onConnect(fn: (conn: ChannelModel) => void): void {
    this.listeners.add(fn);
    if (this.conn) fn(this.conn);
  }

  get connection(): ChannelModel | null {
    return this.conn;
  }

  private async connect(): Promise<void> {
    if (this.closing) return;
    try {
      const conn = await amqp.connect(this.url, { clientProperties: { connection_name: this.name } });
      if (this.closing) {
        await conn.close().catch(() => undefined);
        return;
      }
      conn.on('error', (err: Error) => this.logger.warn({ err: err.message }, 'rabbitmq connection error'));
      conn.on('close', () => {
        this.conn = null;
        if (!this.closing) {
          this.logger.warn('rabbitmq connection closed; reconnecting');
          this.schedule();
        }
      });
      this.conn = conn;
      if (this.attempt > 0) this.logger.info('rabbitmq reconnected');
      this.attempt = 0;
      for (const fn of this.listeners) fn(conn);
    } catch (err) {
      if (this.attempt === 0)
        this.logger.warn({ err: (err as Error).message }, 'rabbitmq unavailable; retrying');
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.closing || this.timer) return;
    const delay = Math.min(500 * 2 ** this.attempt, 10_000);
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  /** Readiness: an open connection on which our exchange exists (a throwaway channel, closed right after). */
  async ping(): Promise<void> {
    const conn = this.conn;
    if (!conn) throw new Error('rabbitmq not connected');
    let ch: Channel | null = null;
    try {
      ch = await conn.createChannel();
      ch.on('error', () => undefined);
      await ch.checkExchange(EXCHANGE);
    } finally {
      await ch?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const conn = this.conn;
    this.conn = null;
    await conn?.close().catch(() => undefined);
  }
}
