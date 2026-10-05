import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

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
