import { defineConfig, devices } from '@playwright/test';

const PORT = 3000;
const baseURL = `http://127.0.0.1:${PORT}`;
const STUB_URL = 'http://127.0.0.1:4010';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      // `devices['Desktop Chrome']` carries its own viewport (1280x720); the
      // explicit override keeps the 1440x900 desktop baseline below in effect.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'pnpm dev',
      url: baseURL,
      reuseExistingServer: true, // CI starts clean; local shells often already run `pnpm dev`
      timeout: 120_000,
    },
    {
      // The settings spec talks to a real HTTP endpoint; only the provider is
      // stubbed, so Server Actions, the database and the adapter stay in play.
      command: 'node scripts/stub-provider.mjs',
      url: `${STUB_URL}/__requests`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
