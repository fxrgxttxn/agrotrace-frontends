import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { fileParallelism: false, testTimeout: 15000, globalSetup: ['./globalSetup.ts'] },
});
