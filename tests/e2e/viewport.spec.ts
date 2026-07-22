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

    // 2) The deferred-note is the very last node on the page. If the page
    //    clips (no scroll region) it can never be scrolled into view.
    const lastNode = page.locator(".deferred-note");
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

    // 2) The last node (deferred-note) is reachable by scrolling the page.
    const lastNode = page.locator(".deferred-note");
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
