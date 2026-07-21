import { test, expect, type Page } from "@playwright/test";
import {
  cockpitConfiguredFalse,
  cockpitState,
  exchangesStatus,
  instanceView,
  openPosition,
  positionStatus,
  telemetryDormant,
  telemetryScraped,
  telemetryUnavailable,
  type ArmedTelemetry,
  type CockpitStateResp,
  type ExchangesStatus,
} from "./fixtures/cockpit";

/**
 * Cockpit E2E — the money-critical armed-futures co-pilot flows.
 *
 * Strategy (webui-plan Track 04, Phase C): route-mock the cockpit APIs
 * (`page.route`) so every honest-empty / kill-guard branch is exercised
 * deterministically with no DB and no Prometheus. A separate `live-server
 * seam` block runs UNMOCKED against the dev server's own deterministic
 * degraded responses (WEBUI_AUTH=disabled ⇒ kill 403, state configured:false).
 *
 * No spec depends on poll timing: mocks are installed BEFORE goto and each
 * poll tick re-requests the same mocked route, so assertions hold on first
 * render and forever after.
 */

interface MockOpts {
  state?: CockpitStateResp;
  telemetry?: ArmedTelemetry;
  exchanges?: ExchangesStatus;
  /** Captures the POST /api/cockpit/kill body; when set, kill replies 200 ok
   *  unless `killStatus`/`killBody` override it. */
  onKill?: (body: unknown) => void;
  killStatus?: number;
  killBody?: unknown;
}

/**
 * Install the three cockpit poll mocks (+ optional kill interceptor) BEFORE
 * navigating. Anything not supplied falls back to a benign default so the page
 * never hits the real dev-server backend during a mocked spec.
 */
async function installCockpitMocks(page: Page, opts: MockOpts = {}): Promise<void> {
  const state = opts.state ?? cockpitState();
  const telemetry = opts.telemetry ?? telemetryScraped();
  const exchanges = opts.exchanges ?? exchangesStatus(null);

  await page.route("**/api/cockpit/state", (route) =>
    route.fulfill({ json: state }),
  );
  await page.route("**/api/cockpit/telemetry", (route) =>
    route.fulfill({ json: telemetry }),
  );
  await page.route("**/api/exchanges/status", (route) =>
    route.fulfill({ json: exchanges }),
  );

  if (opts.onKill || opts.killStatus !== undefined) {
    await page.route("**/api/cockpit/kill", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      opts.onKill?.(route.request().postDataJSON());
      route.fulfill({
        status: opts.killStatus ?? 200,
        json: opts.killBody ?? { ok: true, effect: "kill sentinel written (paper)" },
      });
    });
  }
}

/** Deterministic ready signal — the cockpit polls, so the network never idles;
 *  the title is the stable "page mounted" marker (mirrors viewport.spec). */
async function gotoCockpit(page: Page): Promise<void> {
  await page.goto("/cockpit");
  await expect(page).toHaveTitle("Cockpit — FKS Terminal");
}

