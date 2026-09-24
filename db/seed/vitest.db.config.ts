import { defineConfig } from 'vitest/config';

// `./at.sh seed:test`: seeds the dev database (global setup, SEED_NOW pinned for the run), then checks
// it and MinIO; the idempotency test seeds once more with the same SEED_NOW.
export default defineConfig({
  test: {
    include: ['test/db/**/*.test.ts'],
    globalSetup: ['./test/db/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
