import { test, expect, type Page } from "@playwright/test";

/**
 * /settings → Risk Controls — the fabrication guard (robustness plan R1).
 *
 * The panel used to seed itself with $5,000 daily loss / 10 positions /
 * $5,000,000 gross exposure and KEEP those numbers whenever the load failed
 * (`catch {}` + `!= null` guards over a seam that swallowed every failure into
 * `{}`). An unreachable risk service therefore rendered three invented limits
 * as though they were the live janus config — and left Save enabled, so one
 * click wrote the fabrication over the real risk config.
 *
 * These specs pin the two properties that make that impossible:
 *   1. an unknown config is presented as UNKNOWN (blank + a stated reason),
 *      never as a number;
 *   2. Save is unreachable until a load actually returned the live limits.
 *
 * Everything is `page.route`-mocked, so no janus and no network timing.
 */

const RISK_ROUTE = "**/api/settings/risk";

/** The exact numbers the old panel invented. If any of these ever appears in a
 *  field again without janus having sent it, R1 has regressed. */
const FABRICATED_DAILY_LOSS = "5000";
const FABRICATED_POSITIONS = "10";
const FABRICATED_GROSS = "5000000";

/** A real rustrade PortfolioRiskConfig as the adapter reshapes it. */
const LIVE_CONFIG = {
  max_daily_loss_usd: 1234,
  max_positions: 3,
  max_gross_exposure_usd: 250_000,
};

async function gotoSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await expect(page).toHaveTitle("Settings — FKS Terminal");
}

function riskPanel(page: Page) {
  return page.locator(".panel", {
    has: page.locator(".panel-title", { hasText: "Risk Controls" }),
  });
}

/** Every risk input is blank — the panel is showing "unknown", not a guess. */
async function expectNoLimitsShown(page: Page): Promise<void> {
  await expect(page.locator("#risk-daily-loss")).toHaveValue("");
  await expect(page.locator("#risk-max-positions")).toHaveValue("");
  await expect(page.locator("#risk-gross-exposure")).toHaveValue("");
}

