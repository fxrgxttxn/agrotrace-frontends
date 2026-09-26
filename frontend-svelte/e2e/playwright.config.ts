import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

// `./at fe:e2e-smoke svelte`: the Svelte build through its own gateway (gateway-svelte, docker-compose.svelte-mock.yml)
// from the `playwright-svelte` service of the same project. Chromium resolves every *.localhost to loopback by itself,
// so the stand's host is mapped to the gateway container. No API server: the API answers come from the contract
// examples (e2e/contract.ts), as the mock backend will give them.
const gateway = (await lookup('gateway-svelte')).address;
// The React (host port 8089) and Angular (8090) stands, for the cross-framework comparisons only (e2e/compare*.spec.ts).
const host = await lookup('host.docker.internal').then(
  (r) => r.address,
  () => null,
);
const rules = [
  ...(host ? [`MAP react-express.localhost ${host}`, `MAP angular-mock.localhost ${host}`] : []),
  `MAP *.localhost ${gateway}`,
];

export default defineConfig({
  testDir: '.',
  forbidOnly: true,
  reporter: [['list']],
  workers: 2,
  timeout: 60000,
  outputDir: '../test-results/e2e',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://svelte-mock.localhost',
    locale: 'ru-RU',
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Moscow',
    launchOptions: { args: [`--host-resolver-rules=${rules.join(', ')}`] },
  },
});
