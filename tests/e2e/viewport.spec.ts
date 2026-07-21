import { test, expect } from "@playwright/test";

// Regression guard for the "short viewing windows + weird sub-window
// scrolling" complaint (UI Phase 1). On a laptop viewport the cockpit —
// the armed-futures kill-switch page — must let the operator reach its
// below-fold risk-gate / telemetry / order-error panels, and no panel may
// be a nested double-scroller inside the page's single scroll region.
const LAPTOP = { width: 1366, height: 768 };

test.describe("Cockpit viewport reachability (1366x768)", () => {
  test.use({ viewport: LAPTOP });

  test("last panel is reachable and the page owns the only scroll region", async ({
    page,
  }) => {
    await page.goto("/cockpit");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle("Cockpit — FKS Terminal");

    // 1) The page root must be a scroll region (its content exceeds a laptop
    //    viewport). Before the fix it had no overflow at all → clipped.
    const pageRoot = page.locator(".cockpit-page");
    await expect(pageRoot).toBeVisible();
    const rootScrolls = await pageRoot.evaluate(
      (el) => el.scrollHeight > el.clientHeight + 4,
    );
    expect(rootScrolls).toBe(true);

    // 2) The deferred-note is the very last node on the page. If the page
    //    clips (no scroll region) it can never be scrolled into view.
    const lastNode = page.locator(".deferred-note");
    await lastNode.scrollIntoViewIfNeeded();
    await expect(lastNode).toBeInViewport();

    // 3) No panel body inside the workspace may itself scroll — that is the
    //    "weird sub-window scrolling". The single scroll region is the page.
    const doubleScrollers = await page
      .locator(".workspace .panel-body")
      .evaluateAll((nodes) =>
        nodes.filter((el) => el.scrollHeight > el.clientHeight + 4).length,
      );
    expect(doubleScrollers).toBe(0);
  });
});
