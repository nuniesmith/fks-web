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
 *
 * `wideClosingRow` (A-4) is OPT-IN for exactly that reason: it prepends ONE row
 * carrying the realistic close-status value `CLOSING (funding_flip, attempt 3)`,
 * which genuinely widens the positions table past the panel body. Every other
 * caller must keep the narrow default so their layout assertions keep measuring
 * the app rather than the fixture.
 */
async function installTallCockpit(
  page: Page,
  opts: { wideClosingRow?: boolean } = {},
): Promise<void> {
  const symbols = Array.from({ length: 18 }, (_, i) => `S${i}USDTM`);
  const positions = symbols.map((symbol) => openPosition({ symbol }));
  if (opts.wideClosingRow) {
    positions.unshift(
      openPosition({
        symbol: "XBTUSDTM",
        closing: {
          reason: "funding_flip",
          decidedTMs: Date.now() - 90_000,
          attempts: 3,
        },
      }),
    );
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// M5 phone-frame guards.
//
// SCOPED TO WHAT WAS MEASURED, not to what was assumed. A design pass claimed
// the StatusBar "clips logout off-screen" on a phone; probing the real DOM at
// 375px showed logout's right edge at 363px — on-screen, because the flex row
// shrinks. That claim is NOT asserted here.
//
// What DID reproduce, and is guarded below:
//   • logout renders 16px tall under (pointer: coarse) — far under the 44px
//     minimum, on the one control a phone user most needs to hit.
//   • the gate cards use a FIXED width (login 360px, setup/invite 380px), so
//     they overflow any viewport narrower than that. /setup and /invite sit
//     behind the auth gate and are unreachable hermetically, but /login shares
//     the pattern and is testable at 320px.
//   • the bar carried NO @media rule at all, so three health items + the
//     "FKS Terminal · SvelteKit" label competed for a 375px row.
// ─────────────────────────────────────────────────────────────────────────────
const SMALL_PHONE = { width: 375, height: 667 }; // iPhone SE
const NARROW_PHONE = { width: 320, height: 568 }; // iPhone 5/SE1 — narrower than the 360px card

test.describe("Phone frame: touch targets and status-bar density", () => {
  test.use({ viewport: SMALL_PHONE, hasTouch: true, isMobile: true });

  test("logout is a real 44px touch target under a coarse pointer", async ({ page }) => {
    await page.goto("/");
    // Guard the guard: if touch emulation regresses, the assertion below would
    // pass vacuously against the desktop rule.
    const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
    expect(coarse, "this spec is meaningless without coarse-pointer emulation").toBe(true);

    const box = await page.locator(".logout-btn").boundingBox();
    expect(box).not.toBeNull();
    // Measured 16px before the fix, 44px after.
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(SMALL_PHONE.width);
  });

  test("health collapses to one worst-wins aggregate on a phone", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".status-agg")).toBeVisible();
    await expect(page.locator(".status-item:not(.status-agg)").first()).toBeHidden();
    // The aggregate must still say WHAT is wrong — a degraded service may not
    // hide behind a healthy sibling just because it collapsed into one dot.
    await expect(page.locator(".status-agg")).toHaveAttribute("aria-label", /.+/);
  });
});

