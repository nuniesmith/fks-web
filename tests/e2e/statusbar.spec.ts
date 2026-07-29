import { test, expect, type Page } from "@playwright/test";

/**
 * StatusBar honesty — R3 (app-wide alert chip) + R5 (health dots).
 *
 * Both bugs were the same shape: a dead signal rendering identically to a
 * healthy one. The chip vanished when Prometheus or the inbox poll died, and
 * the three health dots froze on their last-good colour forever because only a
 * SUCCESSFUL /api/health could ever change them. The StatusBar is in the shell,
 * so on 18 of the 20 routes it is the *only* alert surface — a hidden chip is a
 * positive claim of all-quiet.
 *
 * Both thresholds are minutes-scale by design (a blip must not flap grey chrome
 * onto every page), so these specs drive `page.clock` rather than waiting in
 * real time. The clock is installed BEFORE `goto`, so the app's own
 * `Date.now()`, its 15s health interval, its 30s inbox poll and its 1s
 * staleness ticker all move together.
 */

const HEALTHY = { redis: "ok", janus: "ok", feed: "ok" };

const QUIET_INBOX = {
  configured: true,
  prom_available: true,
  alerts: [],
  unacked_count: 0,
};

function firing(severity: string) {
  return {
    key: `k-${severity}`,
    labels: { alertname: "BotAllVenuesStale", severity, channel: "money" },
    activeAt: "2026-07-29T00:00:00Z",
    age_str: "5m",
    state: "firing",
    severity_color: "",
    acked: null,
  };
}

/** Everything the shell polls, pinned to a benign default. */
async function installShellMocks(
  page: Page,
  opts: { health?: () => unknown | null; inbox?: () => unknown | null } = {},
): Promise<void> {
  await page.route("**/api/health", (route) => {
    const body = opts.health ? opts.health() : HEALTHY;
    if (body === null) return route.abort("failed");
    return route.fulfill({ json: body });
  });
  await page.route("**/api/alerts/inbox", (route) => {
    const body = opts.inbox ? opts.inbox() : QUIET_INBOX;
    if (body === null) return route.abort("failed");
    return route.fulfill({ json: body });
  });
}

const bar = (page: Page) => page.locator('footer[role="status"]');
const chip = (page: Page) => bar(page).locator(".alert-chip");

test.describe("R5 — health dots must not freeze on last-good", () => {
  test("go grey and drop their frozen values once /api/health stops answering", async ({
    page,
  }) => {
    let healthUp = true;
    await installShellMocks(page, { health: () => (healthUp ? HEALTHY : null) });
    await page.clock.install();
    await page.goto("/");

    // Baseline: a real success, so the dots are entitled to say "healthy".
    const redis = bar(page).locator('.status-item[aria-label="Redis: healthy"]');
    await expect(redis).toBeVisible();
    await expect(redis).toContainText("ok");
    await expect(bar(page).locator(".status-agg")).toHaveAttribute(
      "aria-label",
      "All systems healthy",
    );

    // The adapter dies / the phone loses the network. No payload will ever
    // arrive again, so ONLY the passage of time can correct the display.
    healthUp = false;
    await page.clock.runFor(60_000); // 4 missed 15s ticks > the 45s threshold

    await expect(
      bar(page).locator('.status-item[aria-label="Redis: unknown"]'),
    ).toBeVisible();
    await expect(
      bar(page).locator('.status-item[aria-label="Janus: unknown"]'),
    ).toBeVisible();
    await expect(
      bar(page).locator('.status-item[aria-label="Feed: unknown"]'),
    ).toBeVisible();

    // The frozen "ok" strings go with them — a stale verdict beside a grey dot
    // is the very claim we just withdrew.
    await expect(bar(page).locator(".health-val")).toHaveCount(0);
  });

  test("the aggregate says the dashboard cannot see the backends, not DEGRADED", async ({
    page,
  }) => {
    let healthUp = true;
    await installShellMocks(page, { health: () => (healthUp ? HEALTHY : null) });
    await page.clock.install();
    await page.goto("/");
    await expect(bar(page).locator(".status-agg")).toContainText("OK");

    healthUp = false;
    await page.clock.runFor(60_000);

    const agg = bar(page).locator(".status-agg");
    // "?" not "DEGRADED": we are not asserting a fault, only that we cannot tell.
    await expect(agg).toContainText("?");
    await expect(agg).not.toContainText("DEGRADED");
    await expect(agg).toHaveAttribute(
      "aria-label",
      /cannot see the backends/,
    );
  });

  test("the health feed's own age is on screen and goes stale", async ({ page }) => {
    let healthUp = true;
    await installShellMocks(page, { health: () => (healthUp ? HEALTHY : null) });
    await page.clock.install();
    await page.goto("/");

    const fresh = bar(page).locator(".freshness");
    // Wait for a real success first — before one, Freshness correctly reads
    // "age unknown" (grey), which would make the flip below prove nothing.
    await expect(bar(page).locator('.status-item[aria-label="Redis: healthy"]')).toBeVisible();
    await expect(fresh).toContainText("health");
    await expect(fresh).not.toHaveClass(/warn|unknown/);

    healthUp = false;
    await page.clock.runFor(60_000);

    // Amber (stale) for the AGE — that value is real and measurably old —
    // while the dots above are grey (unknown). Same split Freshness draws.
    await expect(fresh).toHaveClass(/warn/);
    await expect(fresh).toContainText("not refreshing");
  });

  test("a recovered backend turns the dots green again", async ({ page }) => {
    let healthUp = true;
    await installShellMocks(page, { health: () => (healthUp ? HEALTHY : null) });
    await page.clock.install();
    await page.goto("/");
    await expect(bar(page).locator('.status-item[aria-label="Redis: healthy"]')).toBeVisible();

    healthUp = false;
    await page.clock.runFor(60_000);
    await expect(bar(page).locator('.status-item[aria-label="Redis: unknown"]')).toBeVisible();

    healthUp = true;
    await page.clock.runFor(20_000);
    await expect(bar(page).locator('.status-item[aria-label="Redis: healthy"]')).toBeVisible();
  });
});

