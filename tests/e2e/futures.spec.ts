import { test, expect, type Page } from "@playwright/test";

/**
 * /futures — P4.
 *
 * `v.updated` on a funding-bot venue row is the last TRADE EVENT stamp, not a
 * poll stamp. The paper funding bot marks its book on trade events, so a
 * perfectly healthy idle bot reports 15+ hours here. Rendering that as a bare
 * "updated 16h ago" reads as breakage to a phone-glancing operator, and any
 * staleness threshold applied to it would turn /futures permanently amber
 * during the Gate-A window — training the operator to ignore the amber that IS
 * load-bearing on /exchanges and /cockpit.
 *
 * These specs pin BOTH halves: the copy names the mechanism, and nothing
 * flags the stamp.
 */

const SIXTEEN_HOURS_S = 16 * 3600;

function fundingStatus(updatedEpochSecs: number) {
  return {
    spot: null,
    funding: {
      bot: "crypto-funding",
      market: "futures",
      mode: "paper",
      uptime_secs: 86_400,
      net_worth_usd: 10_000,
      pnl_usd: 0,
      signals_total: 12,
      trades_total: 3,
      wins: 2,
      losses: 1,
      win_rate: 0.667,
      exchanges: [
        {
          exchange: "kucoin",
          mode: "paper",
          cash_asset: "USDT",
          cash: 10_000,
          total_value: 10_000,
          max_drift: 0,
          triggered: false,
          last_rebalance: null,
          updated: updatedEpochSecs,
          holdings: [],
        },
      ],
      positions: [],
      recent_events: [],
    },
  };
}

async function gotoFutures(page: Page, updatedEpochSecs: number): Promise<void> {
  await page.route("**/api/exchanges/status", (route) =>
    route.fulfill({ json: fundingStatus(updatedEpochSecs) }),
  );
  // Rithmic stays gated off so the page renders only the crypto-futures half.
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ json: { rithmic: false } }),
  );
  await page.goto("/futures");
  await expect(page).toHaveTitle("Futures — FKS Terminal");
}

test.describe("futures venue trade-event stamp (P4)", () => {
  test("a 16h-old stamp is labelled as a trade-event mark, not a bare age", async ({
    page,
  }) => {
    await gotoFutures(page, Math.floor(Date.now() / 1000) - SIXTEEN_HOURS_S);

    const meta = page.locator(".venue-meta").first();
    await expect(meta).toContainText("marks on trade events — last 16h ago");

    // The pre-P4 copy said only "updated 16h ago". If that ever comes back, an
    // operator glancing at the phone reads a healthy idle bot as a dead feed.
    await expect(meta).not.toContainText(/(^|[^-] )updated 16h ago/);
  });

  test("the stamp is NEVER flagged stale — no Freshness, no warn styling", async ({
    page,
  }) => {
    await gotoFutures(page, Math.floor(Date.now() / 1000) - SIXTEEN_HOURS_S);

    const meta = page.locator(".venue-meta").first();
    await expect(meta).toBeVisible();
    // Binding rule: a 15+ hour venue stamp on the paper funding bot is HEALTHY
    // IDLE. Attaching Freshness (or any threshold) to `v.updated` is the M7
    // sweep's trap — see the guard-rail comment at the render site.
    await expect(meta.locator(".freshness")).toHaveCount(0);
    await expect(page.locator(".freshness.warn")).toHaveCount(0);
  });

  test("a fresh stamp uses the same mechanism-naming copy", async ({ page }) => {
    // Same wording at both ends of the range — the copy describes HOW the
    // number is produced, so it must not read as an exception for old values.
    await gotoFutures(page, Math.floor(Date.now() / 1000) - 5);

    await expect(page.locator(".venue-meta").first()).toContainText(
      /marks on trade events — last \d+s ago/,
    );
  });
});
