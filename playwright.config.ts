import { defineConfig, devices } from '@playwright/test';

/** E2E runs against its own database and port so dev data never breaks it. */
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://demandx:demandx@127.0.0.1:5433/demandx_e2e';
process.env.DATABASE_URL = DATABASE_URL;

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;
const STUB_PORT = process.env.STUB_PORT ?? '4010';
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // The suites share one Postgres database, and `llm_chains` is keyed by
  // (profile, position) rather than by provider. Two files saving chains at the
  // same time would overwrite each other's rows, so files run one at a time.
  workers: 1,
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
      // A production server on its own port: `next dev` refuses to run twice
      // from one checkout, and E2E must not share the developer's dev server.
      command: `node scripts/e2e-db.mjs && pnpm build && pnpm start --port ${PORT}`,
      url: baseURL,
      // Never reuse a dev server: it may be pointed at the developer's database.
      reuseExistingServer: false,
      env: { DATABASE_URL },
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
