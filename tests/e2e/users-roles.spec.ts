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

  // ── Phase C: invite links ───────────────────────────────────────────────────
  test("admin mints a viewer invite; a fresh visitor claims it and lands as viewer", async ({ page, browser }) => {
    // Re-establish an admin session (each test gets a fresh context).
    await page.goto("/login");
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', ADMIN_PW);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/setup") && !url.pathname.startsWith("/login"));

    await page.goto("/users");
    await expect(page).toHaveTitle("Users — FKS Terminal");

    // Mint a viewer invite; capture the one-time absolute URL from the callout.
    const inviteForm = page.locator("form", {
      has: page.getByRole("button", { name: "Create invite link" }),
    });
    await inviteForm.locator("select").selectOption("viewer");
    await inviteForm.getByRole("button", { name: "Create invite link" }).click();
    const inviteUrl = (await page.locator("code.invite-url").innerText()).trim();
    expect(inviteUrl).toContain("/invite/");

    // A brand-new visitor (no cookies) opens the invite and sets their own creds.
    const VIEWER_PW = `e2e-viewer-${RUN_TAG}`;
    const VIEWER_USER = "e2einvitee";
    const claimCtx = await browser.newContext();
    const claim = await claimCtx.newPage();
    await claim.goto(inviteUrl);
    await claim.fill('input[name="username"]', VIEWER_USER);
    await claim.fill('input[name="password"]', VIEWER_PW);
    await claim.fill('input[name="confirm"]', VIEWER_PW);
    await claim.click('button[type="submit"]');
    // Lands authenticated in the app (no /setup hop — invitee set their own creds).
    await claim.waitForURL((url) => url.pathname === "/");

    // Viewer is a real, non-admin session: a backend POST is role_denied (403).
    const status = await claim.evaluate(async () => {
      return (
        await fetch("/api/users", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "x", role: "viewer" }),
        })
      ).status;
    });
    expect(status).toBe(403);

    // Reusing the URL from a fresh (unauth) context shows the not-usable state —
    // coarse by design (previewInvite gives no exists-vs-revoked oracle), so the
    // claim form is gone and the generic invalid copy renders.
    const reuseCtx = await browser.newContext();
    const reuse = await reuseCtx.newPage();
    await reuse.goto(inviteUrl);
    await expect(reuse.locator('input[name="username"]')).toHaveCount(0);
    await expect(reuse.getByText(/not valid|expired|already been used/i)).toBeVisible();
    await reuseCtx.close();

    // A REVOKED invite renders the same not-usable state. Mint a second invite,
    // revoke it in the console, then open it from a fresh context.
    await inviteForm.getByRole("button", { name: "Create invite link" }).click();
    const revokeUrl = (await page.locator("code.invite-url").innerText()).trim();
    await page.getByRole("button", { name: "Dismiss" }).click();
    // The only "active" invite has a Revoke button (the first is now redeemed).
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Yes" }).click();
    await expect(page.getByText("revoked")).toBeVisible();

    const revCtx = await browser.newContext();
    const rev = await revCtx.newPage();
    await rev.goto(revokeUrl);
    await expect(rev.locator('input[name="username"]')).toHaveCount(0);
    await expect(rev.getByText(/not valid|expired|already been used/i)).toBeVisible();
    await revCtx.close();

    await claimCtx.close();
  });
});
