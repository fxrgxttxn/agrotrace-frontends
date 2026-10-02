import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

// `./at fe:e2e-smoke react`: the React builds through the separate gateway (gateway-react, docker-compose.react-dev.yml)
// from the `playwright` Compose service on network agrotrace_at. Chromium resolves every *.localhost to loopback by
// itself, so the stand hosts are mapped to the gateway container.
//   mock  — react-mock.localhost: dist-mock, the in-browser backend of @agrotrace/mock-api (ruling FM23). Every test
//           has its own browser context, so its own demo world (the mock keeps its state in the origin's storage).
//   stand — react-express.localhost: the production dist; ./stand.ts answers /api/v1 in Playwright's route layer with
//           the contract's examples (a service worker would hide requests from page.route, hence not the mock build).
const gateway = (await lookup('gateway-react')).address;

const STAND = [
  'chunks.spec.ts',
  'focus-redirect.spec.ts',
  'profile-reveal.spec.ts',
  'shots-task3.spec.ts',
  'shots-task4.spec.ts',
  'shots-task5.spec.ts',
  'shots-task6.spec.ts',
  'stale-refetch.spec.ts',
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
