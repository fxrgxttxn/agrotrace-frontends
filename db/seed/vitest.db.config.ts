import { defineConfig } from 'vitest/config';

// Run by `./at.sh seed:test` after `./at.sh seed`, against the dev database and MinIO.
export default defineConfig({
  test: {
    include: ['test/db/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