test.describe("R3 — the alert chip must not vanish when the pager is dead", () => {
  test("goes grey-unknown once Prometheus has been unreachable for two polls", async ({
    page,
  }) => {
    await installShellMocks(page, {
      inbox: () => ({ ...QUIET_INBOX, prom_available: false }),
    });
    await page.clock.install();
    await page.goto("/");

    // First response only: debounced, because an 8s upstream timeout also
    // reports prom_available:false and must not flap grey onto every page.
    await page.waitForResponse("**/api/alerts/inbox");
    await expect(chip(page)).toHaveCount(0);

    await page.clock.runFor(31_000); // second poll

    await expect(chip(page)).toBeVisible();
    await expect(chip(page)).toHaveClass(/unknown/);
    await expect(chip(page)).toContainText("alerts ?");
    await expect(chip(page)).toHaveAttribute("title", /Prometheus is unreachable/);
    // Prometheus down means Alertmanager is receiving nothing either — the
    // operator has no out-of-band fallback at that moment and must be told.
    await expect(chip(page)).toHaveAttribute("title", /Alertmanager/);
    // Grey, not red: "we cannot tell" must not compete with a real alarm.
    await expect(chip(page)).not.toHaveClass(/critical/);
  });

  test("goes grey-unknown when our own inbox poll stops succeeding", async ({ page }) => {
    let inboxUp = true;
    await installShellMocks(page, { inbox: () => (inboxUp ? QUIET_INBOX : null) });
    await page.clock.install();
    await page.goto("/");

    await page.waitForResponse("**/api/alerts/inbox");
    await expect(chip(page)).toHaveCount(0); // genuinely quiet, recently verified

    inboxUp = false;
    await page.clock.runFor(95_000); // past the 90s no-success threshold

    await expect(chip(page)).toHaveClass(/unknown/);
    await expect(chip(page)).toHaveAttribute("title", /no successful inbox poll/);
  });

  test("still shows a real count when the ack ledger is down but alerts are firing", async ({
    page,
  }) => {
    // Prometheus up, alerts firing, no outage at all — the old chip reported
    // all-quiet here because `configured:false` zeroed the count.
    await installShellMocks(page, {
      inbox: () => ({
        configured: false,
        prom_available: true,
        alerts: [firing("critical"), firing("warning")],
        unacked_count: 2,
      }),
    });
    await page.clock.install();
    await page.goto("/");

    await expect(chip(page)).toBeVisible();
    await expect(chip(page)).toHaveClass(/critical/);
    await expect(chip(page)).toContainText("2 unacked");
    await expect(chip(page)).toHaveAttribute(
      "title",
      /cannot be acknowledged here/,
    );
  });

  test("stays hidden while a recent successful poll says all-quiet", async ({ page }) => {
    await installShellMocks(page);
    await page.clock.install();
    await page.goto("/");

    await page.waitForResponse("**/api/alerts/inbox");
    await page.clock.runFor(60_000);
    // Two healthy polls in: `null` still means exactly one thing.
    await expect(chip(page)).toHaveCount(0);
  });

  test("the chip is app-wide, not just on /monitoring", async ({ page }) => {
    await installShellMocks(page, {
      inbox: () => ({ ...QUIET_INBOX, prom_available: false }),
    });
    await page.clock.install();
    await page.goto("/charts");
    // /charts hydrates slowly; without this the clock can jump before the poll
    // has even started, leaving the streak at 1.
    await page.waitForResponse("**/api/alerts/inbox");
    await page.clock.runFor(31_000);
    await expect(chip(page)).toHaveClass(/unknown/);
    await expect(chip(page)).toHaveAttribute("href", "/monitoring");
  });
});
