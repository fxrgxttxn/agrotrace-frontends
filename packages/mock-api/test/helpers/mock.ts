/** A mock instance behind msw/node, with a movable clock and demo-user logins. */
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createMockApi, DEMO_PASSWORD, type MockApi } from '../../src/index.js';
import { nodeAssetLoader } from './assets.js';
import { call, expectStatus } from './client.js';

export interface TestMock {
  api: MockApi;
  /** Moves the clock forward. */
  advance(ms: number): void;
  now(): number;
  login(email: string): Promise<string>;
}

export function useMock(opts: { rateLimits?: boolean } = {}): TestMock {
  let t = Date.parse('2026-10-14T10:00:00Z');
  // Persisted to an in-memory Storage with verification: any request that changes the state without marking the
  // store dirty (FM8) fails the suite.
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } as Storage;
  const api = createMockApi({ now: () => t, loadAsset: nodeAssetLoader, rateLimits: opts.rateLimits ?? false, persist: storage, blobStore: null, lock: null, verifyPersistence: true });
  const server = setupServer(...api.handlers);
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: 'error' });
    await api.ready;
  });
  afterEach(() => undefined);
  afterAll(() => {
    api.dispose();
    server.close();
  });
  return {
    api,
    advance: (ms) => (t += ms),
    now: () => t,
    async login(email) {
      const r = await expectStatus(200, 'POST', '/auth/login', { body: { email, password: DEMO_PASSWORD } });
      if (r.body.twoFactorRequired) {
        // The code of a step already used is refused (R35): the next step is waited for.
        let v = await call('POST', '/auth/2fa/verify', { body: { challengeId: r.body.challengeId, code: api.totp(email) } });
        if (v.status !== 200) {
          t += 30_000;
          v = await call('POST', '/auth/2fa/verify', { body: { challengeId: r.body.challengeId, code: api.totp(email) } });
        }
        return v.body.accessToken as string;
      }
      return r.body.accessToken as string;
    },
  };
}
