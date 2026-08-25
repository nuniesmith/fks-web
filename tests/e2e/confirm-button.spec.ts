import { test, expect, type Page } from "@playwright/test";
import { ARM_COOLDOWN_MS, AUTO_DISARM_MS } from "../../src/lib/components/ui/confirmButton";

/**
 * ConfirmButton — the shared two-step confirm, as adopted by /settings.
 *
 * THE PROPERTY UNDER TEST is the one no hand-rolled two-step in this app had:
 * an armed destructive button must IGNORE a confirm click that lands inside the
 * arming cooldown. The `/settings` flow this replaces armed on click 1 and
 * accepted click 2 immediately — its 4s window was auto-DISARM, not arm-DELAY —
 * so a double-tap, or a phone that turns one press into two `click` events,
 * destroyed a stored exchange secret (unrecoverable: the spawner never reads it
 * back, so recovery means re-issuing the key at the venue) or deleted the Discord
 * channel that carries the always-delivered `bot_crashed` / `risk_halt` pages.
 *
 * Every deny assertion below is paired with a positive control, because a button
 * that never confirms is its own outage: the operator would be unable to rotate a
 * leaked key from the phone.
 *
 * The timings are IMPORTED from the primitive, not re-typed, so retuning the
 * cooldown cannot leave this spec silently measuring the wrong window.
 *
 * Fully `page.route`-mocked: no spawner, no Postgres.
 */

const PHONE = { width: 390, height: 844 };

/** Comfortably past the cooldown, comfortably inside the auto-disarm window. */
const RIPE_MS = ARM_COOLDOWN_MS + 200;

const CREDS = [
  { exchange: "kraken", updated_at: "2026-07-28T10:00:00Z" },
  { exchange: "kucoin", updated_at: "2026-07-28T10:05:00Z" },
];

const CHANNELS = [
  { name: "ops-alerts", kind: "discord_webhook", events: [], updated_at: "2026-07-28T10:00:00Z" },
];

interface Seam {
  /** Pathnames of every DELETE that actually reached the seam, in order. */
  deletes: string[];
}

/**
 * Mock the two /settings list reads and both DELETE routes.
 *
 * One handler per prefix (branching on method) rather than two overlapping
 * globs: `**\/exchange-keys/*` also matches `/status`, and relying on
 * registration order to disambiguate a DELETE counter from a list read is how a
 * spec ends up asserting against requests it never saw.
 */
async function installSettings(page: Page): Promise<Seam> {
  const seam: Seam = { deletes: [] };

  await page.route("**/api/settings/exchange-keys/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "DELETE") {
      seam.deletes.push(path);
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/status")) {
      return route.fulfill({ json: { db_enabled: true, exchanges: CREDS } });
    }
    return route.fallback();
  });

  await page.route("**/api/settings/notifications**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "DELETE") {
      seam.deletes.push(path);
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/notifications")) {
      return route.fulfill({ json: { db_enabled: true, channels: CHANNELS } });
    }
    return route.fallback();
  });

  return seam;
}

async function gotoSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await expect(page).toHaveTitle("Settings — FKS Terminal");
}

const krakenDelete = (page: Page) => page.locator("#cred-delete-kraken");

/**
 * Record every `click` the browser actually delivers to `sel`, with its
 * timestamp.
 *
 * This exists to keep the deny assertions honest. "No DELETE reached the seam"
 * is also true when the harness delivered ONE click, or two clicks 900ms apart —
 * neither of which exercises the cooldown at all. Chromium's mobile emulation in
 * particular has historically swallowed the second of two fast taps. So each
 * swallow test proves the gesture landed as a gesture: two clicks, less than a
 * cooldown apart.
 */
async function instrumentClicks(page: Page, sel: string): Promise<void> {
  await page.evaluate((s) => {
    const w = window as unknown as { __clicks: number[] };
    w.__clicks = [];
    document
      .querySelector(s)!
      .addEventListener("click", () => w.__clicks.push(Date.now()), true);
  }, sel);
}

async function clickTimings(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __clicks: number[] }).__clicks);
}

