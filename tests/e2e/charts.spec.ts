import { test, expect, type Page } from "@playwright/test";

/**
 * Charts E2E — the chart UI (toolbar, timeframes, indicator dropdown, panes,
 * multi-chart grid), NOT the market-data plumbing behind it.
 *
 * Why the route mocks (same strategy as cockpit.spec.ts installCockpitMocks):
 *
 * `/charts` reads history from QuestDB through the adapter's `/bars/:sym/candles`
 * seam. When QuestDB is absent — every dev box, every CI runner — that seam is
 * NOT an error: `hooks.server.ts queryCandles()` swallows the connection failure
 * and answers `200 {"candles":[]}`. The page then correctly renders its honest
 * empty state ("No data · No stored candles for MGC · 5m"), which is a
 * `.chart-overlay`. So the overlay stays up forever and every spec that waits
 * for it to clear times out:
 *
 *     expect(locator).not.toBeVisible() failed
 *     Locator: locator('.chart-overlay')   Expected: not visible  Received: visible
 *
 * That is the environment talking, not a defect: the overlay is doing exactly
 * what an empty-history response should make it do. Mocking `/bars` gives the
 * chart bars to draw, so `.chart-overlay` clearing becomes a real assertion
 * ("given history, the chart paints") instead of a check on whether this host
 * happens to run QuestDB.
 *
 * Mocked seams (all backend-dependent, none of them what these specs assert):
 *   - GET /bars/:sym/candles            → deterministic OHLCV page (QuestDB)
 *   - GET /api/chart/:sym/indicators    → well-formed series (QuestDB-derived)
 *   - GET /api/assets/:sym              → futures descriptor (QuestDB registry)
 *   - GET /api/janus/indicators/catalog → empty, i.e. the documented
 *     janus-unreachable degradation, so the Indicators menu is a fixed list
 *
 * Deliberately NOT mocked, because they are already deterministic and local:
 *   - GET /api/indicators/catalog — a static constant in hooks.server.ts
 *   - GET /sse/bars/:sym — the idle stub (JANUS_BARS_SSE_URL is unset)
 *
 * One residual: `+page.server.ts` prefetches `/api/assets/:sym` during SSR, and
 * page.route cannot intercept a server-side fetch. Nothing here asserts on that
 * value — the client's own `lookupAsset()` overwrites it on mount — so the mock
 * below is what decides `isCrypto` for every assertion.
 */

// ─── Deterministic market data ──────────────────────────────────────────────

interface MockCandle {
  timestamp: number; // ms epoch, ascending
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Fixed anchor so the same bytes are served on every run. */
const LAST_BAR_MS = Date.UTC(2026, 0, 5, 18, 0, 0);

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1D": 86_400_000,
  "1W": 604_800_000,
  "1M": 2_592_000_000,
};

/**
 * A plausible OHLCV page: ascending timestamps, high/low bracketing open/close.
 * lightweight-charts rejects unsorted or malformed bars, so the shape matters;
 * the prices do not — no assertion in this file reads a number off the chart.
 */
function makeCandles(interval: string, count = 240): MockCandle[] {
  const step = INTERVAL_MS[interval] ?? INTERVAL_MS["5m"];
  const start = LAST_BAR_MS - (count - 1) * step;
  // Tiny LCG: a stable pseudo-random walk, identical on every run.
  let seed = 1337;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out: MockCandle[] = [];
  let px = 2400;
  for (let i = 0; i < count; i++) {
    const open = px;
    const close = Math.round((open + (rnd() - 0.5) * 6) * 100) / 100;
    out.push({
      timestamp: start + i * step,
      open,
      high: Math.round((Math.max(open, close) + rnd() * 2) * 100) / 100,
      low: Math.round((Math.min(open, close) - rnd() * 2) * 100) / 100,
      close,
      volume: 100 + Math.round(rnd() * 900),
    });
    px = close;
  }
  return out;
}

/**
 * Indicator series keyed the way the page expects (`bb_upper`/`bb_middle`/
 * `bb_lower`, `rsi`, …), computed off the same candles so the times line up
 * with the chart. Only bb + rsi are exercised by these specs; anything else
 * asked for still gets a well-formed series under its own key rather than a
 * 404, so a future toggle here fails on behaviour, not on a missing mock.
 */
