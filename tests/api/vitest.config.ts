import { defineConfig } from 'vitest/config';

// tests/api run against a live backend (API_URL). Files run one after another: they share the seeded dev DB,
// Redis counters and the backend's pools; a test that changes data creates its own entities (lib/fixtures.ts).
// P10: API_RATELIMITS=1 (`./at api:test <backend> --ratelimits`) selects only the `[ratelimit]` tests; otherwise
// they skip themselves (lib/tags.ts).
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    ...(process.env.API_RATELIMITS === '1' && { testNamePattern: /\[ratelimit\]/ }),
  },
});
