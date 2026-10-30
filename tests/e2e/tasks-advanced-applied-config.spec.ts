import { test, expect, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Clicking a saved config's name fills the spawn form. It used to drop the
// config's bot_id, account and webhooks, so on 2026-10-30 "apply, then
// Spawn" started a SECOND live Kraken bot beside crypto-regime: a new UUID,
// no account, so no lease. "Apply, then Save config" would also have erased
// the account and webhooks from the saved config.
//
// Asserted here: what Spawn and Save config send after applying a config.
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  id: "c1",
  name: "crypto-regime",
  image: "ghcr.io/nuniesmith/fks-bot-crypto:latest",
  mode: "live",
  cpu_limit: null,
  memory_mb: null,
  env: {},
  secrets: ["kraken"],
  bot_id: "crypto-regime",
  account: "kraken:spot:default",
  webhooks: { CRYPTO_DISCORD_WEBHOOK_URL: "crypto" },
};

async function installMocks(page: Page, sent: { spawn?: unknown; save?: unknown }): Promise<void> {
  await page.route(
    (u) => u.pathname.startsWith("/api/spawner") || u.pathname.startsWith("/api/settings"),
    (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      if (p.endsWith("/spawn") && req.method() === "POST") {
        sent.spawn = req.postDataJSON();
        return route.fulfill({
          status: 201,
          json: { container_id: "x", container_name: "fks-bot-crypto-regime", bot_id: "crypto-regime", image: CONFIG.image, mode: "live" },
        });
      }
      if (p.endsWith("/configs") && req.method() === "POST") {
        sent.save = req.postDataJSON();
        return route.fulfill({ json: { ok: true } });
      }
      if (p.endsWith("/configs")) return route.fulfill({ json: { configs: [CONFIG], total: 1 } });
      if (p.endsWith("/exchange-keys/status"))
        return route.fulfill({ json: { db_enabled: true, exchanges: [{ exchange: "kraken" }] } });
      if (p.endsWith("/containers")) return route.fulfill({ json: { containers: [] } });
      return route.fulfill({ json: {} });
    },
  );
}

test.describe("/tasks/advanced: an applied saved config keeps its identity", () => {
  test("the form names the bot and points to ↻ instead of Spawn", async ({ page }) => {
    await installMocks(page, {});
    await page.goto("/tasks/advanced");
    await page.getByRole("button", { name: "crypto-regime", exact: true }).click();

    await expect(page.getByPlaceholder("auto-generated UUID")).toHaveValue("crypto-regime");
    await expect(page.getByPlaceholder("e.g. kraken:spot:default")).toHaveValue("kraken:spot:default");
    await expect(page.getByTestId("applied-webhooks")).toContainText("CRYPTO_DISCORD_WEBHOOK_URL ← crypto");
    await expect(page.getByTestId("applied-is-a-bot")).toContainText("use ↻");
  });

  test("Spawn sends the config's bot_id, account and webhooks", async ({ page }) => {
    const sent: { spawn?: Record<string, unknown> } = {};
    await installMocks(page, sent);
    await page.goto("/tasks/advanced");
    await page.getByRole("button", { name: "crypto-regime", exact: true }).click();
    await page.getByRole("button", { name: "▶ Spawn" }).click();

    await expect.poll(() => sent.spawn).toBeTruthy();
    expect(sent.spawn).toMatchObject({
      bot_id: "crypto-regime",
      account: "kraken:spot:default",
      webhooks: { CRYPTO_DISCORD_WEBHOOK_URL: "crypto" },
    });
  });

  test("Save config keeps the account and webhooks", async ({ page }) => {
    const sent: { save?: Record<string, unknown> } = {};
    await installMocks(page, sent);
    await page.goto("/tasks/advanced");
    await page.getByRole("button", { name: "crypto-regime", exact: true }).click();
    await page.getByRole("button", { name: "Save config" }).click();

    await expect.poll(() => sent.save).toBeTruthy();
    expect(sent.save).toMatchObject({
      name: "crypto-regime",
      bot_id: "crypto-regime",
      account: "kraken:spot:default",
      webhooks: { CRYPTO_DISCORD_WEBHOOK_URL: "crypto" },
    });
  });
});