test.describe("Phone frame: the auth gate stays reachable on a short viewport", () => {
  // 320x380 approximates a small phone with the software keyboard up — the
  // case where a centred `min-height:100vh` gate with no scroll region hides
  // its own submit button. Measured before the fix: submit bottom at 453px on
  // a 380px viewport, gate overflow-y:visible, and NOTHING scrollable.
  test.use({ viewport: { width: 320, height: 380 } });

  test("the submit button can actually be reached", async ({ page }) => {
    await page.goto("/login");
    const submit = page.locator('button[type="submit"]').first();

    await submit.scrollIntoViewIfNeeded();
    const box = await submit.boundingBox();
    expect(box, "submit must have a layout box").not.toBeNull();
    // The regression: unreachable because no ancestor could scroll.
    expect(box!.y + box!.height).toBeLessThanOrEqual(380);
    await expect(submit).toBeVisible();
  });

  test("the gate owns a real scroll region", async ({ page }) => {
    await page.goto("/login");
    const overflowY = await page.evaluate(() => {
      const g = document.querySelector(".gate") as HTMLElement | null;
      return g ? getComputedStyle(g).overflowY : null;
    });
    expect(overflowY, "the gate must be the page's scroll region").toBe("auto");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The health-freshness age must survive the 640px StatusBar collapse.
//
// M5 folds the three per-service items into one aggregate dot on a phone. That
// dot can say "degraded" but it cannot say HOW LONG the reading has been
// unverifiable — which is exactly what R5 added the age for. Hiding it below
// 640px would leave the phone, the primary platform, with the ambiguity R5
// exists to remove.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("Phone frame: health freshness stays visible", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("the age is rendered on a phone, alongside the collapsed aggregate", async ({ page }) => {
    await page.goto("/");
    // The per-service items are collapsed...
    await expect(page.locator(".status-agg")).toBeVisible();
    // ...but the freshness age is NOT.
    const fresh = page.locator(".status-fresh");
    await expect(fresh).toBeVisible();

    const box = await fresh.boundingBox();
    expect(box, "freshness must have a layout box on a phone").not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A-2 — the PAPER/LIVE instance tabs are a KILL-TARGET selector, not a filter.
//
// Whichever tab is active decides which instance the cockpit's kill switch
// halts. Measured at 390x844 under a coarse pointer the tabs were 26px tall,
// well under the 44px floor — and they sat FLUSH against each other inside a
// seamless segmented control, so a thumb aiming at PAPER could land on LIVE.
//
// Both halves are asserted here on purpose. A height-only fix would make the
// mis-selection WORSE: a bigger target flush against its neighbour is a bigger
// overlap. So the gap is a first-class guard, not a nicety — a future "tidy-up"
// that restores the seamless segmented look must fail this spec.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("Phone frame: the kill-target selector is a real touch target", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("PAPER/LIVE are >=44px tall AND separated under a coarse pointer", async ({
    page,
  }) => {
    await installTallCockpit(page);
    await page.goto("/cockpit");
    await expect(page).toHaveTitle("Cockpit — FKS Terminal");

    // Guard the guard: without coarse-pointer emulation the assertions below
    // would be measuring the desktop rule and pass for the wrong reason.
    const coarse = await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    );
    expect(coarse, "this spec is meaningless without coarse-pointer emulation").toBe(
      true,
    );

    const tabs = page.locator(".inst-tab");
    await expect(tabs).toHaveCount(2);

    const boxes = await tabs.evaluateAll((nodes) =>
      nodes.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, height: r.height };
      }),
    );

    // Measured 26px before the fix.
    for (const b of boxes) {
      expect(b.height).toBeGreaterThanOrEqual(44);
    }

    // Measured 0px before the fix — the two segments shared an edge.
    const sorted = [...boxes].sort((a, b) => a.left - b.left);
    const moat = sorted[1].left - sorted[0].right;
    expect(
      moat,
      "PAPER and LIVE must not be flush: enlarging a kill-target selector without separating it raises mis-selection odds",
    ).toBeGreaterThanOrEqual(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A-3 — the installed PWA opens on /cockpit with the ACTIVE TAB OFF-SCREEN.
//
// Measured at 390x844: tabbar scrollWidth 1288 vs clientWidth 390, scrollLeft 0,
// and the Cockpit tab at left=738 — entirely past the right edge. Because the
// scrollbar is hidden (scrollbar-width:none + ::-webkit-scrollbar{display:none})
// there was no active-tab indicator visible ANYWHERE and no hint the strip
// continued: the app looked like it had opened on a page the nav doesn't list.
//
// Both halves are asserted. Scrolling the tab into view without an edge
// affordance still leaves the operator with no clue that Overview…Perf exist to
// the left, and the fade is what makes the (now non-zero) scroll offset legible.
// ─────────────────────────────────────────────────────────────────────────────

/** Signed slack of `el` inside the scrolling strip; >= 0 ⇒ fully visible. */
async function tabSlack(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => {
    const bar = el.closest("nav.tabbar") as HTMLElement;
    const b = bar.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return Math.min(r.left - b.left, b.right - r.right);
  });
}

