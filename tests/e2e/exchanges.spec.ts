import { test, expect, type Page } from "@playwright/test";

/**
 * /exchanges and /futures async states — Q-1.
 *
 * Both pages used to gate on `{#if !doc}` alone, which made
 * "…status server didn't respond" the GUARANTEED first paint: the sentence was
 * in the first byte of SSR HTML on every single load, before any fetch had been
 * attempted. An operator who meets that sentence every cold load learns it is
 * startup noise — and that is precisely the sentence that must stay alarming
 * when a real-money book has gone unobserved.
 *
 * `AsyncSection` splits the two-way branch into three: skeleton while asking,
 * red EmptyState once we actually know, data when there is data.
 *
 * NOTE ON FILE PLACEMENT: the /futures cases live here rather than in
 * `futures.spec.ts` because this change lands under exclusive ownership of
 * `exchanges.spec.ts`; `futures.spec.ts` belongs to the P4 trade-event-stamp
 * suite and is owned by another stream. Both routes consume the same
 * `/api/exchanges/status` poll, so the fixtures are shared anyway.
 */

const OUTAGE_SPOT = "The spot-portfolio bot's status server didn't respond";
const OUTAGE_FUTURES = "The funding bot's status server didn't respond";

/** A healthy spot document. */
function spotDoc() {
  return {
    bot: "crypto-spot",
    market: "spot",
    mode: "live",
    uptime_secs: 86_400,
    net_worth_usd: 12_345.67,
    pnl_usd: 345.67,
    signals_total: 40,
    trades_total: 9,
    wins: 5,
    losses: 4,
    win_rate: 0.555,
    exchanges: [
      {
        exchange: "kraken",
        mode: "live",
        cash_asset: "USD",
        cash: 1_000,
        total_value: 12_345.67,
        max_drift: 0.01,
        triggered: false,
        last_rebalance: null,
        updated: Math.floor(Date.now() / 1000) - 30,
        holdings: [
          {
            asset: "BTC",
            qty: 0.25,
            price: 45_382.68,
            value: 11_345.67,
            weight: 0.919,
            target_weight: 0.9,
          },
        ],
      },
    ],
    positions: [],
    recent_events: [],
  };
}

/** A healthy funding (crypto-futures, paper) document. */
function fundingDoc() {
  return {
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
        // 16h — HEALTHY IDLE for a bot that marks its book on trade events.
        updated: Math.floor(Date.now() / 1000) - 16 * 3600,
        holdings: [],
      },
    ],
    positions: [],
    recent_events: [],
  };
}

/**
 * Route `/api/exchanges/status` so it NEVER settles — the "still asking" state.
 *
 * Returns a `release` you MUST call before the test ends. A handler that simply
 * returns (`page.route(url, () => {})`) leaves the request pending, and
 * `browserContext.close()` then fails with "Target page, context or browser has
 * been closed" — the test reports red for a reason that has nothing to do with
 * the page. Observed exactly that on the first run of this suite.
 */
async function hangStatus(page: Page): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/exchanges/status", async (route) => {
    await gate;
    await route.abort();
  });
  return release;
}

/**
 * Prometheus range query used by `NetWorthHistory`, which mounts inside the
 * /exchanges SUCCESS branch. Must be stubbed: unstubbed it 502s against the dev
 * adapter, and a chart error overlay on top of a lightweight-charts mount was
 * enough to crash the tab outright on the first run of this suite. Stubbing it
 * also keeps the suite hermetic — an e2e for async states must not depend on a
 * live Prometheus.
 */
async function stubNetWorthHistory(page: Page): Promise<void> {
  await page.route("**/api/metrics/query_range**", (route) =>
    route.fulfill({
      json: { status: "success", data: { resultType: "matrix", result: [] } },
    }),
  );
}

/**
 * Navigate, then wait until the client has ACTUALLY issued the status poll.
 *
 * Without this the suite can silently measure SSR output instead of the
 * hydrated client: the never-fetched skeleton is server-rendered, so
 * `expect(asking).toBeVisible()` would pass on a page whose JS never ran, and
 * the error-branch assertions would time out for the same reason. Observed both
 * — two error-branch tests failed at exactly the 5s expect timeout with the page
 * still showing the SSR skeleton, purely because a concurrent smoke run had vite
 * cold-compiling the module graph.
 *
 * `waitForRequest` is armed BEFORE `goto` (the poll fires from an `$effect`,
 * i.e. after hydration, which can be after the `load` event in dev) and is
 * bounded so a genuinely dead page fails loudly rather than hanging. 10s is
 * chosen against the 15s per-test budget in `playwright.config.ts`: the
 * assertions after it resolve in milliseconds once hydration has happened, so
 * the wait gets essentially the whole budget.
 *
 * DO NOT "fix" a flaky run by deleting this wait. It is the only thing standing
 * between this suite and silently grading the server-rendered skeleton, which
 * would make the never-fetched tests pass no matter what the client does. If it
 * times out, hydration really did not happen — check the box, not the spec. (It
 * timed out repeatedly on the machine this landed on, where two sibling dev
 * servers had swap at 100%; `smoke.spec.ts` failed harder on pristine `main`
 * under the same pressure, and this suite went 13/13 once the box recovered.)
 */
