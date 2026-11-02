import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Settings → API tokens (API v1 personal access tokens). The raw token is
 * shown once, at mint, and never again; the list never carries it. Hermetic:
 * reads are mocked by pathname.
 */
const TOKEN = "fks_pat_" + "A".repeat(43);
const LISTED = {
  id: 1,
  name: "muse",
  roleCap: "viewer",
  createdAt: "2026-10-31T00:00:00Z",
  expiresAt: "2027-01-29T00:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
  status: "active",
};

async function installSettings(page: Page, tokens: { available: boolean; tokens: unknown[] }) {
  const routes: Record<string, unknown> = {
    "/api/settings/exchange-keys/status": { db_enabled: true, exchanges: [] },
    "/api/settings/notifications": { db_enabled: true, channels: [] },
    "/api/settings/notifications/history": { db_enabled: true, entries: [] },
    "/api/health": { redis: "ok", janus: "ok", feed: "ok" },
  };
  await page.route(
    (url) => url.pathname in routes,
    (route: Route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: routes[new URL(route.request().url()).pathname] })
        : route.fallback(),
  );
  await page.route(
    (url) => url.pathname === "/api/tokens",
    (route: Route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: tokens });
      return route.fallback();
    },
  );
}

test("minting shows the token once and sends name, role and lifetime", async ({ page }) => {
  const state = { available: true, tokens: [] as unknown[] };
  await installSettings(page, state);
  let posted: Record<string, unknown> | null = null;
  await page.route(
    (url) => url.pathname === "/api/tokens",
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posted = route.request().postDataJSON();
      state.tokens = [LISTED];
      await route.fulfill({ json: { ok: true, token: TOKEN, apiToken: LISTED } });
    },
  );

  await page.goto("/settings");
  await expect(page.getByText("No API tokens")).toBeVisible();
  await page.getByPlaceholder("e.g. muse, claude, phone").fill("muse");
  await page.getByRole("button", { name: "Create token" }).click();

  await expect.poll(() => posted).toEqual({ name: "muse", role: "viewer", ttlDays: 90 });
  await expect(page.getByTestId("minted-token")).toContainText(TOKEN);
  await expect(page.locator(".tok-row", { hasText: "muse" })).toContainText("never used");

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(TOKEN)).toHaveCount(0);
});

test("revoke is two-step and posts to the token's revoke route", async ({ page }) => {
  await installSettings(page, { available: true, tokens: [LISTED] });
  let revoked = 0;
  await page.route(
    (url) => url.pathname === "/api/tokens/1/revoke",
    (route: Route) => {
      revoked += 1;
      return route.fulfill({ json: { ok: true } });
    },
  );
  await page.goto("/settings");
  // ConfirmButton keeps its aria-label; arming changes its text.
  const revoke = page.getByRole("button", { name: "Revoke token muse" });
  await revoke.click();
  expect(revoked).toBe(0);
  await expect(revoke).toHaveText('Revoke "muse"?');
  // The second click only counts after the arming cooldown.
  await expect(async () => {
    await revoke.click({ timeout: 1_000 });
    expect(revoked).toBe(1);
  }).toPass({ timeout: 10_000 });
});

test("without fks 027 the panel says tokens are off", async ({ page }) => {
  await installSettings(page, { available: false, tokens: [] });
  await page.goto("/settings");
  await expect(page.getByText(/API tokens are off on this server/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create token" })).toHaveCount(0);
});
