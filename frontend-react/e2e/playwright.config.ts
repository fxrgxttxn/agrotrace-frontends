import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

const gateway = (await lookup('gateway-react')).address;

const STAND = [
  'chunks.spec.ts',
  'focus-redirect.spec.ts',
  'profile-reveal.spec.ts',
  'screens-1.spec.ts',
  'screens-2.spec.ts',
  'screens-3.spec.ts',
  'stale-refetch.spec.ts',
  'public-stand.spec.ts',
];

export default defineConfig({
  testDir: '.',
  forbidOnly: true,
  reporter: [['list']],
  workers: 2,
  timeout: 180000,
  outputDir: '../test-results/e2e',
  use: {
    ...devices['Desktop Chrome'],
    locale: 'ru-RU',
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Moscow',
    launchOptions: { args: [`--host-resolver-rules=MAP *.localhost ${gateway}`] },
  },
  projects: [
    { name: 'mock', testIgnore: STAND, use: { baseURL: 'http://react-mock.localhost' } },
    { name: 'stand', testMatch: STAND, use: { baseURL: 'http://react-express.localhost' } },
  ],
});
