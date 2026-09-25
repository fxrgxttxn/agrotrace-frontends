import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

// `./at fe:e2e-smoke react`: the React build through the separate gateway (gateway-react, docker-compose.react-dev.yml)
// from the `playwright` Compose service on network agrotrace_at. Chromium resolves every *.localhost to loopback by
// itself, so the combination host is mapped to the gateway-react container.
const gateway = (await lookup('gateway-react')).address;

export default defineConfig({
  testDir: '.',
  forbidOnly: true,
  reporter: [['list']],
  // One worker: every login goes through the one gateway-react IP, and the shared stack's login-ip limit is 20 per
  // 60 s — parallel workers race each other into it (a waited-out 429 can take a minute, hence the timeout).
  workers: 1,
  timeout: 180000,
  outputDir: '../test-results/e2e',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://react-express.localhost',
    locale: 'ru-RU',
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Moscow',
    launchOptions: { args: [`--host-resolver-rules=MAP *.localhost ${gateway}`] },
  },
});
