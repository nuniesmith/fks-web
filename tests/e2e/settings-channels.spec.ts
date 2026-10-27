import { test, expect, type Route } from "@playwright/test";

/**
 * Settings → Notifications: a channel can be a bot's own (fks-spawner #71).
 * Its webhook is set into a bot at spawn (`webhooks:` on the bot's config),
 * and FKS sends it no platform events. Hermetic: the page's reads are mocked
 * by pathname.
 */
async function installSettings(page: import("@playwright/test").Page) {
  const routes: Record<string, unknown> = {
    "/api/settings/exchange-keys/status": { db_enabled: true, exchanges: [] },
    "/api/settings/notifications": {
      db_enabled: true,
      channels: [
        { name: "ops", kind: "discord_webhook", events: [], updated_at: "2026-10-27", platform_events: true },
        { name: "crypto", kind: "discord_webhook", events: [], updated_at: "2026-10-27", platform_events: false },
      ],
    },
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
}

test("a bot's own channel is marked, and saving one sends platform_events: false", async ({ page }) => {
  await installSettings(page);
  let posted: Record<string, unknown> | null = null;
  await page.route(
    (url) => url.pathname === "/api/settings/notifications",
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posted = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, name: "crypto" } });
    },
  );
  await page.goto("/settings");
  const crypto = page.locator(".cred-row", { hasText: "crypto" });
  await expect(crypto).toContainText("a bot's own");
  await expect(page.locator(".cred-row", { hasText: "ops" })).toContainText("all events");

  const toggle = page.getByTestId("channel-platform-events");
  await expect(async () => {
    await toggle.uncheck();
    await expect(page.getByText("Off: a bot's own channel.")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  // The event filter doesn't apply to it, so it's hidden.
  await expect(page.getByText("Send all events (catch-all)")).toBeHidden();
  await page.locator("#channel-name").fill("crypto");
  await page.locator("#channel-url").fill("https://discord.com/api/webhooks/1/abc");
  await expect(page.getByText("webhooks: {ENV_VAR: crypto}")).toBeVisible();
  await page.getByRole("button", { name: "Save Channel" }).click();
  await expect.poll(() => posted).toEqual({
    name: "crypto",
    kind: "discord_webhook",
    url: "https://discord.com/api/webhooks/1/abc",
    events: [],
    platform_events: false,
  });
});
