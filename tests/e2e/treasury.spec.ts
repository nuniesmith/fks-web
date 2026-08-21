import { test, expect, type Page } from "@playwright/test";

/**
 * P3 — a DARK net-worth series must announce itself on the money surfaces.
 *
 * The spawner deliberately refuses to record a net-worth sample it cannot
 * trust: while a bot's venues are stale it writes NOTHING (bumping
 * `fks_spawner_net_worth_stale_skipped_total`) instead of carrying a fabricated
 * flat line forward, and `NetWorthSamplingPausedTooLong` pages on it. The
 * resulting hole in /treasury's figures and in the /bots net-worth chart is
 * therefore CORRECT behaviour that looks exactly like a broken chart — or,
 * worse, like "nothing happened", which on a money page is a lie.
 *
 * The global StatusBar chip already fires for these alerts, so what is asserted
 * here is only the residual gap, and each assertion targets one half of it:
 *
 *   1. the line appears on the money surfaces themselves and names them;
 *   2. it SURVIVES AN ACK — the chip is driven by `unacked_count`, which drops
 *      to 0 the instant an operator acks while the alert is still firing;
 *   3. it SURVIVES `configured:false` — the ack store being unreachable is
 *      precisely the degraded state in which the operator most needs to know
 *      the gap is deliberate, and `describeChip` renders a contentless grey
 *      "alerts ?" there;
 *   4. it stays silent when nothing is firing (no permanent scare banner).
 */

const HEALTHY = { redis: "ok", janus: "ok", feed: "ok" };

const QUIET_INBOX = {
  configured: true,
  prom_available: true,
  alerts: [],
  unacked_count: 0,
};

interface FiringOpts {
  alertname?: string;
  /** Set to model an operator who has already acknowledged the incident. */
  acked?: boolean;
  /** `false` models the ack store being unreachable. */
  configured?: boolean;
}

function firingInbox(opts: FiringOpts = {}) {
  const {
    alertname = "NetWorthSamplingPausedTooLong",
    acked = false,
    configured = true,
  } = opts;
  return {
    configured,
    prom_available: true,
    alerts: [
      {
        key: `k-${alertname}`,
        labels: { alertname, severity: "warning", channel: "money" },
        // Relative to wall-clock — a fixed past date would eventually cross
        // the alertInbox age-escalation thresholds, unrelated to what this
        // suite (the net-worth-sampling-pause banner) tests.
        activeAt: new Date(Date.now() - 35 * 60_000).toISOString(),
        age_str: "35m",
        state: "firing",
        severity_color: "",
        acked: acked
          ? { by: "jordan", at: "2026-07-29T00:35:00Z", note: "seen" }
          : null,
      },
    ],
    // The ack collapses the chip's count while the alert keeps firing — the
    // exact moment the operator loses every hint that the gap is deliberate.
    unacked_count: acked ? 0 : 1,
  };
}

/** Treasury's spawner reads, pinned so the page renders without a backend. */
async function installTreasuryData(page: Page): Promise<void> {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  await page.route("**/api/spawner/accounts", (route) =>
    route.fulfill({
      json: {
        total: 1,
        db_enabled: true,
        accounts: [
          {
            account_id: "personal-crypto",
            display_name: "Personal Crypto",
            tier: 1,
            account_class: "personal-crypto",
            venue: "kucoin",
            role: "bot-trade",
            firm: null,
            compliance_flag: "auto-fill",
            risk_caps: {},
            sizing: {},
            active: true,
            created_at: iso(90 * 86_400_000),
            updated_at: iso(3_600_000),
          },
        ],
      },
    }),
  );
  await page.route("**/api/spawner/net-worth**", (route) =>
    route.fulfill({
      json: [
        {
          bot_id: "personal-crypto",
          ts: iso(2 * 3_600_000),
          net_worth: 12_500,
          currency: "USD",
        },
        {
          bot_id: "personal-crypto",
          ts: iso(3_600_000),
          net_worth: 12_900,
          currency: "USD",
        },
      ],
    }),
  );
  await page.route("**/api/spawner/transfers**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/spawner/profit**", (route) =>
    route.fulfill({
      json: {
        account_id: "personal-crypto",
        since: null,
        db_enabled: true,
        start_ts: iso(30 * 86_400_000),
        end_ts: iso(3_600_000),
        start_net_worth: 10_000,
        end_net_worth: 12_900,
        delta: 2_900,
        deposits_in: 2_000,
        withdrawals_out: 100,
        net_inflows: 1_900,
        profit: 1_000,
        transfers: 3,
      },
    }),
  );
}

