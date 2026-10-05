import { describe, expect, it } from 'vitest';
import { buildSeed } from '../src/store/seed.js';
import { renderGenerated } from '../src/domain/documents.js';
import { memoryCounters, type MockConfig } from '../src/config.js';
import { nodeAssetLoader } from './helpers/assets.js';

const cfg = (now: number): MockConfig => ({
  now: () => now,
  publicBaseUrl: 'http://localhost',
  loadAsset: nodeAssetLoader,
  totpUsers: {},
  rateLimits: false,
  secret: 'test',
  telegramBot: 'agrotrace_bot',
  onMail: () => undefined,
  blobs: null,
  counters: memoryCounters(),
});

describe('seed world', () => {
  it('replays db/seed at the current minute with the demo graph', async () => {
    const now = Date.parse('2027-03-10T12:34:56Z');
    const { store } = buildSeed(cfg(now));
    await renderGenerated(cfg(now), store);
    expect(store.t.users).toHaveLength(19);
    expect(store.t.organizations).toHaveLength(12);
    expect(store.t.batches.find((b) => b.public_code === 'AT-2027-000002')).toBeDefined();
    expect(store.t.recalls.filter((r) => r.status === 'OPEN').length).toBeGreaterThanOrEqual(2);
    const pdf = store.t.files.find((f) => f.kind === 'LAB_PROTOCOL')!;
    expect(pdf.size_bytes).toBeGreaterThan(1000);
    expect(pdf.content.type === 'bytes' && new TextDecoder().decode(pdf.content.data.subarray(0, 5))).toBe('%PDF-');
  });
});
