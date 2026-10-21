/**
 * Telegram Bot API (FR-NOTIF-02): `sendMessage` for notification delivery and the `getUpdates` poller that links
 * accounts (`/start <code>`, contract info.description: shared Redis keys `tgcode:{code}`, `tg:poller`).
 *
 * Without `TELEGRAM_BOT_TOKEN` the client is not configured: TELEGRAM notification rows end NOT_CONFIGURED without an
 * attempt (contracts/events/notification.dispatch.schema.json) and no poller runs.
 *
 * Poller: only the worker holding `tg:poller` polls — `SET tg:poller <instance> NX EX 30`, renewed every 10 s by the
 * owner with the contract's Lua compare-and-PEXPIRE (0 → ownership lost, polling stops and the worker competes for
 * the key again). The offset (`last update_id + 1`) is confirmed on Telegram's side by the next `getUpdates`, so a
 * new owner continues where the previous one stopped; a message seen twice is harmless (`GETDEL` of the code).
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Db } from '../db/db.js';
import type { Logger } from '../logger.js';

export interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id?: number | string } };
}

export interface Telegram {
  readonly configured: boolean;
  /** One attempt; rejects on a transport error or `ok: false`. */
  sendMessage(chatId: string, text: string): Promise<void>;
  getUpdates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
}

export function createTelegram(opts: {
  token: string | undefined;
  apiUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Telegram {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  async function call<T>(method: string, body: unknown, timeout: number, signal?: AbortSignal): Promise<T> {
    if (!opts.token) throw new Error('telegram is not configured');
    const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
    const res = await doFetch(`${opts.apiUrl}/bot${opts.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
    } | null;
    if (!res.ok || !json?.ok)
      throw new Error(`telegram ${method}: ${res.status} ${json?.description ?? ''}`.trim());
    return json.result as T;
  }
  return {
    configured: Boolean(opts.token),
    async sendMessage(chatId, text) {
      await call('sendMessage', { chat_id: chatId, text }, timeoutMs);
    },
    getUpdates(offset, timeoutSec, signal) {
      return call<TelegramUpdate[]>(
        'getUpdates',
        { ...(offset !== undefined && { offset }), timeout: timeoutSec, allowed_updates: ['message'] },
        (timeoutSec + 10) * 1000,
        signal,
      );
    },
  };
}

/** The contract's renewal script (shared Redis keys table, `tg:poller`). */
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], 30000) end return 0`;
const START = /^\/start(?:@\w+)?\s+(\S+)\s*$/;

export interface TelegramPoller {
  stop(): Promise<void>;
}

/** Links a chat: `GETDEL tgcode:{code}` (contract, one-time) → `users.telegram_chat_id`. Exported for tests. */
export async function linkByCode(
  deps: { db: Db; redis: Redis; logger: Logger },
  code: string,
  chatId: string,
): Promise<boolean> {
  const raw = await deps.redis.getdel(`tgcode:${code}`);
  if (raw === null) return false;
  let userId: unknown;
  try {
    userId = (JSON.parse(raw) as { userId?: unknown }).userId;
  } catch {
    return false;
  }
  if (typeof userId !== 'string') return false;
  const r = await deps.db
    .updateTable('users')
    .set({ telegram_chat_id: chatId })
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) === 0) return false;
  deps.logger.info({ userId }, 'telegram linked');
  return true;
}

export function startTelegramPoller(deps: {
  db: Db;
  redis: Redis;
  telegram: Telegram;
  logger: Logger;
  /** Pause between attempts to take the key / after a failed poll. */
  idleMs?: number;
  /** Linking (tests); default `linkByCode`. */
  link?: (code: string, chatId: string) => Promise<boolean>;
}): TelegramPoller {
  const { redis, telegram, logger } = deps;
  const idleMs = deps.idleMs ?? 10_000;
  const link = deps.link ?? ((code: string, chatId: string) => linkByCode(deps, code, chatId));
  const instance = randomUUID();
  let stopping = false;
  let abort: AbortController | null = null;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  async function ownLoop(): Promise<void> {
    let owner = true;
    const renew = setInterval(() => {
      void (redis.eval(RENEW, 1, 'tg:poller', instance) as Promise<number>).then(
        (n) => {
          if (Number(n) === 0) {
            owner = false;
            abort?.abort();
          }
        },
        () => undefined,
      );
    }, 10_000);
    let offset: number | undefined;
    try {
      while (!stopping && owner) {
        abort = new AbortController();
        try {
          const started = Date.now();
          const updates = await telegram.getUpdates(offset, 25, abort.signal);
          for (const u of updates) {
            const m = START.exec(u.message?.text ?? '');
            const chat = u.message?.chat?.id;
            // The offset moves past an update only once it was handled (a failed link is seen again).
            if (m && chat !== undefined) await link(m[1]!, String(chat));
            offset = u.update_id + 1;
          }
          // A Bot API (or stub) answering an empty long poll at once must not spin the loop.
          if (updates.length === 0 && Date.now() - started < 1000) await sleep(1000);
        } catch (err) {
          if (stopping || !owner) break;
          logger.warn({ err: (err as Error).message }, 'telegram poll failed');
          await sleep(idleMs);
        }
      }
    } finally {
      clearInterval(renew);
      abort = null;
    }
  }

  const done = (async () => {
    if (!telegram.configured) return;
    while (!stopping) {
      try {
        const got = await redis.set('tg:poller', instance, 'EX', 30, 'NX');
        if (got === 'OK') await ownLoop();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'telegram poller lock failed');
      }
      if (!stopping) await sleep(idleMs);
    }
  })();

  return {
    async stop() {
      stopping = true;
      abort?.abort();
      wake?.();
      await done;
      // Hand the key over at once (only when still ours).
      await redis
        .eval(
          `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
          1,
          'tg:poller',
          instance,
        )
        .catch(() => undefined);
    },
  };
}
