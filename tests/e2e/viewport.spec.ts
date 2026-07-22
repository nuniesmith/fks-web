import { test, expect, type Page } from "@playwright/test";
import {
  cockpitState,
  exchangesStatus,
  openPosition,
  telemetryScraped,
  type GateRowView,
} from "./fixtures/cockpit";

// Regression guard for the "short viewing windows + weird sub-window
// scrolling" complaint (UI Phase 1). On a laptop viewport the cockpit —
// the armed-futures kill-switch page — must let the operator reach its
// below-fold risk-gate / telemetry / order-error panels, and no panel may
// be a nested double-scroller inside the page's single scroll region.
const LAPTOP = { width: 1366, height: 768 };
const PHONE = { width: 390, height: 844 };

/**
 * Populate the cockpit with enough persisted rows that its position / gate
 * panels are genuinely TALL, then route-mock the three cockpit polls so the
 * spec is hermetic (no DB / Prometheus).
 *
 * WHY tall content matters for the nested-scroller guard: the honest-empty
 * (configured:false) page a fresh clone shows has almost nothing below the
 * fold, so `.panel-body` never overflows regardless of layout — the
 * "no nested double-scroller" check then passes even if a regression
 * reintroduced an inner scroller (it can't overflow with empty panels). With
 * many rows a `.panel-body` that regressed to `overflow:auto` under a capped
 * height WILL overflow and trip the guard, while the correct overflow:visible
 * layout keeps scrollHeight===clientHeight and lets the PAGE own the scroll.
 *
 * Rows are kept short (compact symbols, all-clear badges) so the extra content
 * grows the page vertically without forcing horizontal overflow — the phone
 * x-overflow assertions below must still reflect the real layout, not test data.
 */
async function installTallCockpit(page: Page): Promise<void> {
  const symbols = Array.from({ length: 18 }, (_, i) => `S${i}USDTM`);
  const positions = symbols.map((symbol) => openPosition({ symbol }));
  const gates: GateRowView[] = symbols.map((symbol) => ({
    symbol,
    haltedPersisted: false,
    haltedNow: false,
    breakerTrippedAtUnix: null,
    breakerActiveNow: false,
  }));

  await page.route("**/api/cockpit/state", (route) =>
    route.fulfill({ json: cockpitState({ paper: { positions, gates } }) }),
  );
  await page.route("**/api/cockpit/telemetry", (route) =>
    route.fulfill({ json: telemetryScraped() }),
  );
  await page.route("**/api/exchanges/status", (route) =>
    route.fulfill({ json: exchangesStatus(null) }),
  );
}

test.describe("Cockpit viewport reachability (1366x768)", () => {
  test.use({ viewport: LAPTOP });

  test("last panel is reachable and the page owns the only scroll region", async ({
    page,
  }) => {
    await installTallCockpit(page);
    await page.goto("/cockpit");
    // Don't wait for networkidle: the cockpit polls (10s badges) so the
    // network never goes idle. The title is the deterministic ready signal.
    await expect(page).toHaveTitle("Cockpit — FKS Terminal");

    // 1) The page root must OWN a scroll region — overflow-y must be scrollable
    //    so below-fold content is reachable regardless of how much mock data is
    //    present. Before the fix it had `overflow: hidden` (no region) → clipped.
    //    (Asserting scrollHeight > clientHeight would be data-dependent and
    //    flaky when sparse cockpit data doesn't fill 768px.)
    const pageRoot = page.locator(".cockpit-page");
    await expect(pageRoot).toBeVisible();
    const overflowY = await pageRoot.evaluate(
      (el) => getComputedStyle(el).overflowY,
    );
    expect(["auto", "scroll", "overlay"]).toContain(overflowY);

    // 2) The very last node on the page (the Armed-path alerts panel since M3
    //    Phase B replaced the deferred-note) must be reachable. Structural
    //    :last-child keeps this anchored to "whatever is last" rather than a
    //    specific panel, so future additions don't silently retire the guard.
    const lastNode = page.locator(".cockpit-page > :last-child");
    await lastNode.scrollIntoViewIfNeeded();
    await expect(lastNode).toBeInViewport();

    // 3) No panel body inside the cockpit may itself scroll — that is the
    //    "weird sub-window scrolling". The single scroll region is the page.
    //    (Locate under .cockpit-page — the cockpit has no .workspace container,
    //    so the old `.workspace .panel-body` locator matched ZERO nodes and the
    //    guard was vacuous. With tall mock data a regressed inner scroller now
    //    actually overflows and is counted.)
    const doubleScrollers = await page
      .locator(".cockpit-page .panel-body")
      .evaluateAll((nodes) =>
        nodes.filter((el) => el.scrollHeight > el.clientHeight + 4).length,
      );
    expect(doubleScrollers).toBe(0);
  });
});

