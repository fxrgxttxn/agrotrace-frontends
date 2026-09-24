import { defineConfig } from 'vitest/config';

// DNS resolution of a genuinely nonexistent service name (api-<back>, no backend running yet)
// through Docker's embedded resolver (127.0.0.11) takes a few seconds to fail, not milliseconds —
// every "no backend running" case in this suite pays that cost once per (uncached) hostname.
export default defineConfig({
  test: { testTimeout: 20000 },
});
