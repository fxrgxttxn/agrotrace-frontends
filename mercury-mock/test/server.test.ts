import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

interface JsonResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const body = await res.json();
  return { status: res.status, headers: res.headers, body };
}

describe('mercury-mock server', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer({ failRate: 0, timeoutMs: 30000 });
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
  });

  describe('X-Mock-Fail header', () => {
    it('X-Mock-Fail: 500 forces a 500 response', async () => {
      const res = await request(baseUrl, '/api/v1/vsd', {
        headers: { 'X-Mock-Fail': '500' },
      });
      expect(res.status).toBe(500);
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
