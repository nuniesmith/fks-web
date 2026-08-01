import { test, expect, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// /bots lists the two REAL-MONEY containers — crypto-spot (live funds) and
// crypto-funding (the Gate-A measurement instance, whose window cannot be
// restarted or back-filled). Stop / Restart / force-remove sat behind
// unconfirmed ~13px buttons in one row, on a page routinely opened from a
// phone. One mis-tap ended the measurement.
//
// Asserted here: no single gesture reaches a lifecycle action.
// ─────────────────────────────────────────────────────────────────────────────
const CONTAINERS = {
  containers: [
    {
      id: "abc123",
      name: "fks-bot-crypto-funding",
      image: "fks-bot-crypto-funding:latest",
      state: "running",
      status: "Up 8 days",
      mode: "paper",
      created: 1785000000,
    },
  ],
};

async function installBotsMocks(page: Page): Promise<void> {
  await page.route(
    (u) => u.pathname.startsWith("/api/spawner") || u.pathname.startsWith("/api/bots"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith("/containers")) return route.fulfill({ json: CONTAINERS });
      return route.fulfill({ json: {} });
    },
  );
}

test.describe("/bots: money-bot lifecycle needs two gestures", () => {
  test("one click on Stop does NOT stop the bot", async ({ page }) => {
    let stopCalls = 0;
    await installBotsMocks(page);
    await page.route(
      (u) => /\/stop$/.test(u.pathname),
      (route) => {
        stopCalls += 1;
        return route.fulfill({ json: { ok: true } });
      },
    );

    await page.goto("/bots");
    const stop = page.getByRole("button", { name: /^Stop$/ }).first();
    await expect(stop).toBeVisible();

    await stop.click();
    // Armed, not fired — and it must NAME the bot so the operator sees which.
    await expect(page.getByRole("button", { name: /Really stop .*crypto-funding/i })).toBeVisible();
    expect(stopCalls, "a single click must never reach the stop endpoint").toBe(0);
  });

  test("a double-tap cannot fire it either — the arming cooldown holds", async ({ page }) => {
    let stopCalls = 0;
    await installBotsMocks(page);
    await page.route(
      (u) => /\/stop$/.test(u.pathname),
      (route) => {
        stopCalls += 1;
        return route.fulfill({ json: { ok: true } });
      },
    );

    await page.goto("/bots");
    const stop = page.getByRole("button", { name: /^Stop$/ }).first();
    const box = await stop.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // A REAL double-tap: two clicks at the same point with no locator
    // resolution in between. Using a locator for the second click burns more
    // wall-clock than the cooldown itself, which would make this pass
    // vacuously — it did, on the first version of this spec.
    const t0 = Date.now();
    await page.mouse.click(cx, cy);
    await page.mouse.click(cx, cy);
    const elapsed = Date.now() - t0;

    expect(elapsed, "the two taps must land inside the cooldown to test it").toBeLessThan(500);
    expect(stopCalls, "a confirm click inside the arming cooldown must be swallowed").toBe(0);
    // And the control must still be armed, not disarmed or fired.
    await expect(page.getByRole("button", { name: /Really stop/i })).toBeVisible();
  });

  test("force-remove is two-step and says FORCE-REMOVE", async ({ page }) => {
    let removeCalls = 0;
    await installBotsMocks(page);
    await page.route(
      (u) => u.pathname.includes("/container/") && !/\/(stop|restart|logs)$/.test(u.pathname),
      (route) => {
        if (route.request().method() === "DELETE") removeCalls += 1;
        return route.fulfill({ json: { ok: true } });
      },
    );

    await page.goto("/bots");
    await page.getByRole("button", { name: "✕" }).first().click();
    await expect(page.getByRole("button", { name: /FORCE-REMOVE .*crypto-funding/i })).toBeVisible();
    expect(removeCalls, "one click must not force-remove a money bot").toBe(0);
  });
});
