import { afterEach, describe, expect, it, vi } from 'vitest';
import { earlyBatchUrl, startEarly, takeEarly } from '../../src/lib/public/early';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('early batch request', () => {
  it('only for a QR page with a well-formed code', () => {
    expect(earlyBatchUrl('/p/AT-2026-000123', 'http://x')).toBe(
      'http://x/api/v1/public/batches/AT-2026-000123',
    );
    expect(earlyBatchUrl('/p/AT-2026-000123/complaint', 'http://x')).toBe(
      'http://x/api/v1/public/batches/AT-2026-000123',
    );
    expect(earlyBatchUrl('/p/not-a-code', 'http://x')).toBeNull();
    expect(earlyBatchUrl('/batches', 'http://x')).toBeNull();
  });

  it('the response is taken once, for the same URL only; a network failure rejects then', async () => {
    const fetch = vi.fn(async () => new Response('{"a":1}'));
    vi.stubGlobal('fetch', fetch);
    startEarly('http://x/a');
    expect(takeEarly('http://x/b')).toBeNull();
    const r = takeEarly('http://x/a');
    expect(await (await r!).json()).toEqual({ a: 1 });
    expect(takeEarly('http://x/a')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    startEarly('http://x/c');
    await expect(takeEarly('http://x/c')).rejects.toBeInstanceOf(TypeError);
  });
});
