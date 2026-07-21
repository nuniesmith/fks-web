import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 15_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    // The documented dev bypass (adapter.ts step 3): without it the hook can't
    // resolve an auth state (no WEBUI_DATABASE_URL in a clean shell) and every
    // page 503s, so the suite only passed if the operator happened to export it.
    // Setting it here makes `npm run test:e2e` run from a CLEAN shell.
    // NOTE: cockpit kill/re-arm still return 403 in this mode BY DESIGN
    // (adapter.ts AUTH_DISABLED_BLOCKED_MUTATIONS) — the e2e specs rely on that
    // refusal, so do NOT try to "fix" a 403 from those routes by widening this.
    env: { WEBUI_AUTH: 'disabled' },
  },
});
