import { test, expect, type Page } from "@playwright/test";
import { cockpitState, exchangesStatus, telemetryScraped } from "./fixtures/cockpit";

// ─────────────────────────────────────────────────────────────────────────────
// AlertInbox — P1 (annotations reach the operator) + A-2 item 1 (coarse-pointer
// touch targets on the ack cluster).
//
// P1: a Prometheus rule carries the whole recovery procedure in `annotations`.
// Before this, the inbox rendered a severity badge + alertname + labels and
// dropped summary/description/runbook, so the 3am phone said
// "BotAllVenuesStale bot_id=crypto-spot 15m" instead of
// "ALL real-money venues stale — bot is blind" with the container-DNS check one
// tap away.
//
// A-2: `.ack-btn` / `.note-toggle` computed to ~20px under a thumb. `ack()` has
// no confirm and no undo — on success the row leaves the actionable list — so
// the 44px floor is only safe if the SEPARATION grows with it. Both halves are
// asserted here; a future change that keeps the height and tightens the gap
// must fail this spec.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE = { width: 390, height: 844 };

/** The real BotAllVenuesStale annotations, trimmed (bot-alerts.yml:189-203). */
const ALL_VENUES_STALE = {
  key: "k-all-venues-stale",
  labels: {
    alertname: "BotAllVenuesStale",
    severity: "critical",
    channel: "money",
    bot_id: "crypto-spot",
  },
  activeAt: "2026-07-29T00:00:00Z",
  age_str: "15m",
  annotations: {
    summary: "Bot crypto-spot: ALL real-money venues stale — bot is blind",
    description:
      "Every real-money venue on crypto-spot (live or dry-run) has failed to refresh for over 15 minutes. Any position it holds is unmanaged until this clears.",
    runbook:
      "1) docker exec <bot> getent hosts api.kraken.com (DNS resolving?) 2) docker logs <bot> --since 20m | grep -iE 'dns|resolve|timeout'",
  },
  state: "firing",
  severity_color: "var(--red)",
  acked: null,
};

/** A rule that wrote no annotations at all — the fallback path. */
const BARE = {
  key: "k-bare",
  labels: { alertname: "DiskSpaceLow", severity: "warning", instance: "oryx:9100" },
  activeAt: "2026-07-29T00:00:00Z",
  age_str: "3m",
  state: "firing",
  severity_color: "var(--amber)",
  acked: null,
};

async function installInbox(page: Page, alerts: unknown[]): Promise<void> {
  await page.route("**/api/alerts/inbox", (route) =>
    route.fulfill({
      json: {
        configured: true,
        prom_available: true,
        unacked_count: alerts.length,
        alerts,
      },
    }),
  );
}

/** The inbox panel on /monitoring (the unfiltered feed). */
const inbox = (page: Page) => page.locator(".alert-list");

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Every box this spec compares, from ONE layout snapshot.
 *
 * Playwright's `boundingBox()` is a round trip per call, and /monitoring keeps
 * growing as its other panels resolve — a run that measured the expander and
 * the ack button in separate calls saw them 230px apart purely because the page
 * reflowed in between (observed once in six cold runs). Separation assertions
 * on a money control must not depend on that timing.
 */
async function measureRows(
  page: Page,
): Promise<{ card: Rect; ack: Rect | null; note: Rect | null; detail: Rect | null }[]> {
  return page.evaluate(() => {
    const r = (el: Element | null): Rect | null => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    return Array.from(document.querySelectorAll(".alert-list .alert-row")).map((row) => ({
      card: r(row)!,
      ack: r(row.querySelector(".ack-btn")),
      note: r(row.querySelector(".note-toggle")),
      detail: r(row.querySelector(".detail-toggle")),
    }));
  });
}