/** A Panel located by its .panel-title text. */
function panel(page: Page, titleText: string | RegExp) {
  return page.locator(".panel", {
    has: page.locator(".panel-title", { hasText: titleText }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// C2 — Honest-empty states
// ─────────────────────────────────────────────────────────────────────────────

test.describe("cockpit honest-empty states", () => {
  test("1. configured:false → 'Cockpit database not available' panel with reason", async ({
    page,
  }) => {
    const reason = "funding_kill_switch table absent — store not bootstrapped";
    await installCockpitMocks(page, { state: cockpitConfiguredFalse(reason) });
    await gotoCockpit(page);

    const store = panel(page, "Cockpit store");
    await expect(store.getByText("Cockpit database not available")).toBeVisible();
    await expect(store.getByText(reason)).toBeVisible();
    // The kill sentinel reads UNKNOWN (never a fake CLEAR) while the store is down.
    await expect(
      panel(page, /Kill switch/).getByText("UNKNOWN"),
    ).toBeVisible();
  });

  test("2. telemetry available:false → 'Prometheus unreachable' error state", async ({
    page,
  }) => {
    await installCockpitMocks(page, { telemetry: telemetryUnavailable() });
    await gotoCockpit(page);

    const tele = panel(page, /Armed-path telemetry/);
    await expect(tele.getByText("Prometheus unreachable")).toBeVisible();
    await expect(
      tele.getByText(/halt\/breaker\/stop divergence cannot be observed/),
    ).toBeVisible();
  });

  test("3. available:true + scraped:false → no-series honest state + LIVE 'no live bot' banner, session stats suppressed", async ({
    page,
  }) => {
    await installCockpitMocks(page, { telemetry: telemetryDormant() });
    await gotoCockpit(page);

    // Telemetry panel: the honest "no live armed-path series" (NOT zeros).
    const tele = panel(page, /Armed-path telemetry/);
    await expect(tele.getByText("No live armed-path series")).toBeVisible();

    // Switch to the LIVE tab — no live evidence anywhere ⇒ the fake-flat-bot guard.
    await page.getByRole("tab", { name: "LIVE" }).click();
    await expect(page.getByText("LIVE — no live bot detected")).toBeVisible();

    // Session stats are suppressed (an empty ledger must not read as a flat bot).
    await expect(
      page.getByText(/Session stats suppressed — no live bot detected/),
    ).toBeVisible();
    // And no realized-PnL stat card is rendered under the banner.
    await expect(page.getByText("Session realized (UTC day)")).toHaveCount(0);
  });

  test("4. failed:['orderErrors'] → 'counter unobserved' caveat, never the green all-clear", async ({
    page,
  }) => {
    await installCockpitMocks(page, {
      telemetry: telemetryScraped({ failed: ["orderErrors"], orderErrors: [] }),
    });
    await gotoCockpit(page);

    const errs = panel(page, /Order errors by class/);
    await expect(errs.getByText("Order-error counter unobserved")).toBeVisible();
    await expect(errs.getByText(/NOT a zero-errors all-clear/)).toBeVisible();
    // The benign green "No order errors recorded" all-clear must NOT appear.
    await expect(errs.getByText("No order errors recorded")).toHaveCount(0);
  });

  test("5. failed:['stopExpected'] → stop column 'divergence cannot be assessed' error", async ({
    page,
  }) => {
    await installCockpitMocks(page, {
      telemetry: telemetryScraped({ failed: ["stopExpected"] }),
    });
    await gotoCockpit(page);

    const tele = panel(page, /Armed-path telemetry/);
    await expect(
      tele.getByText(/divergence cannot be assessed/),
    ).toBeVisible();
    // The stop column must NOT render a green "protected" badge when the query
    // failed (exact match — the error copy contains the substring "unprotected").
    await expect(tele.getByText("protected", { exact: true })).toHaveCount(0);
  });

  test("6. live positions + live sentinel killed → KILLED badge + re-arm button swap", async ({
    page,
  }) => {
    await installCockpitMocks(page, {
      state: cockpitState({
        live: {
          sentinel: {
            state: "killed",
            reason: "webui kill by ops: drill",
            trippedAtMs: Date.now() - 120_000,
          },
          gateBotName: "kucoin-futures-live",
          positions: [openPosition({ symbol: "ETHUSDTM" })],
        },
      }),
    });
    await gotoCockpit(page);
    await page.getByRole("tab", { name: "LIVE" }).click();

    const kill = panel(page, /Kill switch/);
    await expect(kill.getByText("KILLED")).toBeVisible();
    // The action swaps to RE-ARM; the KILL button is gone on a killed instance.
    await expect(kill.getByRole("button", { name: /RE-ARM live/ })).toBeVisible();
    await expect(kill.getByRole("button", { name: /^KILL live/ })).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 — Kill-flow guard rails (the money path)
// ─────────────────────────────────────────────────────────────────────────────

test.describe("kill flow", () => {
  /** The confirm button inside the open modal footer (NOT the page's own
   *  KILL/RE-ARM button, which lives outside the dialog). */
  function dialogConfirm(page: Page, kind: "kill" | "rearm") {
    return page
      .getByRole("dialog")
      .locator(`button.${kind === "rearm" ? "btn-rearm" : "btn-kill"}`);
  }
  /** The typed-phrase input (first .confirm-input; the second is the note). */
  function phraseInput(page: Page) {
    return page.getByRole("dialog").locator(".confirm-input").first();
  }

  test("1. confirm disabled until input === 'KILL' EXACTLY (case-sensitive, untrimmed)", async ({
    page,
  }) => {
    await installCockpitMocks(page, { onKill: () => {} });
    await gotoCockpit(page);

    await page.locator(".kill-actions button.btn-kill").click();
    const confirm = dialogConfirm(page, "kill");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(confirm).toBeDisabled();

    // Lowercase must NOT unlock it (case-sensitive contract).
    await phraseInput(page).fill("kill");
    await expect(confirm).toBeDisabled();

    // Trailing space must NOT unlock it (untrimmed contract).
    await phraseInput(page).fill("KILL ");
    await expect(confirm).toBeDisabled();

    // Exact phrase unlocks it.
    await phraseInput(page).fill("KILL");
    await expect(confirm).toBeEnabled();
  });

  test("2. fire → body is exactly {instance:'paper', confirm:'KILL', note}", async ({
    page,
  }) => {
    let captured: unknown = null;
    await installCockpitMocks(page, { onKill: (b) => (captured = b) });
    await gotoCockpit(page);

    await page.locator(".kill-actions button.btn-kill").click();
    await phraseInput(page).fill("KILL");
    await page.getByRole("dialog").locator(".confirm-input").nth(1).fill("e2e test");
    await dialogConfirm(page, "kill").click();

    await expect
      .poll(() => captured)
      .toEqual({ instance: "paper", confirm: "KILL", note: "e2e test" });
  });

  test("3. LIVE tab → dialog title says LIVE, body carries instance:'live'; PAPER dialog shows the Gate-A warning", async ({
    page,
  }) => {
    let captured: unknown = null;
    await installCockpitMocks(page, {
      onKill: (b) => (captured = b),
      killBody: { ok: true, effect: "kill sentinel written (live)" },
    });
    await gotoCockpit(page);

    // PAPER dialog first — assert the Gate-A sacred-window warning, then cancel.
    await page.locator(".kill-actions button.btn-kill").click();
    const paperDialog = page.getByRole("dialog");
    await expect(paperDialog.getByText(/Gate-A measurement twin/)).toBeVisible();
    await expect(paperDialog.getByText(/window is sacred until ~Aug 1/)).toBeVisible();
    await paperDialog.getByRole("button", { name: "Cancel" }).click();

    // LIVE tab → open the LIVE kill dialog.
    await page.getByRole("tab", { name: "LIVE" }).click();
    await page.locator(".kill-actions button.btn-kill").click();
    const liveDialog = page.getByRole("dialog");
    await expect(liveDialog.locator(".title")).toContainText("KILL LIVE");
    await expect(liveDialog.getByText(/REAL-MONEY instance/)).toBeVisible();

    await phraseInput(page).fill("KILL");
    await dialogConfirm(page, "kill").click();
    await expect
      .poll(() => (captured as { instance?: string } | null)?.instance)
      .toBe("live");
  });

  test("4. server 403 → error shown inline, dialog stays open, state NOT refreshed", async ({
    page,
  }) => {
    let stateHits = 0;
    await installCockpitMocks(page, {
      killStatus: 403,
      killBody: { message: "live_mutation_requires_auth" },
      onKill: () => {},
    });
    // Count state fetches so we can assert the failed kill did NOT trigger the
    // success-path statePoll.refresh() (a fake-success would refetch
    // immediately). This route is registered AFTER installCockpitMocks ON
    // PURPOSE: Playwright matches routes in reverse-registration order and stops
    // at the first handler that fulfills, so the LAST-registered route for a URL
    // wins. Registered before installCockpitMocks, the fixture's own
    // **/api/cockpit/state route would shadow this counter and stateHits would
    // never move — making the guard vacuous.
    await page.route("**/api/cockpit/state", (route) => {
      stateHits += 1;
      route.fulfill({ json: cockpitState() });
    });
    await gotoCockpit(page);

    await page.locator(".kill-actions button.btn-kill").click();
    await phraseInput(page).fill("KILL");
    const hitsBefore = stateHits;
    await dialogConfirm(page, "kill").click();

    // Error rendered inline inside the still-open dialog.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/403/)).toBeVisible();
    await expect(dialog.getByText(/live_mutation_requires_auth/)).toBeVisible();

    // The failed write must NOT clear the confirm input …
    await expect(phraseInput(page)).toHaveValue("KILL");

    // … nor call the success-path statePoll.refresh(). A regression that fires
    // refresh() on the error path (moving it out of `if (r.ok)`, or an
    // unconditional `finally { statePoll.refresh() }`) issues an IMMEDIATE extra
    // /api/cockpit/state fetch the moment the kill rejects. Settle briefly so
    // that immediate refetch (network ~sub-second) would have landed — the
    // window is far shorter than the 5s background poll cadence, so a poll tick
    // cannot masquerade as the refresh — then assert EXACTLY zero extra hits.
    // (The former `<= hitsBefore + 1` tolerance was toothless: the success path
    // adds exactly one refresh, so +1 could not tell a correct 403 handler from
    // a regressed one that spuriously refreshes on failure.)
    await page.waitForTimeout(750);
    expect(stateHits).toBe(hitsBefore);
  });

  test("5. re-arm flow → phrase 'REARM' + unreconciled-venue warning", async ({
    page,
  }) => {
    await installCockpitMocks(page, {
      state: cockpitState({
        paper: {
          sentinel: {
            state: "killed",
            reason: "webui kill by ops",
            trippedAtMs: Date.now() - 60_000,
          },
        },
      }),
    });
    await gotoCockpit(page);

    await page.locator(".kill-actions button.btn-rearm").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".title")).toContainText("Re-arm PAPER");
    await expect(dialog.getByText(/Never re-arm with an unreconciled venue/)).toBeVisible();

    const confirm = dialogConfirm(page, "rearm");
    // The kill phrase must NOT satisfy a re-arm (each has its own phrase).
    await phraseInput(page).fill("KILL");
    await expect(confirm).toBeDisabled();
    await phraseInput(page).fill("REARM");
    await expect(confirm).toBeEnabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C4 — Live-server (unmocked) seam specs
// These run against the REAL dev server (no route mocks) — the disabled-mode
// hook refuses the kill and the store is honestly not configured on a clone.
// ─────────────────────────────────────────────────────────────────────────────

test.describe("live-server seam (unmocked)", () => {
  test("1. POST /api/cockpit/kill (live) → 403 live_mutation_requires_auth", async ({
    page,
  }) => {
    const res = await page.request.post("/api/cockpit/kill", {
      data: { instance: "live", confirm: "KILL" },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("live_mutation_requires_auth");
  });

  test("2. GET /api/cockpit/state → configured:false + page renders the outage panel", async ({
    page,
  }) => {
    const res = await page.request.get("/api/cockpit/state");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.configured).toBe(false);

    // The honest-empty default a fresh clone actually shows.
    await gotoCockpit(page);
    await expect(
      page.getByText("Cockpit database not available"),
    ).toBeVisible();
  });
});
