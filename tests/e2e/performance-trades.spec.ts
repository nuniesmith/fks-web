import { test, expect, type Page } from "@playwright/test";

/**
 * /performance Trade History — Q-4.
 *
 * The page rendered `fmtPct(pnlPct / 100)`, but `fmtPct` does NOT multiply by
 * 100 — it fixes 2 decimals and appends `%`. The `/100` is wrong under EVERY
 * unit convention: if `pnl_percent = 11.28` means 11.28%, it renders `+0.11%`;
 * if it meant the fraction 0.1128, the correct display is ×100 and it still
 * renders `+0.00%`. Either way the operator reads a plausible-looking number
 * that is 100× off on the trade table they use to judge a strategy.
 *
 * Entry/exit are PRICES, and they went through `fmtDollar`, which force-signs
 * for P&L — "+$109403.20" for a price, and ungrouped.
 *
 * This is latent in production because `hooks.server.ts` hardwires
 * `GET /api/trades → {trades: []}`, so the rows never render. `page.route`
 * supplies the backend that does not exist yet, which is the only way to see
 * the bug at all — and is why it survived this long.
 */

const TRADES = {
  trades: [
    {
      symbol: "BTC-USDT",
      side: "buy",
      entry_price: 109403.2,
      exit_price: 121748.87,
      size: 1,
      pnl: 12345.67,
      pnl_percent: 11.28,
      open_time: "2026-07-20T13:05:00Z",
      close_time: "2026-07-28T18:41:00Z",
    },
    {
      symbol: "ETH-USDT",
      side: "sell",
      entry_price: 3921.5,
      exit_price: 3941.11,
      size: 27.7,
      pnl: -543.21,
      pnl_percent: -0.5,
      open_time: "2026-07-27T09:00:00Z",
      close_time: "2026-07-27T11:12:00Z",
    },
  ],
};

async function gotoPerformance(page: Page): Promise<void> {
  await page.route("**/api/trades", (route) => route.fulfill({ json: TRADES }));
  await page.goto("/performance");
  await expect(page.locator("tbody tr").first()).toBeVisible();
}

/** Cell text by column index: Date 0, Symbol 1, Side 2, Entry 3, Exit 4, Size 5, P&L 6, P&L% 7. */
function cell(page: Page, row: number, col: number) {
  return page.locator("tbody tr").nth(row).locator("td").nth(col);
}

test.describe("/performance trade table renders its own units", () => {
  test("the P&L % column shows the percent it was handed, not 1/100th of it", async ({
    page,
  }) => {
    await gotoPerformance(page);
    // 11.28 → "+11.28%". The bug rendered "+0.11%": still a believable trade,
    // which is exactly why nobody would catch it by eye.
    await expect(cell(page, 0, 7)).toHaveText("+11.28%");
    await expect(cell(page, 1, 7)).toHaveText("-0.50%");
  });

  test("entry and exit are prices: grouped, adaptive precision, never force-signed", async ({
    page,
  }) => {
    await gotoPerformance(page);
    await expect(cell(page, 0, 3)).toHaveText("109,403.20");
    await expect(cell(page, 0, 4)).toHaveText("121,748.87");
    // The specific defect: a price wearing a P&L's mandatory sign.
    for (const col of [3, 4]) {
      expect(await cell(page, 0, col).innerText()).not.toContain("+");
      expect(await cell(page, 0, col).innerText()).not.toContain("$");
    }
  });

  test("P&L stays a signed dollar figure, with thousands grouped (M-1)", async ({
    page,
  }) => {
    await gotoPerformance(page);
    // Ungrouped, "+$12345.67" reads as four figures at a phone glance.
    await expect(cell(page, 0, 6)).toHaveText("+$12,345.67");
    await expect(cell(page, 1, 6)).toHaveText("-$543.21");
  });

  test("the close-time stamp names its timezone (Q-5)", async ({ page }) => {
    await gotoPerformance(page);
    // `fmtDateTime` is a LOCAL wall clock; cockpit's kill-sentinel stamp is UTC
    // with a trailing Z. Unlabelled, the two are indistinguishable strings.
    await expect(cell(page, 0, 0)).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
  });
});
