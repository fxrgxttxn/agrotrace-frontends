import { defineConfig } from 'vitest/config';

// Unit tests only (no live services): logic that tests/api cannot observe over HTTP. Worker threads (SVG, XLSX) start
// from TypeScript sources through tsx here, which on a busy host can exceed the production start-up bound.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    env: { WORKER_START_TIMEOUT_MS: '120000' },
  },
});
