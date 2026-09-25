import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