test.describe("Phone nav: the active tab is on screen and the strip shows it scrolls", () => {
  test.use({ viewport: PHONE });

  test("phone: /cockpit opens with the Cockpit tab visible, edge fades mark the hidden tabs, and a keyboard nav re-centres", async ({
    page,
  }) => {
    await installTallCockpit(page);
    await page.goto("/cockpit");
    await expect(page).toHaveTitle("Cockpit — FKS Terminal");
    // Hydration signal — the scroll-into-view runs in a client $effect, and the
    // title now resolves against the SSR document (see cockpit.spec.ts's
    // gotoCockpit note), so the title alone would race the effect.
    await expect(page.locator(".freshness").first()).toContainText(
      /state \d+s ago/,
    );

    // Guard the guard: this spec measures NOTHING unless the strip genuinely
    // overflows at 390px. If a future nav trim makes 17 tabs fit, delete the
    // spec rather than letting it pass vacuously.
    const geom = await page.locator("nav.tabbar").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollLeft: el.scrollLeft,
    }));
    expect(
      geom.scrollWidth,
      "the tab strip must overflow 390px for this spec to mean anything",
    ).toBeGreaterThan(geom.clientWidth + 100);
    // Measured 0 before the fix — nothing scrolled the strip, ever.
    expect(geom.scrollLeft).toBeGreaterThan(0);

    const active = page.locator('nav.tabbar a.tab[aria-current="page"]');
    await expect(active).toHaveText(/Cockpit/);
    // The WHOLE active tab is inside the strip's visible box (left=738 in a
    // 390px-wide strip before the fix ⇒ slack was hundreds of px negative).
    expect(
      await tabSlack(page, 'nav.tabbar a.tab[aria-current="page"]'),
      "the active tab must be fully inside the scrolling strip",
    ).toBeGreaterThanOrEqual(0);

    // The affordance: tabs are hidden off BOTH edges here, so both fades paint,
    // and neither may be able to swallow a tap meant for a tab underneath.
    const wrap = page.locator(".tabbar-wrap");
    await expect(wrap).toHaveClass(/fade-start/);
    await expect(wrap).toHaveClass(/fade-end/);
    const fadeEvents = await wrap.evaluate((el) => [
      getComputedStyle(el, "::before").pointerEvents,
      getComputedStyle(el, "::after").pointerEvents,
    ]);
    expect(
      fadeEvents,
      "an overlay over the nav that eats taps would send the operator to the wrong page",
    ).toEqual(["none", "none"]);

    // …and it re-centres on NAVIGATION, not just on mount: shortcut 9 → /bots,
    // the last tab in the strip (Bots at left=1224 before the fix).
    await page.keyboard.press("9");
    await expect(page).toHaveURL(/\/bots$/);
    await expect(active).toHaveText(/Bots/);
    await expect
      .poll(() => tabSlack(page, 'nav.tabbar a.tab[aria-current="page"]'))
      .toBeGreaterThanOrEqual(0);
    // Scrolled to the far end ⇒ nothing is hidden to the right any more, so the
    // trailing fade must go away (a permanent fade is decoration, not a signal).
    await expect(wrap).not.toHaveClass(/fade-end/);
    await expect(wrap).toHaveClass(/fade-start/);
  });
});

