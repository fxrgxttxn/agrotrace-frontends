import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

// The shared parity suite (spec §9.7, §14.1, ruling FM34): the same specs run against every frontend × backend through
// a gateway at http://{FRONT}-{BACK}.localhost:{GATEWAY_PORT} (`./at e2e <front> <back> [playwright args]`, defaults
// react × mock — the in-browser @agrotrace/mock-api). Selectors are roles and accessible names only, so Angular and
// Svelte pass the specs unchanged.
//   GATEWAY_HOST — where the *.localhost names point (Chromium resolves *.localhost to loopback by itself, so they are
//                  mapped): the front's own stand gateway (gateway-react|angular|svelte) or the main `gateway`;
//                  `./at e2e` picks it. GATEWAY_PORT — the port that gateway listens on there (80 inside the network).
//   Mock world: every test has its own browser context, so its own freshly built demo world (the mock keeps it in the
//   origin's storage) — each test starts from the reset world. A real backend needs `./at reset` before the run; the
//   specs then create their own entities with fresh names.
const FRONT = process.env.FRONT ?? 'react';
const BACK = process.env.BACK ?? 'mock';
const PORT = process.env.GATEWAY_PORT ?? '80';
const gateway = (await lookup(process.env.GATEWAY_HOST ?? `gateway-${FRONT}`)).address;

export default defineConfig({
  testDir: '.',
  testIgnore: ['_x/**'],
  forbidOnly: true,
  fullyParallel: true,
  reporter: [['list']],
  workers: Number(process.env.E2E_WORKERS ?? 3),
  timeout: 180000,
  outputDir: 'test-results/run',
  // Visual baselines are React's (Plan 2 Task 9): one image per screen, theme and width, no front or platform in the
  // name — Angular and Svelte are compared with the same files (visual.spec.ts).
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' } },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://${FRONT}-${BACK}.localhost${PORT === '80' ? '' : `:${PORT}`}`,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    launchOptions: { args: [`--host-resolver-rules=MAP *.localhost ${gateway}`] },
  },
});
