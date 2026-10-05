import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: true,
  reporter: [['list']],
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 50, threshold: 0.05 } },
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    colorScheme: 'light',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'rail', use: { ...devices['Desktop Chrome'], viewport: { width: 900, height: 800 } } },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 }, hasTouch: true },
    },
  ],
  webServer: {
    command: 'npx --no-install http-server ../../packages/design-system -p 4173 -s -c-1',
    url: 'http://localhost:4173/showcase/index.html',
    reuseExistingServer: false,
  },
});
