import { defineConfig, devices } from '@playwright/test';

// Tests target the live deployed site by default. Override with BASE_URL.
const BASE_URL = process.env.BASE_URL || 'https://kenya.proto.theflywheel.in';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'on',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    // The map is heavy; give canvas/glyph fetches time.
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
