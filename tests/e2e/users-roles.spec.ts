/**
 * Role-matrix e2e (Phase B / B6) — automates the B5 acceptance: bootstrap →
 * admin setup → create operator → operator login → assert the operator is
 * fenced out of admin surfaces but can still operate.
 *
 * ─── REQUIRES A REAL POSTGRES + AUTH ENABLED ────────────────────────────────
 * The default `npm run test:e2e` server (playwright.config.ts) runs with
 * WEBUI_AUTH=disabled and NO database, so this spec SKIPS there (and in CI) —
 * green-skipped, never failed. To run it locally, start a scratch Postgres and
 * a dev server pointed at it with a KNOWN bootstrap password, then run the spec
 * (playwright reuses the already-running server in non-CI):
 *
 *   SCRATCH_PW=$(openssl rand -hex 12)
 *   docker run --rm -d --name fks-web-authdb -p 5433:5432 \
 *     -e POSTGRES_PASSWORD="$SCRATCH_PW" -e POSTGRES_DB=fks_db postgres:16
 *
 *   (the URL carries no password — the `postgres` client falls back to the
 *    standard PGPASSWORD env var, keeping credential-shaped strings out of
 *    this file and your shell history)
 *
 *   PGPASSWORD="$SCRATCH_PW" \
 *   WEBUI_DATABASE_URL="postgres://postgres@localhost:5433/fks_db" \
 *   WEBUI_BOOTSTRAP_PASSWORD=<pick-a-throwaway> \
 *   npm run dev            # separate shell; leave it running
 *
 *   PGPASSWORD="$SCRATCH_PW" \
 *   WEBUI_DATABASE_URL="postgres://postgres@localhost:5433/fks_db" \
 *   WEBUI_BOOTSTRAP_PASSWORD=<the-same-throwaway> \
 *   npx playwright test users-roles
 *
 * The DB must start EMPTY (no webui_users) so the first login is the bootstrap
 * admin. Drop the container between runs to reset. BOTH env vars are the skip
 * guard — either unset ⇒ the whole describe is skipped.
 */
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

const HAS_DB =
  !!process.env.WEBUI_DATABASE_URL && !!process.env.WEBUI_BOOTSTRAP_PASSWORD;
const BOOTSTRAP_PW = process.env.WEBUI_BOOTSTRAP_PASSWORD ?? "";

// Generated per run (stable within the serial worker) — no literal
// password-shaped strings in the tree, and every run uses fresh credentials.
const RUN_TAG = randomUUID().slice(0, 8);
const ADMIN_PW = `e2e-admin-${RUN_TAG}`;
const OP_USER = "e2eop";
const OP_PW = `e2e-operator-${RUN_TAG}`;

test.describe("users role-matrix (needs Postgres + auth enabled)", () => {
  test.skip(!HAS_DB, "set WEBUI_DATABASE_URL (+ a fresh DB) to run — see file header");

  // Serial: the steps build on one another (bootstrap → admin → operator).
  test.describe.configure({ mode: "serial" });

  test("bootstrap admin sets credentials and creates an operator", async ({ page }) => {
    // 1. Bootstrap admin login → forced to /setup.
    await page.goto("/login");
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', BOOTSTRAP_PW);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/setup");

    // 2. Set the admin's own credentials → lands in the app.
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', ADMIN_PW);
    await page.fill('input[name="confirm"]', ADMIN_PW);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/setup"));

    // 3. Admin sees the Users tab and can open /users.
    const tabbar = page.getByRole("navigation", { name: "Workspace navigation" });
    await expect(tabbar.getByRole("link", { name: "Users" })).toBeVisible();
    await page.goto("/users");
    await expect(page).toHaveTitle("Users — FKS Terminal");

    // 4. Create an operator; capture the one-time temp password.
    await page.fill('input[placeholder="e.g. friend"]', OP_USER);
    await page.selectOption("select", "operator");
    await page.click('button:has-text("Create user")');
    const tempPw = await page.locator("code.temp-pw").innerText();
    expect(tempPw.length).toBeGreaterThan(0);
    // Store for the next test via env-less module scope.
    (globalThis as Record<string, unknown>).__e2eOpTempPw = tempPw;
  });

  test("operator is fenced out of admin surfaces but can operate", async ({ browser }) => {
    const tempPw = String((globalThis as Record<string, unknown>).__e2eOpTempPw ?? "");
    expect(tempPw.length).toBeGreaterThan(0);

    // Fresh context = the operator's own session (no admin cookie).
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Operator's first login → forced through /setup to set their own password.
    await page.goto("/login");
    await page.fill('input[name="username"]', OP_USER);
    await page.fill('input[name="password"]', tempPw);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/setup");
    await page.fill('input[name="username"]', OP_USER);
    await page.fill('input[name="password"]', OP_PW);
    await page.fill('input[name="confirm"]', OP_PW);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/setup"));

    // No Users tab for a non-admin.
    const tabbar = page.getByRole("navigation", { name: "Workspace navigation" });
    await expect(tabbar.getByRole("link", { name: "Users" })).toHaveCount(0);

    // Direct nav to /users redirects home (seam R5).
    await page.goto("/users");
    await expect(page).toHaveURL((url) => url.pathname === "/");

    // API matrix — evaluated in the operator's authenticated browser context.
    const codes = await page.evaluate(async () => {
      const post = async (path: string, body: unknown) =>
        (await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })).status;
      return {
        usersList: (await fetch("/api/users")).status,
        exchangeKeys: await post("/api/settings/exchange-keys", { exchange: "kraken", apiKey: "x", apiSecret: "y" }),
        spawnPaper: await post("/api/spawner/spawn", { name: "e2e", mode: "paper" }),
        cockpitKill: await post("/api/cockpit/kill", { confirm: "nope", instance: "paper" }),
      };
    });

    // Admin-only → 403 role_denied (R1 / R2).
    expect(codes.usersList).toBe(403);
    expect(codes.exchangeKeys).toBe(403);
    // Operator-permitted at the SEAM (R3): the request passes role gating and
    // reaches the backend, so it is NOT 401/403 role_denied. The upstream may
    // reject on its own terms (400 bad confirm / 502 unreachable / 200) — any
    // of those means the seam let it through, which is what we assert.
    expect(codes.spawnPaper).not.toBe(403);
    expect(codes.spawnPaper).not.toBe(401);
    expect(codes.cockpitKill).not.toBe(403);
    expect(codes.cockpitKill).not.toBe(401);

    await ctx.close();
  });
});
