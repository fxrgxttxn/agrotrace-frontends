import { defineConfig } from 'vitest/config';

// tests/cross run against two live backends (CROSS_API_URLS) sharing one DB, Redis and JWT_SECRET; files run one
// after another like tests/api.
export default defineConfig({
  test: {
    testTimeout: 30000,
    fileParallelism: false,
  },
});
