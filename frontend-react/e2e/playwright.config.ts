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
  timeout: 60000,
  outputDir: '../test-results/e2e',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://react-express.localhost',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    launchOptions: { args: [`--host-resolver-rules=MAP *.localhost ${gateway}`] },
  },
});
