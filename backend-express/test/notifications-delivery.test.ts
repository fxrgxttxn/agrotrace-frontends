/**
 * Delivery of PENDING notification rows (contracts/events/notification.dispatch.schema.json) and the Telegram client /
 * poller (infra/telegram.ts). Not observable over HTTP: the test stand has no bot token in the worker and no Telegram
 * account can be linked without a real bot, so NOT_CONFIGURED, the retry budget and the `/start <code>` linking are
 * proven here; the EMAIL path end to end (Mailpit) is in tests/api/notifications.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { sendRow, DELIVERY_DELAYS_MS, type DeliveryRow } from '../src/modules/notifications/delivery.js';
import {
  createTelegram,
  startTelegramPoller,
  type Telegram,
  type TelegramUpdate,
} from '../src/infra/telegram.js';
import { memoryLogger } from './helpers.js';

const row = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  id: 'n1',
  type: 'RECALL_TASK',
  payload: {
    recallId: 'r1',
    taskId: 't1',
    batchId: 'b1',
    publicCode: 'AT-2026-000123',
    dueAt: '2026-09-25T15:00:00Z',
    event: 'CREATED',
  },
  channel: 'EMAIL',
  email: 'u@example.test',
  telegram_chat_id: null,
  ...over,
});

const offTelegram: Pick<Telegram, 'configured' | 'sendMessage'> = {
  configured: false,
  sendMessage: () => Promise.reject(new Error('must not be called')),
};

describe('sendRow', () => {
  it('TELEGRAM without a bot token → NOT_CONFIGURED without an attempt', async () => {
    const sendMessage = vi.fn();
    const out = await sendRow(row({ channel: 'TELEGRAM', telegram_chat_id: '42' }), {
      mailer: { configured: true, sendOnce: vi.fn() },
      telegram: { configured: false, sendMessage },
      logger: memoryLogger().logger,
    });
    expect(out).toEqual({ status: 'NOT_CONFIGURED', attempts: 0 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('EMAIL: the i18n letter, first attempt → DELIVERED, attempts 1', async () => {
    const sendOnce = vi.fn().mockResolvedValue(undefined);
    const out = await sendRow(row(), {
      mailer: { configured: true, sendOnce },
      telegram: offTelegram,
      logger: memoryLogger().logger,
    });
    expect(out).toEqual({ status: 'DELIVERED', attempts: 1 });
    const letter = sendOnce.mock.calls[0]![0] as { to: string; subject: string; text: string };
    expect(letter.to).toBe('u@example.test');
    expect(letter.subject).toContain('AT-2026-000123');
    expect(letter.subject).not.toContain('notification.');
    expect(letter.text).toContain('AT-2026-000123');
  });

  it('3 attempts with waits of 1 s and 2 s; success on the third → DELIVERED 3; three failures → FAILED 3', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue(undefined);
    expect(
      await sendRow(row(), {
        mailer: { configured: true, sendOnce: flaky },
        telegram: offTelegram,
        logger: memoryLogger().logger,
        sleep,
      }),
    ).toEqual({ status: 'DELIVERED', attempts: 3 });
    expect(waits).toEqual([DELIVERY_DELAYS_MS[0], DELIVERY_DELAYS_MS[1]]);
    waits.length = 0;
    const down = vi.fn().mockRejectedValue(new Error('smtp down'));
    expect(
      await sendRow(row(), {
        mailer: { configured: true, sendOnce: down },
        telegram: offTelegram,
        logger: memoryLogger().logger,
        sleep,
      }),
    ).toEqual({ status: 'FAILED', attempts: 3 });
    expect(down).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it('TELEGRAM with a token: sendMessage(chat, text); an unlinked user (chat id gone) → FAILED without an attempt', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const telegram = { configured: true, sendMessage };
    const deps = { mailer: { configured: true, sendOnce: vi.fn() }, telegram, logger: memoryLogger().logger };
    expect(await sendRow(row({ channel: 'TELEGRAM', telegram_chat_id: '42' }), deps)).toEqual({
      status: 'DELIVERED',
      attempts: 1,
    });
    expect(sendMessage.mock.calls[0]![0]).toBe('42');
    expect(sendMessage.mock.calls[0]![1]).toContain('AT-2026-000123');
    expect(await sendRow(row({ channel: 'TELEGRAM' }), deps)).toEqual({ status: 'FAILED', attempts: 0 });
  });
});

describe('sendRow: configuration and a taken-over budget (P49)', () => {
  it('EMAIL without SMTP_HOST → NOT_CONFIGURED without an attempt', async () => {
    const sendOnce = vi.fn();
    expect(
      await sendRow(row(), {
        mailer: { configured: false, sendOnce },
        telegram: offTelegram,
        logger: memoryLogger().logger,
      }),
    ).toEqual({ status: 'NOT_CONFIGURED', attempts: 0 });
    expect(sendOnce).not.toHaveBeenCalled();
  });

  it('a row taken over after 2 attempts gets one more; progress is stored after each failure but the last', async () => {
    const progress: number[] = [];
    const down = vi.fn().mockRejectedValue(new Error('down'));
    const deps = {
      mailer: { configured: true, sendOnce: down },
      telegram: offTelegram,
      logger: memoryLogger().logger,
      sleep: async () => undefined,
      onFailure: async (n: number) => void progress.push(n),
    };
    expect(await sendRow(row({ attempts: 2 }), deps)).toEqual({ status: 'FAILED', attempts: 3 });
    expect(down).toHaveBeenCalledTimes(1);
    expect(await sendRow(row({ attempts: 0 }), deps)).toEqual({ status: 'FAILED', attempts: 3 });
    expect(progress).toEqual([1, 2]);
    expect(await sendRow(row({ attempts: 3 }), deps)).toEqual({ status: 'FAILED', attempts: 3 });
  });
});

describe('createTelegram', () => {
  it('not configured without a token; sendMessage posts JSON to /bot<token>/sendMessage; ok:false rejects', async () => {
    expect(createTelegram({ token: undefined, apiUrl: 'http://tg' }).configured).toBe(false);
    const calls: { url: string; body: unknown }[] = [];
    let reply = { ok: true, result: {} };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    const tg = createTelegram({ token: 'T0K', apiUrl: 'http://tg', fetchImpl });
    expect(tg.configured).toBe(true);
    await tg.sendMessage('42', 'привет');
    expect(calls[0]).toEqual({
      url: 'http://tg/botT0K/sendMessage',
      body: { chat_id: '42', text: 'привет' },
    });
    reply = { ok: false, result: {} };
    await expect(tg.sendMessage('42', 'x')).rejects.toThrow();
  });
});

describe('startTelegramPoller', () => {
  it('takes tg:poller (SET NX EX 30), links `/start <code>`, confirms the offset; stop hands the key over', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
    };
    const offsets: (number | undefined)[] = [];
    let served = false;
    const telegram: Telegram = {
      configured: true,
      sendMessage: vi.fn(),
      async getUpdates(offset, _timeout, signal) {
        offsets.push(offset);
        if (!served) {
          served = true;
          return [
            { update_id: 7, message: { text: '/start ABC123', chat: { id: 4242 } } },
            { update_id: 8, message: { text: 'hello', chat: { id: 1 } } },
          ] satisfies TelegramUpdate[];
        }
        await new Promise((_r, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
        return [];
      },
    };
    const link = vi.fn().mockResolvedValue(true);
    const poller = startTelegramPoller({
      db: {} as never,
      redis: redis as never,
      telegram,
      logger: memoryLogger().logger,
      idleMs: 10,
      link,
    });
    await vi.waitFor(() => expect(offsets.length).toBeGreaterThanOrEqual(2));
    expect(redis.set).toHaveBeenCalledWith('tg:poller', expect.any(String), 'EX', 30, 'NX');
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith('ABC123', '4242');
    expect(offsets.slice(0, 2)).toEqual([undefined, 9]);
    await poller.stop();
    const del = redis.eval.mock.calls.at(-1)!;
    expect(String(del[0])).toContain("redis.call('DEL'");
  });

  it('does nothing without a bot token', async () => {
    const redis = { set: vi.fn(), eval: vi.fn().mockResolvedValue(0) };
    const poller = startTelegramPoller({
      db: {} as never,
      redis: redis as never,
      telegram: createTelegram({ token: undefined, apiUrl: 'http://tg' }),
      logger: memoryLogger().logger,
    });
    await poller.stop();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
