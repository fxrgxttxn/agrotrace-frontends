import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

const gateway = (await lookup('gateway-svelte')).address;
const host = await lookup('host.docker.internal').then(
  (r) => r.address,
  () => null,
);
const rules = [
  ...(host
    ? [
        `MAP react-express.localhost ${host}`,
        `MAP react-mock.localhost ${host}`,
        `MAP angular-express.localhost ${host}`,
        `MAP angular-mock.localhost ${host}`,
      ]
    : []),
  `MAP *.localhost ${gateway}`,
];

const MOCK = ['mock.spec.ts', 'fields-batches.spec.ts'];

export default defineConfig({
  testDir: '.',
  forbidOnly: true,
  reporter: [['list']],
  workers: 2,
  timeout: 90000,
  outputDir: '../test-results/e2e',
  use: {
    ...devices['Desktop Chrome'],
    locale: 'ru-RU',
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Moscow',
    launchOptions: { args: [`--host-resolver-rules=${rules.join(', ')}`] },
  },
  projects: [
    { name: 'mock', testMatch: MOCK, use: { baseURL: 'http://svelte-mock.localhost' } },
    { name: 'stand', testIgnore: MOCK, use: { baseURL: 'http://svelte-express.localhost' } },
  ],
});
