import { defineConfig } from 'vitest/config';

// tests/cross run against two live backends (CROSS_API_URLS) sharing one DB, Redis and JWT_SECRET; files run one
// after another like tests/api.
export default defineConfig({
  test: {
    // Long enough to wait out one shared rate-limit window (lib/http.ts fetchRetrying, R30: 60 s).
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