async function gotoAndPoll(page: Page, path: string): Promise<void> {
  const polled = page.waitForRequest("**/api/exchanges/status", {
    timeout: 10_000,
  });
  await page.goto(path);
  await polled;
}

/** Keep Rithmic gated off so /futures renders only the crypto-futures half. */
async function gateRithmicOff(page: Page): Promise<void> {
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ json: { rithmic: false } }),
  );
  await page.route("**/api/futures/symbols", (route) =>
    route.fulfill({ json: { symbols: [] } }),
  );
}

/**
 * Both locators are scoped to a DIRECT CHILD of the page container, which is
 * where AsyncSection's branches land. Unscoped would be wrong, not merely
 * loose: `NetWorthHistory` (inside the /exchanges success branch) has its own
 * `Skeleton` and its own `variant="error"` EmptyState for the Prometheus range
 * query, and the Rithmic panels on /futures have neutral ones. A global
 * `.empty-state.error` count would confuse a chart's failure with the bot
 * outage this suite is about.
 */
const asking = (page: Page, pageClass: string) =>
  page.locator(`.${pageClass} > .as-asking`);
const outage = (page: Page, pageClass: string) =>
  page.locator(`.${pageClass} > .empty-state.error`);

// ─────────────────────────────────────────────────────────────────────────────
// 1. The reported defect: the outage copy was in the first painted byte.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("Q-1 first painted byte", () => {
  // `outageCopy`, not `outage` — `outage` is the locator helper above and
  // shadowing it here would silently compare a string to a Locator.
  for (const { path, outageCopy } of [
    { path: "/exchanges", outageCopy: OUTAGE_SPOT },
    { path: "/futures", outageCopy: OUTAGE_FUTURES },
  ]) {
    test(`${path} SSR HTML does not ship the outage copy`, async ({ page }) => {
      // Raw SSR bytes — no JS, no hydration, no fetch has happened yet.
      const res = await page.request.get(path);
      expect(res.ok()).toBe(true);
      const html = await res.text();

      // The regression this whole item exists to prevent. Before Q-1 this
      // string was present on every single load of both routes.
      expect(html).not.toContain(outageCopy);

      // …and the honest state IS shipped: we are asking, so we say so.
      expect(html).toContain('aria-label="Loading"');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. never-fetched -> skeleton (and still no outage copy on screen)
// ─────────────────────────────────────────────────────────────────────────────
test.describe("Q-1 never-fetched", () => {
  test("/exchanges shows a skeleton, not an outage, while the poll is in flight", async ({
    page,
  }) => {
    const release = await hangStatus(page);
    try {
      await gotoAndPoll(page, "/exchanges");

      await expect(asking(page, "exchanges-page")).toBeVisible();
      await expect(page.getByText(OUTAGE_SPOT)).toHaveCount(0);
      await expect(outage(page, "exchanges-page")).toHaveCount(0);
    } finally {
      release();
    }
  });

  test("/futures shows a skeleton, not an outage, while the poll is in flight", async ({
    page,
  }) => {
    await gateRithmicOff(page);
    const release = await hangStatus(page);
    try {
      await gotoAndPoll(page, "/futures");

      await expect(asking(page, "futures-page")).toBeVisible();
      await expect(page.getByText(OUTAGE_FUTURES)).toHaveCount(0);
      // The Rithmic panel's own "not configured" EmptyState is neutral and
      // correct; only an `.error` one would be the outage state.
      await expect(outage(page, "futures-page")).toHaveCount(0);
    } finally {
      release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. fetched-and-failed -> the outage copy, and it is RED
// ─────────────────────────────────────────────────────────────────────────────
test.describe("Q-1 fetched-and-failed", () => {
  test("/exchanges: adapter answered with no spot document -> red outage", async ({
    page,
  }) => {
    // The real shape when the bot's status server is down: hooks.server.ts
    // answers 200 with `spot: null`. The adapter spoke; the bot did not.
    await page.route("**/api/exchanges/status", (route) =>
      route.fulfill({ json: { spot: null, funding: fundingDoc() } }),
    );
    await gotoAndPoll(page, "/exchanges");

    const err = outage(page, "exchanges-page");
    await expect(err).toBeVisible();
    await expect(err).toContainText("No spot-portfolio bot status available");
    await expect(err).toContainText(OUTAGE_SPOT);
    // Grey is what this shipped as before Q-1. Cockpit's equivalent outage is
    // red, and an unobserved real-money book is not a neutral fact.
    await expect(err).toHaveClass(/\berror\b/);
    await expect(asking(page, "exchanges-page")).toHaveCount(0);
  });

  test("/futures: adapter answered with no funding document -> red outage", async ({
    page,
  }) => {
    await gateRithmicOff(page);
    await page.route("**/api/exchanges/status", (route) =>
      route.fulfill({ json: { spot: spotDoc(), funding: null } }),
    );
    await gotoAndPoll(page, "/futures");

    const err = outage(page, "futures-page");
    await expect(err).toBeVisible();
    await expect(err).toContainText("No futures bot status available");
    await expect(err).toContainText(OUTAGE_FUTURES);
    await expect(err).toHaveClass(/\berror\b/);
    await expect(asking(page, "futures-page")).toHaveCount(0);
  });

  // THE MONEY-SAFETY CASE. `updatedAt` is null both while asking AND after a
  // rejected fetch, so branching the skeleton on `updatedAt === null` alone
  // would shimmer a loading animation forever against a status server that is
  // refusing connections — a calm animation over an unobserved book, strictly
  // worse than the bug Q-1 fixes. `error` must stay wired.
  test("/exchanges: a refused connection reaches the red outage, not an endless skeleton", async ({
    page,
  }) => {
    await page.route("**/api/exchanges/status", (route) =>
      route.abort("connectionrefused"),
    );
    await gotoAndPoll(page, "/exchanges");

    const err = outage(page, "exchanges-page");
    await expect(err).toBeVisible({ timeout: 5_000 });
    await expect(err).toContainText(OUTAGE_SPOT);
    await expect(asking(page, "exchanges-page")).toHaveCount(0);
  });

  test("/futures: a refused connection reaches the red outage, not an endless skeleton", async ({
    page,
  }) => {
    await gateRithmicOff(page);
    await page.route("**/api/exchanges/status", (route) =>
      route.abort("connectionrefused"),
    );
    await gotoAndPoll(page, "/futures");

    const err = outage(page, "futures-page");
    await expect(err).toBeVisible({ timeout: 5_000 });
    await expect(err).toContainText(OUTAGE_FUTURES);
    await expect(asking(page, "futures-page")).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. success -> data, no skeleton, no outage
// ─────────────────────────────────────────────────────────────────────────────
test.describe("Q-1 success", () => {
  test("/exchanges renders venue data with no loading or outage state", async ({
    page,
  }) => {
    await stubNetWorthHistory(page);
    await page.route("**/api/exchanges/status", (route) =>
      route.fulfill({ json: { spot: spotDoc(), funding: fundingDoc() } }),
    );
    await gotoAndPoll(page, "/exchanges");

    await expect(page.getByText("Net worth (real venues)")).toBeVisible();
    await expect(page.locator("table.holdings")).toBeVisible();
    await expect(page.getByText(OUTAGE_SPOT)).toHaveCount(0);
    await expect(outage(page, "exchanges-page")).toHaveCount(0);
    await expect(asking(page, "exchanges-page")).toHaveCount(0);
    // The success branch renders the caller's content with NO wrapper element,
    // so the page's own flex children are still direct children of .page.
    await expect(page.locator(".exchanges-page > .stat-row")).toHaveCount(1);
    await expect(page.locator(".exchanges-page > .venue-grid")).toHaveCount(1);
  });

  test("/futures renders funding data with no loading or outage state", async ({
    page,
  }) => {
    await gateRithmicOff(page);
    await page.route("**/api/exchanges/status", (route) =>
      route.fulfill({ json: { spot: spotDoc(), funding: fundingDoc() } }),
    );
    await gotoAndPoll(page, "/futures");

    await expect(page.getByText("Futures paper PnL")).toBeVisible();
    await expect(page.getByText(OUTAGE_FUTURES)).toHaveCount(0);
    await expect(outage(page, "futures-page")).toHaveCount(0);
    await expect(asking(page, "futures-page")).toHaveCount(0);
    await expect(page.locator(".futures-page > .stat-row")).toHaveCount(1);
    // P4's trade-event copy still renders inside the snippet — a 16h stamp on
    // the paper funding bot is HEALTHY IDLE and must never be flagged.
    await expect(page.locator(".venue-meta").first()).toContainText(
      "marks on trade events — last 16h ago",
    );
  });
});
