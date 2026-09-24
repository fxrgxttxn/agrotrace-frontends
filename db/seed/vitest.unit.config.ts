import { defineConfig } from 'vitest/config';

// Pure tests: scenario invariants, data files, generated artwork. No database or MinIO.
export default defineConfig({
  test: { include: ['test/unit/**/*.test.ts'], testTimeout: 60000 },
});