function makeIndicators(
  interval: string,
  specs: string[],
): Record<string, { time: number; value: number }[]> {
  const bars = makeCandles(interval);
  const at = (i: number): number => Math.floor(bars[i].timestamp / 1000);
  const out: Record<string, { time: number; value: number }[]> = {};

  for (const raw of specs) {
    const [name, ...args] = raw.split(":");
    if (!name) continue;
    if (name === "bb") {
      const period = Number(args[0]) || 20;
      const mult = Number(args[1]) || 2;
      const mid: { time: number; value: number }[] = [];
      const up: { time: number; value: number }[] = [];
      const low: { time: number; value: number }[] = [];
      for (let i = period - 1; i < bars.length; i++) {
        const win = bars.slice(i - period + 1, i + 1).map((b) => b.close);
        const mean = win.reduce((a, b) => a + b, 0) / win.length;
        const sd = Math.sqrt(
          win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length,
        );
        mid.push({ time: at(i), value: mean });
        up.push({ time: at(i), value: mean + mult * sd });
        low.push({ time: at(i), value: mean - mult * sd });
      }
      out.bb_middle = mid;
      out.bb_upper = up;
      out.bb_lower = low;
      continue;
    }
    // Everything else (rsi, atr, sma20, vwap, …) — a bounded series with
    // monotone times under the requested key.
    out[name] = bars.map((b, i) => ({
      time: at(i),
      value: name === "rsi" ? 50 + 25 * Math.sin(i / 7) : b.close,
    }));
  }
  return out;
}

/** Install every backend seam the charts pages touch. Must run BEFORE goto. */
async function installChartMocks(page: Page): Promise<void> {
  await page.route(/\/bars\/[^/]+\/candles/, (route) => {
    const url = new URL(route.request().url());
    // History pagination (`?before=`) is the backfill burst walking left. An
    // empty page there is the real "history exhausted" answer, and the page
    // converges on it in ≤3 requests (see maybeBackfill's window widening).
    if (url.searchParams.has("before"))
      return route.fulfill({ json: { candles: [] } });
    const interval = url.searchParams.get("interval") ?? "5m";
    return route.fulfill({ json: { candles: makeCandles(interval) } });
  });

  await page.route(/\/api\/chart\/[^/]+\/indicators/, (route) => {
    const url = new URL(route.request().url());
    const interval = url.searchParams.get("interval") ?? "5m";
    const specs = (url.searchParams.get("indicators") ?? "")
      .split(",")
      .filter(Boolean);
    return route.fulfill({
      json: { indicators: makeIndicators(interval, specs) },
    });
  });

  // Asset registry: futures ⇒ isCrypto=false ⇒ the SSE path. This also keeps
  // the specs off the real `wss://ws.kraken.com/v2` socket the crypto branch
  // opens — an external dependency an e2e run must never acquire.
  await page.route(/\/api\/assets\//, (route) => {
    // /api/assets/search is the toolbar's symbol lookup, a different contract.
    if (route.request().url().includes("/api/assets/search"))
      return route.fallback();
    return route.fulfill({
      json: { type: "futures", source: "rithmic", source_chain: ["rithmic"] },
    });
  });

  // janus is not running here. An empty catalog is exactly what
  // hooks.server.ts returns when janus is unreachable, so the Indicators
  // dropdown holds only its built-in TS entries.
  await page.route(/\/api\/janus\/indicators\/catalog/, (route) =>
    route.fulfill({ json: { count: 0, indicators: [] } }),
  );
}

/**
 * Navigate and wait for a state only the hydrated client can reach.
 *
 * `.chart-overlay` covers BOTH the spinner (`loading`) and the empty state
 * (`!loading && candles.length === 0`). With `/bars` mocked, it clearing proves
 * hydration ran, onMount fired, lightweight-charts loaded and the bars were
 * accepted — i.e. every click after this lands on live handlers.
 */
async function gotoCharts(page: Page): Promise<void> {
  await installChartMocks(page);
  await page.goto("/charts");
  await expect(page.locator(".chart-area")).toBeVisible();
  await expect(page.locator(".chart-overlay")).not.toBeVisible({
    timeout: 10_000,
  });
}

