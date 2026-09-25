import { defineConfig } from 'vitest/config';

// tests/api run against a live backend (API_URL). Files run one after another: they share the seeded dev DB,
// Redis rate-limit counters (login per IP) and the backend's pools; a test that changes data creates its own
// entities (lib/fixtures.ts, later tasks).
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