/**
 * Block until AlertInbox's own stylesheet is live before measuring geometry.
 *
 * Vite injects component CSS from JS, so on a cold dev server the first paint
 * can be unstyled and a box measured then is meaningless (observed: a run that
 * measured 20px buttons against a stylesheet that had not arrived).
 *
 * The gate is deliberately keyed on `.alert-row`'s BASE border — a rule that
 * predates this change and lives outside the `(pointer: coarse)` block. Waiting
 * on the 44px min-height itself would make the assertions below self-fulfilling;
 * this proves only "the stylesheet is applied", so deleting the coarse block
 * still fails the height and gap assertions rather than hanging here.
 */
async function awaitInboxStyles(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector(".alert-row");
        return el ? getComputedStyle(el).borderTopStyle : "none";
      }),
    )
    .toBe("solid");
}

test.describe("P1 — alert annotations reach the operator", () => {
  test("the summary is the row title, and the alertname survives as the id", async ({
    page,
  }) => {
    await installInbox(page, [ALL_VENUES_STALE]);
    await page.goto("/monitoring");

    const row = inbox(page).locator(".alert-row").first();
    await expect(row).toBeVisible();

    // The sentence a human wrote, not the identifier a machine generated.
    await expect(row.locator(".alert-title")).toHaveText(
      "Bot crypto-spot: ALL real-money venues stale — bot is blind",
    );
    // The alertname is the correlation key for Prometheus / Alertmanager / the
    // cockpit filter — promoting the summary must never cost it.
    await expect(row.locator(".alert-name")).toHaveText("BotAllVenuesStale");
  });

  test("description + runbook are one tap away, and hidden until asked for", async ({
    page,
  }) => {
    await installInbox(page, [ALL_VENUES_STALE]);
    await page.goto("/monitoring");

    const row = inbox(page).locator(".alert-row").first();
    const toggle = row.locator(".detail-toggle");
    await expect(toggle).toBeVisible();
    // Collapsed by default: a runbook per row would bury the list.
    await expect(row.locator(".alert-detail")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();

    const detail = row.locator(".alert-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("unmanaged until this clears");
    // The first diagnostic step — the whole point of the item.
    await expect(detail.locator(".detail-runbook")).toContainText("getent hosts api.kraken.com");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await toggle.click();
    await expect(row.locator(".alert-detail")).toHaveCount(0);
  });

  test("a rule with no annotations falls back to the alertname and shows no expander", async ({
    page,
  }) => {
    await installInbox(page, [BARE]);
    await page.goto("/monitoring");

    const row = inbox(page).locator(".alert-row").first();
    await expect(row.locator(".alert-title")).toHaveText("DiskSpaceLow");
    // No empty expander promising help that does not exist.
    await expect(row.locator(".detail-toggle")).toHaveCount(0);
  });

  test("opening a runbook does not arm the ack/note editor", async ({ page }) => {
    // Reading is the safe act; acking is the irreversible one. They must not
    // share state — expanding a runbook must not open the note input or ack.
    await installInbox(page, [ALL_VENUES_STALE]);
    await page.goto("/monitoring");

    const row = inbox(page).locator(".alert-row").first();
    await row.locator(".detail-toggle").click();
    await expect(row.locator(".alert-detail")).toBeVisible();
    await expect(row.locator(".note-input")).toHaveCount(0);
  });
});

test.describe("A-2 — the ack cluster is thumb-safe at 390x844", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("44px floor AND a widened gap — the pair, never one without the other", async ({
    page,
  }) => {
    await installInbox(page, [ALL_VENUES_STALE, BARE]);
    await page.goto("/monitoring");

    // Guard the guard: without coarse-pointer emulation every assertion below
    // would pass vacuously against the desktop rule.
    const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
    expect(coarse, "this spec is meaningless without coarse-pointer emulation").toBe(true);

    await expect(inbox(page).locator(".alert-row").nth(1).locator(".ack-btn")).toBeVisible();
    await awaitInboxStyles(page);
    const rows = await measureRows(page);
    expect(rows).toHaveLength(2);

    const { ack, note } = rows[0];
    // Measured ~20px before the fix.
    expect(ack!.h, "ack must be a real touch target").toBeGreaterThanOrEqual(44);
    expect(note!.h, "note toggle must be a real touch target").toBeGreaterThanOrEqual(44);

    // The other half of the trade. Ack has NO confirm and NO undo, so a bigger
    // button 6px from its neighbour is a REGRESSION, not an improvement.
    const gap = ack!.x - (note!.x + note!.w);
    expect(gap, "ack must be well separated from + note").toBeGreaterThanOrEqual(12);

    // And from the NEXT incident's Ack — mis-acking the alert below is the
    // same accident with a different neighbour.
    const vGap = rows[1].ack!.y - (ack!.y + ack!.h);
    expect(vGap, "adjacent incidents' ack buttons must not touch").toBeGreaterThanOrEqual(12);

    // The incident cards themselves must not abut either: with 44px controls,
    // two cards separated by the old 6px put one incident's Ack a thumb-width
    // from the next incident's card edge.
    const cardGap = rows[1].card.y - (rows[0].card.y + rows[0].card.h);
    expect(cardGap, "incident cards must stay separated on a phone").toBeGreaterThanOrEqual(12);

    // Nothing in the enlarged cluster may push the row off a 390px screen.
    expect(ack!.x + ack!.w).toBeLessThanOrEqual(PHONE.width);
  });

  test("the runbook expander is tappable WITHOUT joining the destructive cluster", async ({
    page,
  }) => {
    // The expander is the SAFE control — reading beats guessing at 3am, so it
    // gets the 44px floor too. What it must never do is become a horizontal
    // neighbour of Ack: it lives on its own line, left-aligned, and grows
    // downward, so its size adds separation instead of removing it.
    await installInbox(page, [ALL_VENUES_STALE]);
    await page.goto("/monitoring");

    const row = inbox(page).locator(".alert-row").first();
    await expect(row.locator(".detail-toggle")).toBeVisible();
    await awaitInboxStyles(page);
    const { ack, detail } = (await measureRows(page))[0];
    expect(detail!.h, "the runbook must be reachable with a thumb").toBeGreaterThanOrEqual(44);
    // Different lines of the card — the safe control never becomes a
    // horizontal neighbour of the irreversible one.
    expect(detail!.y).toBeGreaterThanOrEqual(ack!.y + ack!.h);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /cockpit reuses this component for its armed-path panel, so P1 lands there
// with no change to cockpit/+page.svelte. That is the surface that matters at
// 3am: the phone opens on /cockpit, and BotAllVenuesStale reaches it through
// the `channel === 'money'` clause of the armed filter.
//
// NB — the same click is NOT possible on /monitoring at 390px: an overlapping
// `Panel fill` covers the ack cluster there, which is true of `.ack-btn` on
// origin/main too (verified by probing `elementFromPoint` on a pristine tree).
// That is a /monitoring layout defect, not this component's, and R4 already
// proposes retiring that page's older alert list — reported, not fixed here.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("P1 reaches the cockpit armed-path panel", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("the summary and its runbook are readable and TAPPABLE on the phone", async ({ page }) => {
    await page.route("**/api/cockpit/state", (r) => r.fulfill({ json: cockpitState({}) }));
    await page.route("**/api/cockpit/telemetry", (r) => r.fulfill({ json: telemetryScraped() }));
    await page.route("**/api/exchanges/status", (r) => r.fulfill({ json: exchangesStatus(null) }));
    await installInbox(page, [ALL_VENUES_STALE]);
    await page.goto("/cockpit");

    const row = inbox(page).locator(".alert-row").first();
    await expect(row.locator(".alert-title")).toHaveText(
      "Bot crypto-spot: ALL real-money venues stale — bot is blind",
    );

    // A REAL click, not a dispatched event: this also asserts the control is
    // not covered by any overlay at 390px.
    await row.locator(".detail-toggle").click();
    await expect(row.locator(".detail-runbook")).toContainText("getent hosts api.kraken.com");
  });
});
