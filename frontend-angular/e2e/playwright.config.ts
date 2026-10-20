import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

// `./at fe:e2e-smoke angular`: the Angular builds through its own stand (gateway-angular,
// docker-compose.angular-dev.yml, project agrotrace-angular) from the `playwright-angular` one-off of the same project.
// Chromium resolves every *.localhost to loopback by itself, so the host is mapped to the gateway-angular container.
// baseURL = the mock-mode build (dist-mock; the MSW worker of @agrotrace/mock-api answers /api/v1 with the demo world);
// specs that stage crafted answers or chunk failures use the production build instead (helpers.ts PRODUCTION).
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
