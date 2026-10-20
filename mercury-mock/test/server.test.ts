import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv, createServer } from '../src/server.js';
import { loadVsdList } from '../src/store.js';

interface JsonResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const body = await res.json();
  return { status: res.status, headers: res.headers, body };
}

describe('mercury-mock server', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Pinned at the dataset's reference moment (R90), so the documents carry the dates of data/vsd.json.
    server = createServer({ failRate: 0, timeoutMs: 30000, now: () => Date.parse('2026-09-20T09:00:00Z') });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe('GET /health', () => {
    it('returns 200 { status: "ok" }', async () => {
      const res = await request(baseUrl, '/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /api/v1/vsd', () => {
    it('returns all items with no filters', async () => {
      const res = await request(baseUrl, '/api/v1/vsd');
      expect(res.status).toBe(200);
      expect(Array.isArray((res.body as { items: unknown[] }).items)).toBe(true);
      expect((res.body as { items: unknown[] }).items.length).toBe(15);
    });

    it('filters by productCode', async () => {
      const res = await request(baseUrl, '/api/v1/vsd?productCode=10.51.11');
      expect(res.status).toBe(200);
      const { items } = res.body as { items: { product: { code: string } }[] };
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.product.code).toBe('10.51.11');
    });

    it('filters by senderInn', async () => {
      const res = await request(baseUrl, '/api/v1/vsd?senderInn=2312450016');
      expect(res.status).toBe(200);
      const { items } = res.body as { items: { consignor: { inn: string } }[] };
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.consignor.inn).toBe('2312450016');
    });

    it('filters by dateFrom/dateTo inclusively', async () => {
      const res = await request(baseUrl, '/api/v1/vsd?dateFrom=2026-01-15&dateTo=2026-01-15');
      expect(res.status).toBe(200);
      const { items } = res.body as { items: { issueDate: string }[] };
      expect(items).toHaveLength(1);
      expect(items[0]?.issueDate).toBe('2026-01-15');
    });

    it('narrows results when combining productCode, dateFrom and dateTo', async () => {
      const res = await request(
        baseUrl,
        '/api/v1/vsd?productCode=10.11.11&dateFrom=2026-02-01&dateTo=2026-03-31',
      );
      expect(res.status).toBe(200);
      const { items } = res.body as { items: { product: { code: string }; issueDate: string }[] };
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.product.code).toBe('10.11.11');
        expect(item.issueDate >= '2026-02-01').toBe(true);
        expect(item.issueDate <= '2026-03-31').toBe(true);
      }
    });

    it('returns an empty list when a filter matches nothing', async () => {
      const res = await request(baseUrl, '/api/v1/vsd?senderInn=0000000000');
      expect(res.status).toBe(200);
      expect((res.body as { items: unknown[] }).items).toEqual([]);
    });

    it('rejects a malformed dateFrom with 400 { error: "BAD_REQUEST" }', async () => {
      const res = await request(baseUrl, '/api/v1/vsd?dateFrom=not-a-date');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'BAD_REQUEST' });
    });

    it('rejects a malformed dateTo with 400 { error: "BAD_REQUEST" }', async () => {
      const res = await request(baseUrl, '/api/v1/vsd?dateTo=2026-02-30');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'BAD_REQUEST' });
    });
  });

  describe('GET /api/v1/vsd/{uuid}', () => {
    it('returns the matching Vsd', async () => {
      const res = await request(baseUrl, '/api/v1/vsd/d3bc6508-f9e7-412e-a6c4-690f31cd59f0');
      expect(res.status).toBe(200);
      const body = res.body as {
        uuid: string;
        number: string;
        status: string;
        product: { code: string; name: string };
        consignor: { inn: string; name: string };
        consignee: { inn: string; name: string };
        vetInspection: { result: string; date: string; doctor: string };
      };
      expect(body.uuid).toBe('d3bc6508-f9e7-412e-a6c4-690f31cd59f0');
      expect(body.status).toBe('CONFIRMED');
      expect(body.product.code).toBe('10.51.11');
      expect(body.vetInspection.result).toBe('HEALTHY');
    });

    it('returns 404 { error: "NOT_FOUND" } for an unknown uuid', async () => {
      const res = await request(baseUrl, '/api/v1/vsd/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND' });
    });

    it('returns 400 { error: "BAD_REQUEST" } for malformed percent-encoding in the uuid segment', async () => {
      const res = await request(baseUrl, '/api/v1/vsd/%E0%A4%A');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'BAD_REQUEST' });
    });
  });

  describe('unknown routes and unsupported methods', () => {
    it('GET on an unknown path returns 404 { error: "NOT_FOUND" }', async () => {
      const res = await request(baseUrl, '/nope');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND' });
    });

    it('POST /api/v1/vsd returns 405 { error: "METHOD_NOT_ALLOWED" } with Allow: GET', async () => {
      const res = await request(baseUrl, '/api/v1/vsd', { method: 'POST' });
      expect(res.status).toBe(405);
      expect(res.body).toEqual({ error: 'METHOD_NOT_ALLOWED' });
      expect(res.headers.get('allow')).toBe('GET');
    });

    it('POST /health returns 405 { error: "METHOD_NOT_ALLOWED" } with Allow: GET', async () => {
      const res = await request(baseUrl, '/health', { method: 'POST' });
      expect(res.status).toBe(405);
      expect(res.body).toEqual({ error: 'METHOD_NOT_ALLOWED' });
      expect(res.headers.get('allow')).toBe('GET');
    });
  });

  describe('X-Mock-Fail header', () => {
    it('X-Mock-Fail: 500 forces a 500 response', async () => {
      const res = await request(baseUrl, '/api/v1/vsd', {
        headers: { 'X-Mock-Fail': '500' },
      });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'INTERNAL' });
    });

    it('X-Mock-Fail: 500 on an unknown path still returns 404 (fail injection is scoped to /api/v1/vsd*)', async () => {
      const res = await request(baseUrl, '/nope', {
        headers: { 'X-Mock-Fail': '500' },
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND' });
    });

    it('X-Mock-Fail: timeout delays the response by ~MOCK_TIMEOUT_MS', async () => {
      const timeoutServer = createServer({ failRate: 0, timeoutMs: 80 });
      await new Promise<void>((resolve) => timeoutServer.listen(0, resolve));
      const { port } = timeoutServer.address() as AddressInfo;
      try {
        const start = Date.now();
        const res = await request(`http://127.0.0.1:${port}`, '/api/v1/vsd', {
          headers: { 'X-Mock-Fail': 'timeout' },
        });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(70);
        expect(res.status).toBe(200);
      } finally {
        await new Promise<void>((resolve, reject) => {
          timeoutServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });

  describe('MOCK_FAIL_RATE', () => {
    it('failRate 1.0 forces every request to fail with 500', async () => {
      const failServer = createServer({ failRate: 1 });
      await new Promise<void>((resolve) => failServer.listen(0, resolve));
      const { port } = failServer.address() as AddressInfo;
      try {
        const res = await request(`http://127.0.0.1:${port}`, '/api/v1/vsd');
        expect(res.status).toBe(500);
      } finally {
        await new Promise<void>((resolve, reject) => {
          failServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it('failRate 1.0 does not affect /health', async () => {
      const failServer = createServer({ failRate: 1 });
      await new Promise<void>((resolve) => failServer.listen(0, resolve));
      const { port } = failServer.address() as AddressInfo;
      try {
        const res = await request(`http://127.0.0.1:${port}`, '/health');
        expect(res.status).toBe(200);
      } finally {
        await new Promise<void>((resolve, reject) => {
          failServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });
});

describe('relative document dates (R90)', () => {
  const REF = Date.parse('2026-09-20T09:00:00Z');
  const DAY = 86_400_000;

  async function withServer<T>(now: () => number, fn: (base: string) => Promise<T>): Promise<T> {
    const s = createServer({ failRate: 0, now });
    await new Promise<void>((resolve) => s.listen(0, resolve));
    const { port } = s.address() as AddressInfo;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
    }
  }

  const ITEM = 'd3bc6508-f9e7-412e-a6c4-690f31cd59f0'; // VSD-2026-000001, 2026-01-15 as of the reference moment

  it('at the reference moment the documents carry the dataset dates', async () => {
    await withServer(
      () => REF,
      async (base) => {
        const res = await request(base, `/api/v1/vsd/${ITEM}`);
        expect(res.body).toMatchObject({ issueDate: '2026-01-15', vetInspection: { date: '2026-01-14' } });
      },
    );
  });

  it('ten days later every date moves ten days forward — in the list, the filters and the item', async () => {
    await withServer(
      () => REF + 10 * DAY,
      async (base) => {
        const item = await request(base, `/api/v1/vsd/${ITEM}`);
        expect(item.body).toMatchObject({ issueDate: '2026-01-25', vetInspection: { date: '2026-01-24' } });
        const hit = await request(base, '/api/v1/vsd?dateFrom=2026-01-25&dateTo=2026-01-25');
        expect((hit.body as { items: { uuid: string }[] }).items.map((v) => v.uuid)).toEqual([ITEM]);
        const miss = await request(base, '/api/v1/vsd?dateFrom=2026-01-15&dateTo=2026-01-15');
        expect((miss.body as { items: unknown[] }).items).toEqual([]);
      },
    );
  });

  it('shifts by whole UTC days: 23:59 on the reference date is still day 0, 00:00 the next day is day 1', async () => {
    const at = async (t: number) =>
      withServer(
        () => t,
        async (base) =>
          ((await request(base, `/api/v1/vsd/${ITEM}`)).body as { issueDate: string }).issueDate,
      );
    expect(await at(Date.parse('2026-09-20T23:59:59Z'))).toBe('2026-01-15');
    expect(await at(Date.parse('2026-09-21T00:00:00Z'))).toBe('2026-01-16');
    expect(await at(Date.parse('2026-09-19T00:00:00Z'))).toBe('2026-01-14');
  });

  it('the clock is read per request (a long-running container follows the calendar)', async () => {
    let t = REF;
    await withServer(
      () => t,
      async (base) => {
        expect(((await request(base, `/api/v1/vsd/${ITEM}`)).body as { issueDate: string }).issueDate).toBe(
          '2026-01-15',
        );
        t += 2 * DAY;
        expect(((await request(base, `/api/v1/vsd/${ITEM}`)).body as { issueDate: string }).issueDate).toBe(
          '2026-01-17',
        );
      },
    );
  });

  it('MOCK_NOW pins the clock; a malformed MOCK_NOW fails fast', () => {
    expect(configFromEnv({ MOCK_NOW: '2026-09-30T09:00:00Z' }).now()).toBe(
      Date.parse('2026-09-30T09:00:00Z'),
    );
    expect(configFromEnv({ MOCK_NOW: '2026-09-30T12:00:00+03:00' }).now()).toBe(
      Date.parse('2026-09-30T09:00:00Z'),
    );
    const live = configFromEnv({}).now();
    expect(Math.abs(live - Date.now())).toBeLessThan(5000);
    expect(() => configFromEnv({ MOCK_NOW: 'yesterday' })).toThrow(/MOCK_NOW/);
    expect(() => configFromEnv({ MOCK_NOW: '2026-09-30' })).toThrow(/MOCK_NOW/);
  });

  it('shiftVsdDates / MOCK_REFERENCE_NOW match the seed reference moment', async () => {
    const { MOCK_REFERENCE_NOW, shiftVsdDates } = await import('../src/dates.js');
    const seedTime = await import('../../db/seed/src/time.js');
    expect(MOCK_REFERENCE_NOW).toBe(seedTime.REFERENCE_NOW);
    const [first] = shiftVsdDates(loadVsdList(), REF - 15 * DAY);
    expect(first!.issueDate).toBe('2025-12-31');
  });
});
