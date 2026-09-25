import { defineConfig, devices } from '@playwright/test';

// Runs inside the `playwright` Compose service (./at.sh ds:test): Linux Chromium only, so the
// committed screenshot baselines never depend on the host OS.
export default defineConfig({
  testDir: '.',
  // api-docs/ has its own config (./at.sh docs:test): it needs the gateway, not the showcase server.
  testIgnore: ['api-docs/**'],
  fullyParallel: true,
  forbidOnly: true,
  reporter: [['list']],
  // Tight: a date-format change or one chip colour must fail (proved by mutation in the task report).
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 50, threshold: 0.05 } },
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    colorScheme: 'light',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // 768–1023 px: collapsed icon rail.
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