/** The gesture really was a double-fire inside the cooldown. */
function expectDoubleFire(clicks: number[]): void {
  expect(clicks.length, "the harness must have delivered TWO clicks").toBe(2);
  expect(
    clicks[1] - clicks[0],
    `the two clicks landed ${clicks[1] - clicks[0]}ms apart — outside the ` +
      `${ARM_COOLDOWN_MS}ms cooldown, so this run did not test the guard`,
  ).toBeLessThan(ARM_COOLDOWN_MS);
}

/**
 * Block until ConfirmButton's own stylesheet is live before measuring geometry.
 *
 * Vite injects component CSS from JS, so a box measured on a cold dev server's
 * first paint is meaningless. The gate keys on the BASE `border-style` (declared
 * outside the `(pointer: coarse)` block) — gating on the 44px floor itself would
 * make the assertions self-fulfilling, whereas this proves only "the stylesheet
 * applied", so deleting the coarse block still FAILS the size/separation
 * assertions instead of hanging here.
 */
interface DeleteGeom {
  h: number;
  w: number;
  right: number;
  /** True 2D edge distance to the NEAREST other control in the same row. */
  neighbours: number;
  who: string;
}

/**
 * One layout snapshot of the kraken Delete button and its row.
 *
 * Everything is read inside a single `evaluate`: /settings keeps growing as its
 * other panels resolve, and two boxes read in separate round trips can straddle
 * a reflow (the alert-ack spec was bitten by exactly that). Separation is a true
 * 2D edge distance against EVERY sibling control in the row, because a named
 * horizontal pair goes blind the moment the row wraps on a narrow screen — and
 * would not see the next button somebody adds here.
 */
async function measureDelete(page: Page): Promise<DeleteGeom | null> {
  return page.evaluate(() => {
    const btn = document.querySelector("#cred-delete-kraken") as HTMLElement | null;
    if (!btn) return null;
    const A = btn.getBoundingClientRect();
    const row = btn.closest(".cred-row") ?? btn.parentElement!;
    let min = Infinity;
    let who = "";
    for (const el of Array.from(
      row.querySelectorAll("button, a[href], input, select, [role=button]"),
    ) as HTMLElement[]) {
      if (el === btn) continue;
      const B = el.getBoundingClientRect();
      if (B.width === 0 || B.height === 0) continue;
      const dx = Math.max(0, Math.max(A.left - B.right, B.left - A.right));
      const dy = Math.max(0, Math.max(A.top - B.bottom, B.top - A.bottom));
      const d = Math.hypot(dx, dy);
      if (d < min) {
        min = d;
        who = el.className || el.tagName;
      }
    }
    return { h: A.height, w: A.width, right: A.right, neighbours: min === Infinity ? -1 : min, who };
  });
}

async function awaitConfirmStyles(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector(".confirm-btn");
        return el ? getComputedStyle(el).borderTopStyle : "none";
      }),
    )
    .toBe("solid");
}

test.describe("the arming cooldown — a double-fire cannot destroy anything", () => {
  test("1. a double-tap arms and is SWALLOWED; a deliberate second click deletes", async ({
    page,
  }) => {
    const seam = await installSettings(page);
    await gotoSettings(page);

    const btn = krakenDelete(page);
    await expect(btn).toHaveText("Delete");
    await instrumentClicks(page, "#cred-delete-kraken");

    // The fat-finger case, as one gesture: two `click` events ~ms apart.
    await btn.dblclick();

    // Barrier before the deny assertion: wait out the whole cooldown, so a
    // leaked DELETE has certainly reached the route handler and this cannot pass
    // by measuring too early.
    await page.waitForTimeout(RIPE_MS);
    expectDoubleFire(await clickTimings(page));
    expect(
      seam.deletes,
      "a double-tap on a two-step delete must not reach the seam",
    ).toEqual([]);

    // Swallowed, NOT disarmed: the operator's first tap still counts, so the
    // guard costs one more deliberate click and not a restart of the flow.
    await expect(btn).toHaveText("Confirm delete?");
    await expect(btn).toHaveClass(/\barmed\b/);

    // The positive control — the SAME click, now past the cooldown, must work.
    await btn.click();
    await expect
      .poll(() => seam.deletes)
      .toEqual(["/api/settings/exchange-keys/kraken"]);
    await expect(page.getByText("kraken keys deleted")).toBeVisible();
  });

  test("2. while arming, the button says so and reports itself aria-disabled", async ({ page }) => {
    // The state where a click does nothing must not LOOK like the state where a
    // click deletes — otherwise the operator taps harder, which is exactly the
    // gesture the cooldown exists to absorb.
    const seam = await installSettings(page);
    await gotoSettings(page);

    const btn = krakenDelete(page);
    await btn.click();
    await expect(btn).toHaveClass(/\barming\b/);
    await expect(btn).toHaveAttribute("aria-disabled", "true");

    await expect(btn).toHaveClass(/\barmed\b/); // ripens on its own
    await expect(btn).not.toHaveAttribute("aria-disabled", "true");
    expect(seam.deletes, "ripening is not confirming").toEqual([]);
  });

  test("3. auto-disarm: the window lapses and the next click only re-arms", async ({ page }) => {
    const seam = await installSettings(page);
    await gotoSettings(page);

    const btn = krakenDelete(page);
    await btn.click();
    await expect(btn).toHaveText("Confirm delete?");

    // A hot destructive control must not survive being walked away from.
    await page.waitForTimeout(AUTO_DISARM_MS + 300);
    await expect(btn).toHaveText("Delete");

    // And the click that follows a lapsed window arms — it does not delete.
    await btn.click();
    await page.waitForTimeout(RIPE_MS);
    expect(seam.deletes, "a lapsed arm must not be redeemable").toEqual([]);
  });
});

