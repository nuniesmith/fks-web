import { defineConfig, devices } from '@playwright/test';

/**
 * Dev-server port. Overridable because `reuseExistingServer` will happily
 * attach to whatever is ALREADY listening on 5173 — including a dev server
 * started from a different git worktree of this repo. When that happens the
 * suite silently tests someone else's build and reports green (or red) for
 * code that is not on disk here. Set `WEB_E2E_PORT` to a free port to get a
 * private server; unset it and CI/solo runs behave exactly as before.
 */
const PORT = Number(process.env.WEB_E2E_PORT ?? 5173);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 15_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
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
    // The trailing --port wins over the one baked into the npm script, and
    // --strictPort makes a busy port a loud failure instead of a silent drift
    // to 5174 that would leave `url` below unreachable.
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    // The documented dev bypass (adapter.ts step 3): without it the hook can't
    // resolve an auth state (no WEBUI_DATABASE_URL in a clean shell) and every
    // page 503s, so the suite only passed if the operator happened to export it.
    // Setting it here makes `npm run test:e2e` run from a CLEAN shell.
    // NOTE: cockpit kill/re-arm still return 403 in this mode BY DESIGN
    // (adapter.ts AUTH_DISABLED_BLOCKED_MUTATIONS) — the e2e specs rely on that
    // refusal, so do NOT try to "fix" a 403 from those routes by widening this.
    //
    // The two DB URLs are cleared to '' so the unmocked seam spec
    // (cockpit.spec `live-server seam` → GET /api/cockpit/state ⇒ configured:false)
    // is HERMETIC. `npm run dev` inherits the launching shell's env, and on the
    // deploy host those vars point at a live cockpit DB (funding tables present),
    // which would make getStore() non-null ⇒ configured:true and fail the seam's
    // JSON + "Cockpit database not available" assertions. Empty string overrides
    // any inherited value (cockpit.ts cockpitDbUrl() trims → falsy → not configured).
    env: {
      WEBUI_AUTH: 'disabled',
      WEBUI_FR_DATABASE_URL: '',
      WEBUI_DATABASE_URL: '',
    },
  },
});
