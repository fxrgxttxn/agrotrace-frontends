import { lookup } from 'node:dns/promises';
import { defineConfig, devices } from '@playwright/test';

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
