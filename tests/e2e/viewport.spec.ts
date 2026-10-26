import { test, expect, type Page } from "@playwright/test";
import { installHome } from "./fixtures/home";

// Regression guard for the "short viewing windows + weird sub-window
// scrolling" complaint (UI Phase 1). A document page must let the operator
// reach everything below the fold, and no panel may be a nested
// double-scroller inside the page's single scroll region. Home is the page a
// phone opens on, so it carries the guard (the cockpit did before 2026-10-26).
const LAPTOP = { width: 1366, height: 768 };
const PHONE = { width: 390, height: 844 };

test.describe("Home viewport reachability (1366x768)", () => {
  test.use({ viewport: LAPTOP });

  test("last panel is reachable and the page owns the only scroll region", async ({
    page,
  }) => {
    await installHome(page, { tall: true });
    await page.goto("/");
    // Don't wait for networkidle: Home polls, so the network never goes idle.
    // A mocked account card is the deterministic ready signal.
    await expect(page.getByTestId("account-card")).toBeVisible();

    // 1) The page root must OWN a scroll region — overflow-y must be scrollable
    //    so below-fold content is reachable regardless of how much mock data is
    //    present. Before the fix it had `overflow: hidden` (no region) → clipped.
    const pageRoot = page.locator(".page");
    await expect(pageRoot).toBeVisible();
    const overflowY = await pageRoot.evaluate(
      (el) => getComputedStyle(el).overflowY,
    );
    expect(["auto", "scroll", "overlay"]).toContain(overflowY);

    // Guard the guard: with the tall fixture the page really does overflow.
    const tall = await pageRoot.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(tall, "the tall fixture must overflow 768px or this spec proves nothing").toBeGreaterThan(100);

    // 2) The very last node on the page must be reachable. Structural
    //    :last-child keeps this anchored to "whatever is last" rather than a
    //    specific panel, so future additions don't silently retire the guard.
    const lastNode = page.locator(".page > :last-child");
    await lastNode.scrollIntoViewIfNeeded();
    await expect(lastNode).toBeInViewport();

    // 3) No panel body may itself scroll — that is the "weird sub-window
    //    scrolling". The single scroll region is the page. With tall mock data
    //    a regressed inner scroller actually overflows and is counted.
    const doubleScrollers = await page
      .locator(".page .panel-body")
      .evaluateAll((nodes) =>
        nodes.filter((el) => el.scrollHeight > el.clientHeight + 4).length,
      );
    expect(doubleScrollers).toBe(0);
  });
});

// ── Money phone pass (D6) ───────────────────────────────────────────────────
// The /money page (the treasury, moved 2026-10-26) is the operator's money home and its stated key flow is
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

