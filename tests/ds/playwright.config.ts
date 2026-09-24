import { defineConfig, devices } from '@playwright/test';

// Runs inside the `playwright` Compose service (./at.sh ds:test): Linux Chromium only, so the
// committed screenshot baselines never depend on the host OS.
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: true,
  reporter: [['list']],
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide' } },
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    colorScheme: 'light',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
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