test.describe("Risk Controls — unknown config is never rendered as a number", () => {
  test("1. risk service unreachable → blank fields + stated reason, Save disabled", async ({
    page,
  }) => {
    await page.route(RISK_ROUTE, (route) =>
      route.fulfill({
        status: 502,
        json: {
          error: "risk_config_unreachable",
          message: "the risk service is unreachable",
        },
      }),
    );
    await gotoSettings(page);

    const panel = riskPanel(page);

    // The fabrication itself: not one of the seeded numbers may appear.
    await expectNoLimitsShown(page);
    await expect(page.locator("#risk-daily-loss")).not.toHaveValue(FABRICATED_DAILY_LOSS);
    await expect(page.locator("#risk-max-positions")).not.toHaveValue(FABRICATED_POSITIONS);
    await expect(page.locator("#risk-gross-exposure")).not.toHaveValue(FABRICATED_GROSS);

    // The writable half of the bug: Save must not be reachable.
    await expect(page.locator("#risk-save")).toBeDisabled();

    // Honest, not merely blank — the panel says WHY, and says the blanks are
    // "unknown" rather than "no limit set".
    await expect(panel).toContainText("Live risk limits unavailable");
    await expect(panel).toContainText("the risk service is unreachable");
    // (string, not regex — Playwright normalizes whitespace only for strings,
    // and the copy wraps across lines around its <em>s)
    await expect(panel).toContainText("A blank field below means unknown, not unset");

    // And an escape hatch, so one transient blip doesn't wedge the panel until
    // a full page reload.
    await expect(page.locator("#risk-retry")).toBeEnabled();
  });

  test("2. a 200 carrying no recognizable limit is refused just as hard", async ({ page }) => {
    // Defence in depth: the adapter already 502s this shape, but if that guard
    // ever regresses the client must still refuse to invent limits.
    await page.route(RISK_ROUTE, (route) => route.fulfill({ status: 200, json: {} }));
    await gotoSettings(page);

    await expectNoLimitsShown(page);
    await expect(page.locator("#risk-save")).toBeDisabled();
    await expect(riskPanel(page)).toContainText(
      "did not report max daily loss, max positions, max gross exposure",
    );
  });

  test("3. partial config → shows what janus sent, blanks the rest, Save still disabled", async ({
    page,
  }) => {
    await page.route(RISK_ROUTE, (route) =>
      route.fulfill({ status: 200, json: { max_positions: 7 } }),
    );
    await gotoSettings(page);

    // Real value renders; the two janus never sent stay blank (NOT 5000/5000000).
    await expect(page.locator("#risk-max-positions")).toHaveValue("7");
    await expect(page.locator("#risk-daily-loss")).toHaveValue("");
    await expect(page.locator("#risk-gross-exposure")).toHaveValue("");

    // Saving would write the two unknown fields as a guess → refused.
    await expect(page.locator("#risk-save")).toBeDisabled();
    await expect(riskPanel(page)).toContainText(
      "did not report max daily loss, max gross exposure",
    );
  });

  test("4. the operator cannot type limits in and unlock Save over an unknown config", async ({
    page,
  }) => {
    await page.route(RISK_ROUTE, (route) =>
      route.fulfill({ status: 502, json: { error: "risk_config_unreachable" } }),
    );
    await gotoSettings(page);

    // Blind-write path closed at the input, not just at the button.
    await expect(page.locator("#risk-daily-loss")).toBeDisabled();
    await expect(page.locator("#risk-max-positions")).toBeDisabled();
    await expect(page.locator("#risk-gross-exposure")).toBeDisabled();
    await expect(page.locator("#risk-save")).toBeDisabled();
  });

  test("5. Retry re-reads the config and restores the panel once janus is back", async ({
    page,
  }) => {
    let reachable = false;
    // What the panel was told, in order. `reachable` is flipped from Node while
    // the page runs, so recording it per request is the only way to know which
    // side of the outage each read actually landed on.
    const reads: boolean[] = [];
    await page.route(RISK_ROUTE, (route) => {
      reads.push(reachable);
      return reachable
        ? route.fulfill({ status: 200, json: LIVE_CONFIG })
        : route.fulfill({
            status: 502,
            json: { error: "risk_config_unreachable", message: "the risk service is unreachable" },
          });
    });
    await gotoSettings(page);

    // Synchronize on the outage being ON SCREEN before healing the seam.
    //
    // This used to wait only for `#risk-save` to be disabled — but Save is
    // disabled while `riskLoading` too, so that assertion is satisfied by the
    // first paint, before the panel has issued its first read at all. Flipping
    // `reachable` there raced the mount fetch and won: the app was served a
    // 200, never saw a 502, never rendered the outage banner, so `#risk-retry`
    // did not exist and the click sat there until the 15s test budget expired
    // ("locator.click: Test timeout ... waiting for locator('#risk-retry')").
    // The spec was testing nothing about Retry; it was losing a race.
    await expect(riskPanel(page)).toContainText("Live risk limits unavailable");
    await expect(page.locator("#risk-retry")).toBeEnabled();
    await expectNoLimitsShown(page);
    await expect(page.locator("#risk-save")).toBeDisabled();
    // The outage was REAL: the panel asked and was refused. Without this the
    // spec cannot tell a genuine 502 from a read that never happened.
    expect(reads, "the panel must have read the config and been refused").toEqual([false]);

    reachable = true;
    await page.locator("#risk-retry").click();

    await expect(page.locator("#risk-daily-loss")).toHaveValue("1234");
    await expect(page.locator("#risk-max-positions")).toHaveValue("3");
    await expect(page.locator("#risk-gross-exposure")).toHaveValue("250000");
    await expect(page.locator("#risk-save")).toBeEnabled();
    await expect(riskPanel(page)).not.toContainText("Live risk limits unavailable");
    // "re-reads" is the load-bearing word: the restored numbers must come from a
    // SECOND read of the live config, not from state the panel was already
    // holding. Exactly one extra read — no refetch storm behind the button.
    expect(reads, "Retry must issue exactly one fresh read").toEqual([false, true]);
  });

  test("6. positive control — a real config renders and Save is available", async ({ page }) => {
    // Without this, specs 1-4 would also pass on a panel that is simply broken.
    await page.route(RISK_ROUTE, (route) => route.fulfill({ status: 200, json: LIVE_CONFIG }));
    await gotoSettings(page);

    await expect(page.locator("#risk-daily-loss")).toHaveValue("1234");
    await expect(page.locator("#risk-max-positions")).toHaveValue("3");
    await expect(page.locator("#risk-gross-exposure")).toHaveValue("250000");
    await expect(page.locator("#risk-save")).toBeEnabled();
    await expect(riskPanel(page)).not.toContainText("Live risk limits unavailable");
  });
});

test.describe("live-server seam (unmocked)", () => {
  test("GET /api/settings/risk never answers 200 without a real limit in it", async ({ page }) => {
    // The seam invariant R1 buys: a 200 from this route MEANS janus answered
    // with a config. Before the fix the route used `janusJson`, which swallows
    // every failure (and never checked `r.ok`) into `{}` → `200 {}`, which the
    // panel could only interpret by falling back to its own invented numbers.
    // Written as an invariant so it holds whether or not janus is reachable
    // from the test host.
    const res = await page.request.get("/api/settings/risk");
    const body = await res.json();

    if (res.status() === 200) {
      const known = [body.max_daily_loss_usd, body.max_positions, body.max_gross_exposure_usd];
      expect(
        known.some((v) => typeof v === "number" && Number.isFinite(v)),
        `200 with no recognizable limit: ${JSON.stringify(body)}`,
      ).toBe(true);
    } else {
      expect(res.status()).toBe(502);
      expect(String(body.error)).toMatch(/^risk_config_(unreachable|unrecognized)$/);
    }
  });
});
