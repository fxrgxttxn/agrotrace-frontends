/**
 * Idempotency-Key middleware (R48, R53) over an in-memory store: what tests/api cannot provoke over HTTP — a 5xx frees
 * the key (the repeat executes again), a 2xx is stored before the response leaves (an immediate repeat replays), a
 * client that disconnects mid-operation frees nothing (a retry is 409 IN_PROGRESS until the owner finishes, then it
 * replays the owner's stored result). The Redis store's Lua scripts are covered by tests/api.
 */
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { ah } from '../src/http/async.js';
import { idempotency, requestFingerprint, type IdemRecord, type IdemStore } from '../src/http/idempotency.js';
import { problemHandler } from '../src/http/problem.js';
import { memoryLogger } from './helpers.js';

function memoryStore() {
  const m = new Map<string, IdemRecord>();
  const store: IdemStore = {
    async claim(key, fingerprint) {
      if (m.has(key)) return false;
      m.set(key, { fingerprint, state: 'pending' });
      return true;
    },
    async get(key) {
      return m.get(key) ?? null;
    },
    async complete(key, fingerprint, status, body) {
      const r = m.get(key);
      if (!r || r.fingerprint !== fingerprint || r.state !== 'pending') return false;
      m.set(key, { fingerprint, state: 'done', status, body });
      return true;
    },
    async release(key, fingerprint) {
      const r = m.get(key);
      if (!r || r.fingerprint !== fingerprint || r.state !== 'pending') return false;
      m.delete(key);
      return true;
    },
  };
  return { m, store };
}

type Outcome = { status: number; body?: unknown } | 'crash';

function app(store: IdemStore, handler: (n: number) => Outcome | Promise<Outcome>) {
  const { logger } = memoryLogger();
  const c = { logger } as unknown as Container;
  const a = express();
  a.use(
    express.json({
      verify: (req, _res, buf) => void ((req as unknown as { rawBody: Buffer }).rawBody = buf),
    }),
  );
  a.use((_req, res, next) => {
    res.locals.principal = { userId: 'u1', orgId: 'o1', roles: ['FARMER'], orgAdmin: false };
    next();
  });
  let calls = 0;
  a.post(
    '/op',
    idempotency(c, store),
    ah(async (_req, res) => {
      calls++;
      const r = await handler(calls);
      if (r === 'crash') throw new Error('boom');
      res.status(r.status).json(r.body ?? {});
    }),
  );
  a.use(problemHandler(logger));
  return { a, calls: () => calls };
}

describe('idempotency middleware', () => {
  it('missing or malformed key → 400 INVALID_IDEMPOTENCY_KEY, the handler does not run', async () => {
    const { store } = memoryStore();
    const { a, calls } = app(store, () => ({ status: 200 }));
    for (const key of [undefined, 'short', 'bad key!!']) {
      const r = request(a).post('/op').send({ x: 1 });
      const res = await (key ? r.set('Idempotency-Key', key) : r);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
    }
    expect(calls()).toBe(0);
  });

  it('a 5xx frees the key: the repeat executes again and its 2xx is replayed afterwards', async () => {
    const { m, store } = memoryStore();
    const { a, calls } = app(store, (n) => (n === 1 ? 'crash' : { status: 201, body: { n } }));
    const send = () => request(a).post('/op').set('Idempotency-Key', 'key-12345678').send({ x: 1 });
    const first = await send();
    expect(first.status).toBe(500);
    expect(m.size).toBe(0);
    const second = await send();
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    const third = await send();
    expect(third.status).toBe(201);
    expect(third.headers['idempotent-replayed']).toBe('true');
    expect(third.body).toEqual({ n: 2 });
    expect(calls()).toBe(2);
    expect(m.get('idem:u1:key-12345678')).toEqual({
      fingerprint: requestFingerprint('POST', '/op', Buffer.from('{"x":1}')),
      state: 'done',
      status: 201,
      body: { n: 2 },
    });
  });

  it('a 4xx frees the key too; a different body with a stored key → 409 REUSED; pending → 409 IN_PROGRESS + Retry-After', async () => {
    const { m, store } = memoryStore();
    const { a } = app(store, (n) =>
      n === 1 ? { status: 422, body: { code: 'BUSINESS_RULE' } } : { status: 200, body: { ok: n } },
    );
    const post = (body: unknown, key = 'key-abcdefgh') =>
      request(a)
        .post('/op')
        .set('Idempotency-Key', key)
        .send(body as object);
    expect((await post({ a: 1 })).status).toBe(422);
    expect(m.size).toBe(0);
    expect((await post({ a: 1 })).status).toBe(200);
    const reused = await post({ a: 2 });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    m.set('idem:u1:key-pending1', {
      fingerprint: requestFingerprint('POST', '/op', Buffer.from('{"a":1}')),
      state: 'pending',
    });
    const busy = await post({ a: 1 }, 'key-pending1');
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    expect(busy.headers['retry-after']).toBe('1');
    expect(m.get('idem:u1:key-pending1')!.state).toBe('pending');
  });

  it('the fingerprint is sha256 of "{METHOD} {path}\\n" + raw body bytes', () => {
    expect(requestFingerprint('POST', '/api/v1/waybills', Buffer.from('{}'))).toBe(
      requestFingerprint('POST', '/api/v1/waybills', Buffer.from('{}')),
    );
    expect(requestFingerprint('POST', '/a', undefined)).toBe(
      // sha256("POST /a\n")
      createHash('sha256').update('POST /a\n').digest('hex'),
    );
  });
});

describe('idempotency middleware — client disconnect (R48, Review Focus 3)', () => {
  it('an aborted request keeps its pending record: the retry is 409 IN_PROGRESS, after the owner finishes it replays', async () => {
    const { m, store } = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const { a, calls } = app(store, async (n) => {
      if (n === 1) {
        started();
        await gate;
      }
      return { status: 201, body: { n } };
    });
    const server = a.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const body = '{"x":1}';
      // The first request: the client goes away while the handler is still running.
      const req = httpRequest({
        port,
        method: 'POST',
        path: '/op',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'key-abort001',
          'content-length': body.length,
        },
      });
      req.on('error', () => undefined);
      req.end(body);
      await running;
      req.destroy();
      await new Promise((r) => setTimeout(r, 50));
      expect(m.get('idem:u1:key-abort001')?.state).toBe('pending');
      const busy = await request(a).post('/op').set('Idempotency-Key', 'key-abort001').send({ x: 1 });
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
      expect(busy.headers['retry-after']).toBe('1');
      // The owner finishes: its result is stored and replayed; the operation ran once.
      release();
      for (let i = 0; i < 50 && m.get('idem:u1:key-abort001')?.state !== 'done'; i++)
        await new Promise((r) => setTimeout(r, 20));
      const replay = await request(a).post('/op').set('Idempotency-Key', 'key-abort001').send({ x: 1 });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual({ n: 1 });
      expect(calls()).toBe(1);
    } finally {
      server.close();
    }
  });
});
