import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

// `./at fe:e2e-smoke svelte`: the Svelte builds through their own gateway (gateway-svelte, docker-compose.svelte-mock.yml)
// from the `playwright-svelte` service of the same project. Chromium resolves every *.localhost to loopback by itself,
// so the stand's hosts are mapped to the gateway container. Two projects (ruling FM23):
//   mock  — svelte-mock.localhost: build-mock, the in-browser backend of @agrotrace/mock-api. Every test has its own
//           browser context, so its own demo world (the mock keeps it in the origin's storage).
//   stand — svelte-express.localhost: the production build; e2e/contract.ts answers /api/v1 in Playwright's route layer
//           with the contract's examples or crafted answers (a service worker would hide the requests from the route
//           layer, hence not the mock build) — chunk failures, rate limits, the public JS budget, DOM comparisons.
const gateway = (await lookup('gateway-svelte')).address;
// The React (host port 8089) and Angular (8090) stands, for the cross-framework comparisons only (e2e/compare*.spec.ts).
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

/** Specs on the mock backend; everything else runs on the production build with the route layer. */
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