test.describe("Money viewport reachability (390x844 phone)", () => {
  test.use({ viewport: PHONE });

  test("phone: record-transfer flow reachable, ledger doesn't x-overflow the page, total card renders", async ({
    page,
  }) => {
    await installTreasury(page);
    await installHome(page);
    await page.goto("/money");
    await expect(page).toHaveTitle("Money — FKS Terminal");

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

test.describe("Home viewport reachability (390x844 phone)", () => {
  test.use({ viewport: PHONE });

  test("phone: page owns the only scroll, last node reachable, no nested scrollers, account card readable without x-overflow", async ({
    page,
  }) => {
    await installHome(page, { tall: true });
    await page.goto("/");
    const card = page.getByTestId("account-card");
    await expect(card).toBeVisible();

    // 1) The page root owns the single scroll region (same as laptop).
    const pageRoot = page.locator(".page");
    const overflowY = await pageRoot.evaluate((el) => getComputedStyle(el).overflowY);
    expect(["auto", "scroll", "overlay"]).toContain(overflowY);

    // 2) The last node is reachable by scrolling the page.
    const lastNode = page.locator(".page > :last-child");
    await lastNode.scrollIntoViewIfNeeded();
    await expect(lastNode).toBeInViewport();

    // 3) No panel body is a nested double-scroller.
    const doubleScrollers = await page
      .locator(".page .panel-body")
      .evaluateAll((nodes) => nodes.filter((el) => el.scrollHeight > el.clientHeight + 4).length);
    expect(doubleScrollers).toBe(0);

    // 4) The account's figures are on screen at phone width.
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByText("$321.20")).toBeVisible();
    await expect(card.getByText("LIVE")).toBeVisible();

    // 5) Neither the page nor the document scrolls horizontally.
    const xOverflow = await pageRoot.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(xOverflow).toBeLessThanOrEqual(1);
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
// A-3 — the installed PWA once opened with the ACTIVE TAB OFF-SCREEN.
//
// Measured at 390x844 (on the old 17-tab strip): scrollWidth 1288 vs
// clientWidth 390, scrollLeft 0, and the active tab entirely past the right
// edge. The scrollbar is hidden (scrollbar-width:none +
// ::-webkit-scrollbar{display:none}), so there was no active-tab indicator and
// no hint the strip continued. The six-section strip is shorter but still
// overflows a phone, so both halves stay asserted: the active tab is scrolled
// into view, and an edge fade shows which side hides more tabs.
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

  test("phone: /monitoring opens with its tab visible, edge fades mark the hidden tabs, and a keyboard nav re-centres", async ({
    page,
  }) => {
    await page.goto("/monitoring");
    const bar = page.locator("nav.tabbar");
    // Hydration signal: the scroll-into-view runs in a client $effect, so wait
    // for it rather than measuring the SSR markup. Measured 0 before the fix —
    // nothing scrolled the strip, ever.
    await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

    // Guard the guard: this spec measures NOTHING unless the strip genuinely
    // overflows at 390px. If a future nav trim makes every tab fit, delete the
    // spec rather than letting it pass vacuously.
    const geom = await bar.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(
      geom.scrollWidth,
      "the tab strip must overflow 390px for this spec to mean anything",
    ).toBeGreaterThan(geom.clientWidth + 60);

    const active = page.locator('nav.tabbar a.tab[aria-current="page"]');
    await expect(active).toHaveText(/Monitoring/);
    expect(
      await tabSlack(page, 'nav.tabbar a.tab[aria-current="page"]'),
      "the active tab must be fully inside the scrolling strip",
    ).toBeGreaterThanOrEqual(0);

    // The affordance: tabs are hidden off the LEFT edge here (Home…Money), so the
    // leading fade paints, and no fade may swallow a tap meant for a tab.
    const wrap = page.locator(".tabbar-wrap");
    await expect(wrap).toHaveClass(/fade-start/);
    const fadeEvents = await wrap.evaluate((el) => [
      getComputedStyle(el, "::before").pointerEvents,
      getComputedStyle(el, "::after").pointerEvents,
    ]);
    expect(
      fadeEvents,
      "an overlay over the nav that eats taps would send the operator to the wrong page",
    ).toEqual(["none", "none"]);

    // …and it re-centres on NAVIGATION, not just on mount: shortcut 1 → Home,
    // the first tab. Scrolled back to the start, nothing is hidden to the left,
    // so the leading fade goes and the trailing one shows what is to the right.
    await page.keyboard.press("1");
    await expect(page).toHaveURL(/\/$/);
    await expect(active).toHaveText(/Home/);
    await expect
      .poll(() => tabSlack(page, 'nav.tabbar a.tab[aria-current="page"]'))
      .toBeGreaterThanOrEqual(0);
    await expect(wrap).not.toHaveClass(/fade-start/);
    await expect(wrap).toHaveClass(/fade-end/);
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
      await expect(page).toHaveURL(/\/money$/, { timeout: 1_000 });
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
    // The six-section strip FITS a 1366px laptop, so the two assertions above
    // are currently asserting "no fade anywhere". If a
    // future nav addition makes the desktop strip overflow, this line fails on
    // purpose — read it as "the desktop now needs the phone affordance too",
    // and flip it rather than deleting the invariant above.
    expect(
      obs.overflows,
      "the desktop strip used to fit at 1366px; if it no longer does, the two assertions above have quietly changed meaning",
    ).toBe(false);
  });
});