test.describe("Charts Page", () => {
  test("chart page loads with symbol and timeframe controls", async ({
    page,
  }) => {
    await installChartMocks(page);
    await page.goto("/charts");

    // Should see the toolbar with SYMBOL label
    await expect(page.locator(".toolbar")).toBeVisible();

    // Should have timeframe buttons
    await expect(page.locator(".tf-tab")).toHaveCount(8);

    // Should have quick pick buttons
    await expect(page.locator(".quick-picks .btn-ghost").first()).toBeVisible();

    // Should have indicator groups (overlays + sub-pane indicators)
    await expect(page.locator(".ind-group").first()).toBeVisible();

    // Chart area should exist
    await expect(page.locator(".chart-area")).toBeVisible();
  });

  test("timeframe buttons change active state", async ({ page }) => {
    await gotoCharts(page);

    // Click 15m timeframe — use aria-pressed instead of CSS class
    // (Svelte scoped styles make class checks unreliable)
    const tf15m = page.locator(".tf-tab", { hasText: "15m" });
    await tf15m.click();
    await expect(tf15m).toHaveAttribute("aria-pressed", "true");

    // The previously active 5m should no longer be pressed
    const tf5m = page.locator(".tf-tab", { hasText: /^5m$/ });
    await expect(tf5m).toHaveAttribute("aria-pressed", "false");
  });

  test("EMA indicator toggle changes state", async ({ page }) => {
    await gotoCharts(page);

    // Open the TW-style Indicators dropdown, then toggle EMA 9.
    // Menu entries are menuitemcheckbox items — use aria-checked for state.
    await page.locator("button.ind-btn", { hasText: "Indicators" }).click();
    const ema9Item = page.getByRole("menuitemcheckbox", { name: "EMA 9" });
    await expect(ema9Item).toHaveAttribute("aria-checked", "false");

    await ema9Item.click();
    await expect(ema9Item).toHaveAttribute("aria-checked", "true");

    // Toggle off (the menu stays open for multi-add)
    await ema9Item.click();
    await expect(ema9Item).toHaveAttribute("aria-checked", "false");
  });

  test("BB indicator toggle changes state", async ({ page }) => {
    await gotoCharts(page);

    // Bollinger Bands lives in the Indicators dropdown; the label carries the
    // current params (e.g. "Bollinger Bands (20, 2)"), so match on the name.
    await page.locator("button.ind-btn", { hasText: "Indicators" }).click();
    const bbItem = page.getByRole("menuitemcheckbox", {
      name: /Bollinger Bands/,
    });
    await expect(bbItem).toHaveAttribute("aria-checked", "false");

    await bbItem.click();
    await expect(bbItem).toHaveAttribute("aria-checked", "true");

    await bbItem.click();
    await expect(bbItem).toHaveAttribute("aria-checked", "false");
  });

  test("RSI sub-pane toggle shows and hides pane", async ({ page }) => {
    await gotoCharts(page);

    // RSI pane should not be visible initially
    await expect(page.locator(".ind-pane")).toHaveCount(0);

    // Toggle RSI on via the Indicators dropdown (label includes the period)
    await page.locator("button.ind-btn", { hasText: "Indicators" }).click();
    const rsiItem = page.getByRole("menuitemcheckbox", { name: "RSI 14" });
    await rsiItem.click();
    await expect(rsiItem).toHaveAttribute("aria-checked", "true");

    // RSI pane should now exist in the DOM — the pane label is the base name,
    // with the parameterized title ("RSI 14") in the pane controls
    await expect(page.locator(".ind-pane")).toHaveCount(1);
    await expect(page.locator(".pane-label", { hasText: "RSI" })).toBeVisible();
    await expect(
      page.locator(".pane-title", { hasText: "RSI 14" }),
    ).toBeVisible();

    // Toggle RSI off
    await rsiItem.click();
    await expect(rsiItem).toHaveAttribute("aria-checked", "false");
    await expect(page.locator(".ind-pane")).toHaveCount(0);
  });

  test("quick picks include futures and crypto symbols", async ({ page }) => {
    await installChartMocks(page);
    await page.goto("/charts");

    const qp = page.locator(".quick-picks");
    await expect(qp).toBeVisible();

    // Futures
    await expect(qp.locator("button", { hasText: "MGC" })).toBeVisible();
    await expect(qp.locator("button", { hasText: "MES" })).toBeVisible();

    // Crypto (displayed without /USD suffix)
    await expect(qp.locator("button", { hasText: "BTC" })).toBeVisible();
    await expect(qp.locator("button", { hasText: "ETH" })).toBeVisible();
  });

  test("data source status badge is visible", async ({ page }) => {
    await installChartMocks(page);
    await page.goto("/charts");

    await expect(page.locator(".status-badges")).toBeVisible();
    await expect(page.locator(".sym-badge")).toBeVisible();
    await expect(page.locator(".tf-badge")).toBeVisible();
  });

  test("quick pick selects symbol and updates badge", async ({ page }) => {
    await gotoCharts(page);

    // Click MES quick pick
    const mesBtn = page.locator(".quick-picks button", { hasText: "MES" });
    await mesBtn.click();

    // Symbol badge should update
    await expect(page.locator(".sym-badge")).toHaveText("MES");
    // MES button should be active
    await expect(mesBtn).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("Multi-Chart Grid", () => {
  /**
   * Navigate and wait for hydration.
   *
   * `load` is NOT a hydration signal: the whole toolbar is server-rendered, so
   * every `.layout-btn` is visible, enabled and stable — i.e. Playwright-
   * actionable — before Svelte has attached a single onclick. A click in that
   * window is silently dropped and never retried, which is exactly how
   * "layout switch changes grid" failed:
   *
   *     expect(locator).toBeChecked() failed
   *     Locator: getByRole('radio', { name: /1×2/ })
   *     Expected: checked  Received: unchecked
   *     9 × locator resolved to <button role="radio" aria-checked="false" …>
   *
   * (Confirmed by hand: the first click leaves aria-checked="false" forever; a
   * second click 1.5 s later flips it to "true" and drops the grid to 2 charts.)
   *
   * `MiniChart` gives a real signal: it ships `loading=true` in the SSR HTML and
   * only clears `.mc-loading` in initChart()'s `finally`, which needs onMount
   * plus the lightweight-charts dynamic import. Zero spinners ⇒ all four
   * children mounted ⇒ the parent's handlers are live.
   */
  async function gotoGrid(page: Page): Promise<void> {
    await installChartMocks(page);
    await page.goto("/charts/grid");
    await expect(page.locator(".mc-loading")).toHaveCount(0, {
      timeout: 10_000,
    });
  }

  test("grid page loads with layout controls", async ({ page }) => {
    await gotoGrid(page);

    // Toolbar with MULTI-CHART label
    await expect(page.locator(".grid-toolbar")).toBeVisible();
    await expect(page.locator(".toolbar-label")).toContainText("MULTI-CHART");

    // Layout buttons (use web-first toHaveCount)
    await expect(page.locator(".layout-btn")).toHaveCount(3);

    // Symbol slots
    await expect(page.locator(".slot-btn").first()).toBeVisible();
  });

  test("layout switch changes grid", async ({ page }) => {
    await gotoGrid(page);

    // Default should be 2x2 (4 charts) — use web-first toHaveCount
    await expect(page.locator(".mini-chart")).toHaveCount(4);

    // Switch to 1x2 — use aria-checked for reliable state check
    const btn1x2 = page.getByRole("radio", { name: /1×2/ });
    await btn1x2.click();
    await expect(btn1x2).toBeChecked();
    await expect(page.locator(".mini-chart")).toHaveCount(2);

    // Switch to 1x1
    const btn1x1 = page.getByRole("radio", { name: /1×1/ });
    await btn1x1.click();
    await expect(btn1x1).toBeChecked();
    await expect(page.locator(".mini-chart")).toHaveCount(1);
  });

  test("symbol slot is editable", async ({ page }) => {
    await gotoGrid(page);

    // Wait for the grid to fully render
    await expect(page.locator(".mini-chart").first()).toBeVisible();

    // Click first symbol slot to enter edit mode
    const firstSlot = page.getByRole("button", { name: /Symbol slot 1/ });
    await firstSlot.click();

    // Should show an input — use role-based locator with generous timeout
    // (the input replaces the button via Svelte {#if} block)
    const input = page.getByLabel(/Edit symbol 1/);
    await expect(input).toBeVisible({ timeout: 3_000 });

    // Clear existing value, type a new symbol and commit via dispatched Enter
    // (Playwright's locator.press("Enter") doesn't reliably trigger Svelte 5's
    // onkeydown handler, so we dispatch the KeyboardEvent directly)
    await input.fill("AAPL");
    // Allow Svelte to process the input event and update bind:value
    await page.waitForTimeout(200);
    await input.evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Slot should now show AAPL (button re-appears after commit)
    await expect(
      page.getByRole("button", { name: /Symbol slot 1: AAPL/ }),
    ).toBeVisible();
  });
});
