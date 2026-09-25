import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

// `./at fe:e2e-smoke angular`: the Angular production build through its own stand (gateway-angular,
// docker-compose.angular-dev.yml, project agrotrace-angular) from the `playwright-angular` one-off of the same project.
// Chromium resolves every *.localhost to loopback by itself, so the host is mapped to the gateway-angular container.
// Mock mode has no API server: until @agrotrace/mock-api is merged the specs answer /api/v1 in the page from the
// contract's own examples (e2e/api.ts).
const gateway = (await lookup('gateway-angular')).address;

export default defineConfig({
  testDir: '.',
  forbidOnly: true,
  reporter: [['list']],
  workers: 2,
  timeout: 60000,
  outputDir: '../test-results/e2e',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://angular-mock.localhost',
    locale: 'ru-RU',
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Moscow',
    launchOptions: { args: [`--host-resolver-rules=MAP *.localhost ${gateway}`] },
  },
});
