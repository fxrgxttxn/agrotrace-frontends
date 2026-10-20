import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

// `./at.sh docs:test [back]` (P5): Swagger UI of a backend through the gateway, in the `playwright` Compose service
// (network `at`). Chromium resolves every *.localhost to loopback itself, so the combination host is mapped to the
// gateway container's address.
const gateway = (await lookup('gateway')).address;

export default defineConfig({
  testDir: '.',
  forbidOnly: true,
  reporter: [['list']],
  timeout: 60000,
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: { args: [`--host-resolver-rules=MAP *.localhost ${gateway}`] },
  },
});