test.describe("standing down", () => {
  test("4. Escape disarms, and so does moving focus away", async ({ page }) => {
    const seam = await installSettings(page);
    await gotoSettings(page);

    const btn = krakenDelete(page);

    await btn.click();
    await expect(btn).toHaveClass(/\barmed\b/);
    await page.keyboard.press("Escape");
    await expect(btn).toHaveText("Delete");

    // Disarmed for real: the next click starts the two-step over rather than
    // cashing in the arm from before Escape.
    await btn.click();
    await page.waitForTimeout(RIPE_MS);
    expect(seam.deletes, "Escape must not leave a redeemable arm").toEqual([]);

    // Same for focus leaving the control (tab away, tap elsewhere): an armed
    // button the operator has visibly left behind stands down.
    await expect(btn).toHaveClass(/\barmed\b/);
    await page.locator("#cred-provider").focus();
    await expect(btn).toHaveText("Delete");
  });

  test("5. keyboard-only: Enter arms and Enter confirms", async ({ page }) => {
    const seam = await installSettings(page);
    await gotoSettings(page);

    const btn = krakenDelete(page);
    await btn.focus();
    await expect(btn).toBeFocused(); // a real <button>, natively reachable

    await page.keyboard.press("Enter");
    await expect(btn).toHaveClass(/\barmed\b/);
    // Arming must not steal focus (a disabled element would drop it and strand
    // a keyboard operator on an armed button they can no longer press).
    await expect(btn).toBeFocused();

    await page.keyboard.press("Enter");
    await expect.poll(() => seam.deletes).toEqual(["/api/settings/exchange-keys/kraken"]);
  });
});

test.describe("it never eats operator input", () => {
  test("6. half-typed credentials survive arming, Escape and a confirmed delete", async ({
    page,
  }) => {
    // The rule this pins: a confirm primitive may not destroy typed state. A
    // half-entered API secret is not cheaply reproducible — it comes off another
    // screen or a password manager — and `type="button"` is what stops the click
    // from submitting/resetting an enclosing form.
    const seam = await installSettings(page);
    await gotoSettings(page);

    await page.evaluate(() => {
      (window as unknown as { __alive: string }).__alive = "same-document";
    });

    const key = page.locator("#cred-api-key");
    const secret = page.locator("#cred-api-secret");
    await key.fill("HALF-TYPED-KEY");
    await secret.fill("HALF-TYPED-SECRET");

    const btn = krakenDelete(page);
    await expect(btn).toHaveAttribute("type", "button");

    await btn.click();
    await page.keyboard.press("Escape"); // the disarm path must not clear inputs
    await expect(key).toHaveValue("HALF-TYPED-KEY");

    await btn.click();
    await page.waitForTimeout(RIPE_MS);
    await btn.click();
    await expect.poll(() => seam.deletes).toEqual(["/api/settings/exchange-keys/kraken"]);

    // Still typed, still the same document (a form submit would have reloaded).
    await expect(key).toHaveValue("HALF-TYPED-KEY");
    await expect(secret).toHaveValue("HALF-TYPED-SECRET");
    expect(
      await page.evaluate(() => (window as unknown as { __alive?: string }).__alive),
      "the click must not have submitted a form / reloaded the page",
    ).toBe("same-document");
  });
});

