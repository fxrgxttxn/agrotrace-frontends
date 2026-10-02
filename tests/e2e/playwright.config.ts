import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

// The shared parity suite (spec §9.7, ruling FM34): the same specs run against every frontend × backend through the
// gateway at http://{FRONT}-{BACK}.localhost (`./at e2e <front> <back>`, defaults react × mock — the in-browser
// @agrotrace/mock-api, every test context its own demo world). Selectors are roles and accessible names only, so
// Angular and Svelte pass them unchanged. Chromium resolves *.localhost to loopback by itself: the stand host is mapped
// to the gateway container (GATEWAY_HOST, default the React stand's gateway-react).
const FRONT = process.env.FRONT ?? 'react';
const BACK = process.env.BACK ?? 'mock';
const gateway = (await lookup(process.env.GATEWAY_HOST ?? 'gateway-react')).address;

export default defineConfig({
  testDir: '.',
  forbidOnly: true,
  reporter: [['list']],
  workers: 2,
  timeout: 180000,
  outputDir: 'test-results/run',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://${FRONT}-${BACK}.localhost`,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    launchOptions: { args: [`--host-resolver-rules=MAP *.localhost ${gateway}`] },
  },
});
