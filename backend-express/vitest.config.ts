import { defineConfig } from 'vitest/config';

// Unit tests only (no live services): logic that tests/api cannot observe over HTTP.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 20000 },
});