test.describe("adopted by BOTH /settings two-steps", () => {
  test("7. deleting the Discord channel that carries the crash page needs two real clicks", async ({
    page,
  }) => {
    // `bot_crashed` / `risk_halt` bypass the per-channel event filter, so
    // deleting the channel is the only way to silence them. Same guard, second
    // call site — this is what proves the primitive was actually adopted rather
    // than added beside a surviving hand-rolled copy.
    const seam = await installSettings(page);
    await gotoSettings(page);

    const btn = page.locator("#channel-delete-ops-alerts");
    await expect(btn).toHaveText("Delete");
    await instrumentClicks(page, "#channel-delete-ops-alerts");

    await btn.dblclick();
    await page.waitForTimeout(RIPE_MS);
    expectDoubleFire(await clickTimings(page));
    expect(seam.deletes, "a double-tap must not silence the crash page").toEqual([]);

    await btn.click();
    await expect
      .poll(() => seam.deletes)
      .toEqual(["/api/settings/notifications/ops-alerts"]);
  });
});

test.describe("thumb-safe on the phone — size AND separation, never one alone", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("8. 44px floor, ≥12px from every sibling control in either axis, on screen", async ({
    page,
  }) => {
    await installSettings(page);
    await gotoSettings(page);
    await expect(krakenDelete(page)).toBeVisible();
    await awaitConfirmStyles(page);

    // Guard the guard: without coarse-pointer emulation every assertion below
    // would pass or fail against the desktop rule instead.
    const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
    expect(coarse, "this spec is meaningless without coarse-pointer emulation").toBe(true);

    // Both states are measured. Arming REFLOWS the button — "Confirm delete?" is
    // ~65px wider than "Delete", so the armed (irreversible) target has a
    // different, larger box than the one this spec would see at rest. Checking
    // only the resting box would leave the state that actually destroys something
    // unguarded.
    const resting = await measureDelete(page);
    await krakenDelete(page).click();
    await expect(krakenDelete(page)).toHaveClass(/\barmed\b/);
    const armed = await measureDelete(page);

    for (const [state, geom] of [
      ["resting", resting],
      ["armed", armed],
    ] as const) {
      expect(geom, `#cred-delete-kraken must render (${state})`).not.toBeNull();
      expect(geom!.h, `${state}: delete must be a real touch target`).toBeGreaterThanOrEqual(44);
      expect(geom!.w, `${state}: delete must be a real touch target`).toBeGreaterThanOrEqual(44);

      // The other half of the trade, and the reason it is in the same test: the
      // nearest neighbour is `Update`, which WIPES the add/update form — so a
      // bigger Delete crowding it trades one accident for another.
      expect(
        geom!.neighbours,
        `${state}: there must be a sibling control to measure against`,
      ).toBeGreaterThan(-1);
      expect(
        geom!.neighbours,
        `${state}: nearest control to Delete was "${geom!.who}" at ${geom!.neighbours}px — ` +
          `enlarging a no-undo control without separating it makes mis-taps MORE likely`,
      ).toBeGreaterThanOrEqual(12);

      // A tappable control that runs off a 390px screen is not tappable.
      expect(geom!.right, `${state}: must stay on screen`).toBeLessThanOrEqual(PHONE.width);
    }
  });

  test("9. touch: one press that fires twice is swallowed; a real tap still deletes", async ({
    page,
  }) => {
    // The worst timing there is — two `click` events from ONE press, 0ms apart.
    // That is the hazard on a phone (a glitchy digitizer / a synthesized
    // compatibility click on top of a tap), and it is delivered from inside the
    // page because the harness CANNOT drive two `tap()`s fast enough: measured
    // 913ms apart through Chromium's mobile emulation, i.e. outside the cooldown,
    // which the instrumentation caught as a run that tested nothing rather than
    // reporting a false pass.
    const seam = await installSettings(page);
    await gotoSettings(page);

    const btn = krakenDelete(page);
    await expect(btn).toHaveText("Delete"); // the row must exist before instrumenting it
    await instrumentClicks(page, "#cred-delete-kraken");

    await page.evaluate(() => {
      const el = document.querySelector("#cred-delete-kraken") as HTMLElement;
      el.click();
      el.click();
    });
    await page.waitForTimeout(RIPE_MS);
    expectDoubleFire(await clickTimings(page));
    expect(seam.deletes, "one press that fires twice must not delete a secret").toEqual([]);

    // Positive control on the touch path itself: a real thumb tap still completes
    // the action, so the guard has not made the phone unusable for a key rotation.
    await btn.tap();
    await expect.poll(() => seam.deletes).toEqual(["/api/settings/exchange-keys/kraken"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A tap aimed at a 44px ConfirmButton must LAND on it.
//
// A review flagged the last channel's Delete as sitting "1.0px" (measured here:
// 0px) from StatusBar's logout button, and read that as a mis-tap hazard.
// Layout-box adjacency is the WRONG metric: the workspace clips the pane and
// the stacking order decides the tap. Probing elementFromPoint at the top,
// middle and bottom of every ConfirmButton shows all nine points landing on the
// button itself — there was no hazard.
//
// This guard therefore asserts what actually matters (hit-testing), not a
// distance. A distance assertion would have failed on a healthy page and sent
// the next reader chasing a phantom, which is exactly what happened here.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("ConfirmButton: taps land on the button, not a neighbour", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("every point on every ConfirmButton hit-tests to itself", async ({ page }) => {
    await page.route(
      (u) => u.pathname === "/api/settings/notifications",
      (r) =>
        r.fulfill({
          json: {
            db_enabled: true,
            channels: [
              { name: "discord-money", kind: "discord", events: [] },
              { name: "discord-ops", kind: "discord", events: ["bot_crashed"] },
            ],
          },
        }),
    );
    await page.goto("/settings");

    const btns = page.locator(".confirm-btn");
    await expect(btns.first()).toBeVisible();
    expect(await btns.count(), "the mocked channels must render their Delete").toBeGreaterThan(0);

    // Each button is SCROLLED INTO VIEW before probing. `elementFromPoint` is
    // viewport-relative and returns null for anything off-screen, so probing at
    // the page's initial scroll position tested only whichever buttons happened
    // to fit and reported the rest as misses — which a longer /settings page
    // then "broke" without introducing any hazard. A control below the fold
    // receives no taps at all, so that is not what this guard is about;
    // conflating "not visible" with "overlapped by a neighbour" is the same
    // category error as the layout-box distance the comment above rejects.
    //
    // WHAT THIS DOES AND DOES NOT COVER, stated plainly because the scroll
    // changes the guard's reach in both directions:
    //   GAINED — every ConfirmButton is now probed, including ones below the
    //            initial fold, which previously went untested or were reported
    //            as `null` misses purely for being off-screen.
    //   LOST   — a button resting ON the workspace/StatusBar seam. Centring it
    //            means it is never at the edge. This was measured, not assumed:
    //            reverting the `.page-scroll` bottom padding leaves this test
    //            PASSING, so it no longer detects that case.
    // The seam is addressed in CSS instead (`.page-scroll { padding-bottom }`),
    // which prevents it rather than detecting it. A guard for it would need to
    // probe at a scroll offset that deliberately parks a control on the seam.
    const misses = await page.evaluate(async () => {
      const out: string[] = [];
      const btns = Array.from(document.querySelectorAll(".confirm-btn")) as HTMLElement[];
      for (const b of btns) {
        b.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const r = b.getBoundingClientRect();
        for (const y of [r.top + 4, r.top + r.height / 2, r.bottom - 4]) {
          const hit = document.elementFromPoint(r.left + r.width / 2, y);
          if (!hit || !(b === hit || b.contains(hit))) {
            out.push(`${(b.textContent || "").trim()} @y=${Math.round(y)} -> ${hit ? (hit as HTMLElement).className : "null"}`);
          }
        }
      }
      return out;
    });
    expect(misses, "a tap on a confirm control reached something else").toEqual([]);
  });
});