async function installShell(page: Page, inbox: unknown): Promise<void> {
  await page.route("**/api/health", (route) => route.fulfill({ json: HEALTHY }));
  await page.route("**/api/alerts/inbox", (route) =>
    route.fulfill({ json: inbox }),
  );
}

const banner = (page: Page) => page.getByTestId("sampling-paused");

test.describe("/treasury — net-worth sampling pause", () => {
  test("no banner when nothing is firing", async ({ page }) => {
    await installShell(page, QUIET_INBOX);
    await installTreasuryData(page);
    await page.goto("/treasury");
    await expect(page).toHaveTitle("Treasury — FKS Terminal");

    // The headline has rendered, so the page is past first paint and a missing
    // banner is a real absence rather than a race.
    await expect(page.getByText("All real accounts — total")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test("NetWorthSamplingPausedTooLong says the gap is deliberate and points at /monitoring", async ({
    page,
  }) => {
    await installShell(page, firingInbox());
    await installTreasuryData(page);
    await page.goto("/treasury");

    const b = banner(page);
    await expect(b).toBeVisible();
    await expect(b).toContainText(/sampling is paused/i);
    // The whole point: name the gap as intentional, not a UI fault.
    await expect(b).toContainText(/deliberate/i);
    await expect(b.getByRole("link", { name: /monitoring/i })).toHaveAttribute(
      "href",
      "/monitoring",
    );
  });

  test("BotAllVenuesStale raises the same line", async ({ page }) => {
    await installShell(page, firingInbox({ alertname: "BotAllVenuesStale" }));
    await installTreasuryData(page);
    await page.goto("/treasury");
    await expect(banner(page)).toBeVisible();
  });

  test("an unrelated firing alert does NOT raise it", async ({ page }) => {
    await installShell(page, firingInbox({ alertname: "JanusFeedLagHigh" }));
    await installTreasuryData(page);
    await page.goto("/treasury");
    await expect(page.getByText("All real accounts — total")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test("survives the ack that silences the StatusBar chip", async ({ page }) => {
    // unacked_count: 0 while the alert is still firing. Anything keyed off the
    // count (or off describeChip, which returns HIDDEN here) goes quiet; the
    // money page must not.
    await installShell(page, firingInbox({ acked: true }));
    await installTreasuryData(page);
    await page.goto("/treasury");

    await expect(page.locator("footer[role='status'] .alert-chip")).toHaveCount(0);
    await expect(banner(page)).toBeVisible();
  });

  test("survives the ack store being unreachable (configured:false)", async ({
    page,
  }) => {
    await installShell(page, firingInbox({ configured: false }));
    await installTreasuryData(page);
    await page.goto("/treasury");
    await expect(banner(page)).toBeVisible();
  });
});

// The /bots net-worth chart is the other surface the pause punches a hole in,
// and it carries the twin of the same line. Asserted here so the two copies
// cannot drift apart unnoticed.
test.describe("/bots net-worth panel — net-worth sampling pause", () => {
  test("carries the same line, even when the chart itself failed to load", async ({
    page,
  }) => {
    await installShell(page, firingInbox());
    // No /net-worth mock: the panel errors out. The banner is alert-driven, so
    // it must NOT depend on the chart having data — a dark series and a failed
    // fetch look identical to the operator otherwise.
    await page.route("**/api/spawner/net-worth**", (route) =>
      route.fulfill({ status: 500, json: { error: "down" } }),
    );
    await page.goto("/bots");

    const b = banner(page);
    await expect(b).toBeVisible();
    await expect(b).toContainText(/deliberate/i);
  });
});