test.describe("Desktop nav: the fade is a signal, not decoration", () => {
  test.use({ viewport: LAPTOP });

  test("laptop: a fade paints only on an edge that is actually hiding tabs", async ({
    page,
  }) => {
    await page.goto("/");
    // Hydration signal: the digit shortcuts are registered by a client $effect,
    // so a successful keyboard nav proves the fade bookkeeping is also live.
    // Without this the assertions below could pass on un-hydrated markup, which
    // never carries a fade class at all. RETRY the press — a keystroke sent
    // before the listener exists is simply dropped (observed once at 8 workers).
    await expect(async () => {
      await page.keyboard.press("5");
      await expect(page).toHaveURL(/\/performance$/, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

    const obs = await page.locator(".tabbar-wrap").evaluate((el) => {
      const bar = el.querySelector("nav.tabbar") as HTMLElement;
      const max = bar.scrollWidth - bar.clientWidth;
      return {
        overflows: max > 1,
        hiddenLeft: bar.scrollLeft > 1,
        hiddenRight: max > 1 && bar.scrollLeft < max - 1,
        fadeStart: el.classList.contains("fade-start"),
        fadeEnd: el.classList.contains("fade-end"),
      };
    });
    expect(obs.fadeStart).toBe(obs.hiddenLeft);
    expect(obs.fadeEnd).toBe(obs.hiddenRight);
    // Measured: the 17-tab strip is 1288px, so it FITS a 1366px laptop and the
    // two assertions above are currently asserting "no fade anywhere". If a
    // future nav addition makes the desktop strip overflow, this line fails on
    // purpose — read it as "the desktop now needs the phone affordance too",
    // and flip it rather than deleting the invariant above.
    expect(
      obs.overflows,
      "the desktop strip used to fit at 1366px; if it no longer does, the two assertions above have quietly changed meaning",
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A-4 — the cockpit positions table was CUT AT THE PANEL BORDER with no
// scrollbar, and the existing docOverflow assertions are structurally blind to
// it: `Panel` is overflow:hidden, so the clipped column never reaches the
// document and `documentElement.scrollWidth` stays exactly 390.
//
// Measured at 390px: `.ck-table` 436.6px inside a 368px panel body, with the
// "Close status" th running 344.7 → 455.6 — ~35px of a 111px column visible.
// The operator consequence is specific: with a real value like
// "CLOSING (funding_flip, attempt 3)" the row LOOKS complete, so a close
// attempt that keeps failing on the armed instance is silently invisible.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("Cockpit positions table reachability (390x844 phone)", () => {
  test.use({ viewport: PHONE });

  test("phone: the Close status column is reachable by scrolling INSIDE the panel", async ({
    page,
  }) => {
    await installTallCockpit(page, { wideClosingRow: true });
    await page.goto("/cockpit");
    await expect(page).toHaveTitle("Cockpit — FKS Terminal");
    // Ready signal, not decoration: the title resolves against the SSR document
    // (cockpit.spec.ts's gotoCockpit explains why), so without this the geometry
    // below can be measured while the panel is still the honest-empty state and
    // the mocked position rows do not exist yet. `Freshness` only prints an age
    // after the state poll has RESOLVED.
    await expect(page.locator(".freshness").first()).toContainText(
      /state \d+s ago/,
    );

    const positions = page.locator(".panel", {
      has: page.locator(".panel-title", { hasText: /Open positions/ }),
    });
    // The realistic value that motivates the whole item.
    await expect(
      positions.getByText("CLOSING (funding_flip, attempt 3)"),
    ).toBeVisible();

    const scroller = positions.locator(".table-scroll");
    await expect(scroller).toHaveCount(1);
    const th = positions.locator("th", { hasText: "Close status" });

    // 1) Guard the guard: the fixture row must ACTUALLY overflow the panel body.
    //    Without this, everything below would pass on a table that fits.
    const overflow = await scroller.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(
      overflow,
      "the wide-row fixture must overflow the 368px panel body or this spec proves nothing",
    ).toBeGreaterThan(20);

    // 2) At rest the last column really is cut off at the panel edge — this is
    //    the state the operator sees, and why an affordance must exist.
    const cutAtRest = await th.evaluate((el) => {
      const box = (
        el.closest(".table-scroll") as HTMLElement
      ).getBoundingClientRect();
      return el.getBoundingClientRect().right - box.right;
    });
    expect(cutAtRest).toBeGreaterThan(0);

    // 3) The fix: the column becomes fully readable by scrolling WITHIN the
    //    panel. Before the wrapper there was no scrollable ancestor at all —
    //    scrollLeft could not move and the header stayed clipped forever.
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const reached = await th.evaluate((el) => {
      const box = (
        el.closest(".table-scroll") as HTMLElement
      ).getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        insideRight: box.right - r.right,
        insideLeft: r.left - box.left,
        rightEdge: r.right,
      };
    });
    expect(reached.insideRight).toBeGreaterThanOrEqual(-1);
    expect(reached.insideLeft).toBeGreaterThanOrEqual(-1);
    expect(reached.rightEdge).toBeLessThanOrEqual(PHONE.width);

    // 4) The wrapper must ABSORB the width, not hand it to the page: neither the
    //    cockpit page nor the document may scroll horizontally.
    const pageX = await page
      .locator(".cockpit-page")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(pageX).toBeLessThanOrEqual(1);
    const docOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(docOverflow).toBeLessThanOrEqual(1);
  });
});