// ── Treasury phone pass (D6) ────────────────────────────────────────────────
// The /treasury page is the operator's money home and its stated key flow is
// "record a transfer in <15s on the phone". At 390px the record-a-transfer form
// must be reachable and usable, the transfers ledger must not force the PAGE to
// scroll horizontally (its own overflow-x wrapper absorbs a wide table INSIDE
// the panel body), and the aggregate TOTAL card (D5) must render above the
// per-account cards. Hermetic: route-mock the spawner treasury endpoints.
async function installTreasury(page: Page): Promise<void> {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const accounts = {
    total: 2,
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
      {
        account_id: "cold-btc",
        display_name: "Cold BTC Backbone",
        tier: 0,
        account_class: "cold-storage",
        venue: null,
        role: "watch",
        firm: null,
        compliance_flag: "manual-mirror",
        risk_caps: {},
        sizing: {},
        active: true,
        created_at: iso(90 * 86_400_000),
        updated_at: iso(3_600_000),
      },
    ],
  };
  const netWorth = [
    { bot_id: "personal-crypto", ts: iso(2 * 3_600_000), net_worth: 12_500, currency: "USD" },
    { bot_id: "personal-crypto", ts: iso(3_600_000), net_worth: 12_900, currency: "USD" },
    { bot_id: "cold-btc", ts: iso(3_600_000), net_worth: 48_000, currency: "USD" },
  ];
  const transfers = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    account_id: i % 2 ? "cold-btc" : "personal-crypto",
    ts: iso((i + 1) * 86_400_000),
    amount: i % 2 ? 500 : -120.55,
    currency: "USD",
    kind: i % 2 ? "deposit" : "withdrawal",
    source: "manual",
    note: i % 3 === 0 ? "paycheck DCA — the note column that used to widen the row" : null,
  }));
  const profit = (accountId: string) => ({
    account_id: accountId,
    since: null,
    db_enabled: true,
    start_ts: iso(30 * 86_400_000),
    end_ts: iso(3_600_000),
    start_net_worth: 10_000,
    end_net_worth: accountId === "cold-btc" ? 48_000 : 12_900,
    delta: 2_900,
    deposits_in: 2_000,
    withdrawals_out: 100,
    net_inflows: 1_900,
    profit: 1_000,
    transfers: 3,
  });

  await page.route("**/api/spawner/accounts", (route) =>
    route.fulfill({ json: accounts }),
  );
  // Trailing ** so the ?limit= query strings still match.
  await page.route("**/api/spawner/net-worth**", (route) =>
    route.fulfill({ json: netWorth }),
  );
  await page.route("**/api/spawner/transfers**", (route) =>
    route.fulfill({ json: transfers }),
  );
  await page.route("**/api/spawner/profit**", (route) => {
    const accountId =
      new URL(route.request().url()).searchParams.get("account_id") ?? "personal-crypto";
    route.fulfill({ json: profit(accountId) });
  });
}

test.describe("Treasury viewport reachability (390x844 phone)", () => {
  test.use({ viewport: PHONE });

  test("phone: record-transfer flow reachable, ledger doesn't x-overflow the page, total card renders", async ({
    page,
  }) => {
    await installTreasury(page);
    await page.goto("/treasury");
    await expect(page).toHaveTitle("Treasury — FKS Terminal");

    // 1) The page root owns the single scroll region.
    const pageRoot = page.locator(".page");
    await expect(pageRoot).toBeVisible();
    const overflowY = await pageRoot.evaluate((el) => getComputedStyle(el).overflowY);
    expect(["auto", "scroll", "overlay"]).toContain(overflowY);

    // 2) The record-a-transfer flow — the <15s phone key flow — is reachable:
    //    the account select, amount input, and the Record submit are all there.
    await expect(page.getByRole("button", { name: /Record deposit/i })).toBeVisible();
    await expect(page.locator('input[inputmode="decimal"]').first()).toBeVisible();

    // 3) The aggregate TOTAL card (D5) renders above the per-account cards.
    await expect(page.getByText("All real accounts — total")).toBeVisible();

    // 4) The transfers ledger is present and reachable by scrolling the page.
    const ledgerScroll = page.locator(".page :is(table)").last();
    await ledgerScroll.scrollIntoViewIfNeeded();

    // 5) The PAGE must not scroll horizontally at 390px — a wide ledger is
    //    absorbed by its own overflow-x wrapper INSIDE the panel body, never by
    //    the page. This is the core D6 assertion.
    const xOverflow = await pageRoot.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(xOverflow).toBeLessThanOrEqual(1);
    const docOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(docOverflow).toBeLessThanOrEqual(1);
  });
});

test.describe("Cockpit viewport reachability (390x844 phone)", () => {
  test.use({ viewport: PHONE });

  test("phone: page owns the only scroll, last node reachable, no nested scrollers, kill controls reachable without x-overflow", async ({
    page,
  }) => {
    await installTallCockpit(page);
    await page.goto("/cockpit");
    await expect(page).toHaveTitle("Cockpit — FKS Terminal");

    // 1) The page root owns the single scroll region (same as laptop).
    const pageRoot = page.locator(".cockpit-page");
    await expect(pageRoot).toBeVisible();
    const overflowY = await pageRoot.evaluate(
      (el) => getComputedStyle(el).overflowY,
    );
    expect(["auto", "scroll", "overlay"]).toContain(overflowY);

    // 2) The last node (Armed-path alerts panel — structural :last-child, see
    //    the laptop spec) is reachable by scrolling the page.
    const lastNode = page.locator(".cockpit-page > :last-child");
    await lastNode.scrollIntoViewIfNeeded();
    await expect(lastNode).toBeInViewport();

    // 3) No cockpit panel body is a nested double-scroller (tall mock data makes
    //    this bite — see installTallCockpit).
    const doubleScrollers = await page
      .locator(".cockpit-page .panel-body")
      .evaluateAll((nodes) =>
        nodes.filter((el) => el.scrollHeight > el.clientHeight + 4).length,
      );
    expect(doubleScrollers).toBe(0);

    // 4) The KILL button and both instance tabs are reachable at phone width.
    await expect(page.locator(".kill-actions button.btn-kill")).toBeVisible();
    await expect(page.getByRole("tab", { name: "PAPER" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "LIVE" })).toBeVisible();

    // 5) The page must not scroll horizontally — .mode-row / .kill-row are
    //    flex-wrap, so nothing forces the 390px viewport wider than itself.
    const xOverflow = await pageRoot.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(xOverflow).toBeLessThanOrEqual(1);
    // And the document itself does not overflow the viewport width.
    const docOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(docOverflow).toBeLessThanOrEqual(1);
  });
});
