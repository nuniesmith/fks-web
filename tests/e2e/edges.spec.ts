import { test, expect, type Route } from "@playwright/test";
import { installHome } from "./fixtures/home";
import { installLadder, JOB_TEMPLATE, LADDER } from "./fixtures/ladder";

/**
 * The edge ladder (EDGE_PROCESS_2026-10-26): the board on /edges, the
 * Register-hypothesis form on /edges/new, and the deployment moves. The
 * spawner and Postgres decide every rung; these check the page shows each
 * item on its rung, sends what the spawner expects, and shows a refusal in
 * the database's own words. Hermetic: fixtures/ladder.ts.
 */

test.describe("Edges: the ladder", () => {
  test("every item is on its rung, with what it waits for", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    await page.goto("/edges");

    const board = page.getByTestId("ladder-board");
    const col = (name: string) => board.getByRole("region", { name });
    // #3 waits for a search; #2 was searched; #1 was withdrawn.
    await expect(col("Hypotheses").getByTestId("hypothesis-card")).toHaveCount(1);
    await expect(col("Hypotheses").getByTestId("hypothesis-card")).toHaveAttribute("data-hypothesis", "3");
    await expect(col("Hypotheses")).toContainText("threshold_usd 1000000..20000000 step 1000000");
    await expect(col("Hypotheses")).toContainText("side: long | short");

    const searched = col("Searched").getByTestId("experiment-card");
    await expect(searched).toHaveCount(2);
    await expect(searched.nth(0)).toContainText("USABLE");
    await expect(searched.nth(0)).toContainText("Deployed: #11 forward, #12 backtest");
    await expect(searched.nth(1)).toContainText("DO NOT PASTE");
    await expect(searched.nth(1)).toContainText("U4: 9 holdout trades, under 30");
    await expect(searched.nth(1)).toContainText("Stops here. It still counts toward N.");

    const forward = col("Forward").getByTestId("deployment-card");
    await expect(forward).toHaveCount(2);
    await expect(forward.nth(0)).toContainText("4 of 20 sessions observed; live opens at 20.");
    await expect(col("Live")).toContainText("No edge trades money yet.");
    await expect(page.getByText("Retired 1 · withdrawn 1")).toBeVisible();

    const effort = page.getByRole("table", { name: "Search effort per family" });
    await expect(effort).toContainText("fp-liq");
    await expect(effort).toContainText("80");
  });

  test("a promotion sends what the spawner expects, and a refusal is shown in Postgres's words", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    const sent: unknown[] = [];
    await page.route(
      (url) => /^\/api\/spawner\/deployments\/\d+\/promote$/.test(url.pathname),
      async (route: Route) => {
        sent.push(route.request().postDataJSON());
        await route.fulfill({
          status: 409,
          json: {
            error: "backtest->forward requires the experiment verdict to be USABLE (experiment 2 is DO NOT PASTE)",
            detail: null,
          },
        });
      },
    );
    await page.goto("/edges");
    const card = page.locator('[data-testid="deployment-card"][data-deployment="12"]');
    await expect(async () => {
      await card.getByRole("button", { name: "Start forward…" }).click();
      await expect(card.getByLabel("Sessions required")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await card.getByLabel("Sessions required").fill("25");
    await card.getByRole("button", { name: "Forward, 25 sessions" }).click();
    await expect(card.getByRole("alert")).toContainText("requires the experiment verdict to be USABLE");
    expect(sent).toEqual([{ to: "forward", forward_sessions_required: 25 }]);
  });

  test("going live needs the account and symbol typed out", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    let sent: unknown = null;
    await page.route(
      (url) => url.pathname === "/api/spawner/deployments/11/promote",
      async (route: Route) => {
        sent = route.request().postDataJSON();
        await route.fulfill({ json: { ok: true, deployment: { ...LADDER.deployments[0], stage: "live" } } });
      },
    );
    await page.goto("/edges");
    const card = page.locator('[data-testid="deployment-card"][data-deployment="11"]');
    await expect(async () => {
      await card.getByRole("button", { name: "Go live…" }).click();
      await expect(card.getByRole("button", { name: "Go live", exact: true })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    const go = card.getByRole("button", { name: "Go live", exact: true });
    await expect(go).toBeDisabled();
    await card.getByLabel(/to go live/).fill("kraken-main/BTCUSD");
    await expect(go).toBeDisabled();
    await card.getByLabel(/to go live/).fill("kraken-main/BTCUSDT");
    await expect(go).toBeEnabled();
    await go.click();
    await expect.poll(() => sent).toEqual({ to: "live" });
  });
});

test.describe("Edges: a deployment trades its search's selection", () => {
  test("deploy shows the selection and sends no parameters; a forward card links its runner", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    let body: Record<string, unknown> | null = null;
    await page.route(
      (url) => url.pathname === "/api/spawner/deployments",
      async (route: Route) => {
        if (route.request().method() !== "POST") return route.fallback();
        body = route.request().postDataJSON();
        await route.fulfill({ status: 201, json: { ok: true, deployment: {} } });
      },
    );
    await page.goto("/edges");
    await page.getByRole("button", { name: "Deploy…" }).click();
    await expect(page.getByTestId("deploy-selection")).toContainText('{"threshold_usd":5000000}');
    await expect(page.getByRole("textbox", { name: /Parameters it trades/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Create at backtest" }).click();
    await expect.poll(() => body).toEqual({ experiment_id: 1, account_id: "kraken-main", symbol: "BTCUSDT" });

    const forwardCard = page.locator('[data-testid="deployment-card"][data-stage="forward"]');
    await expect(forwardCard.getByRole("link", { name: "Forward runner…" })).toHaveAttribute(
      "href",
      "/tasks/new?template=bot.edge-forward&deployment_id=11",
    );
    await expect(forwardCard.getByRole("link", { name: "Signal runner…" })).toHaveAttribute(
      "href",
      "/tasks/new?template=bot.edge-signal&deployment_id=11",
    );
  });
});

test.describe("Edges: the monitor (fks 030)", () => {
  test("a card shows the forward band and the CUSUM; a retired one says why", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    await page.goto("/edges");
    const forward = page.locator('[data-testid="deployment-card"][data-deployment="11"]');
    const monitor = forward.getByTestId("deployment-monitor");
    await expect(monitor).toContainText("pending");
    await expect(monitor).toContainText("4/20 sessions, mean 0.040% against a floor of -0.020%");
    await expect(monitor).toContainText("1.20 of 9.80 over 4 sessions");

    await page.getByText("Retired 1 · withdrawn 1").click();
    const retired = page.locator('[data-testid="deployment-card"][data-deployment="10"]');
    await expect(retired.getByTestId("retired-reason")).toHaveText("drift on 2 consecutive days");
    await expect(retired.getByTestId("deployment-monitor")).toContainText("(alarm on 2026-10-30)");
    await expect(retired.getByRole("link", { name: "Forward runner…" })).toHaveCount(0);
  });

  test("a board from before the monitor shows no monitor", async ({ page }) => {
    await installHome(page);
    const { health: _health, ...old } = LADDER;
    await installLadder(page, old);
    await page.goto("/edges");
    await expect(page.locator('[data-testid="deployment-card"][data-deployment="11"]')).toBeVisible();
    await expect(page.getByTestId("deployment-monitor")).toHaveCount(0);
  });
});

test.describe("Edges: register a hypothesis", () => {
  test("says what to fix before anything is sent", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    let posted = false;
    await page.route(
      (url) => url.pathname.endsWith("/hypotheses"),
      async (route: Route) => {
        posted = true;
        await route.fulfill({ status: 500, json: {} });
      },
    );
    await page.goto("/edges/new");
    await expect(page.getByRole("combobox", { name: "Edge", exact: true })).toHaveValue("liq-fade");
    await page.getByRole("button", { name: "Register, frozen from now" }).click();
    const fix = page.getByRole("list", { name: "What to fix" });
    await expect(fix).toContainText("The idea needs at least 20 characters");
    await expect(fix).toContainText("a start date before its end date");
    await expect(fix).toContainText("Name at least one symbol");
    await expect(fix).toContainText("a name is lower-case letters");
    expect(posted).toBe(false);
  });

  test("sends the five parts of §2 and its evidence path, then shows it on the board", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    let body: Record<string, unknown> | null = null;
    await page.route(
      (url) => url.pathname === "/api/spawner/edges/liq-fade/hypotheses",
      async (route: Route) => {
        body = route.request().postDataJSON();
        await route.fulfill({ status: 201, json: { ok: true, hypothesis: { ...LADDER.hypotheses[0], id: 7 } } });
      },
    );
    await page.goto("/edges/new");
    await expect(page.getByRole("combobox", { name: "Edge", exact: true })).toHaveValue("liq-fade");
    await page
      .getByLabel("One sentence, with the mechanism")
      .fill("Funding spikes on SOLUSDT mean-revert within a day; fade the extreme.");
    await page.getByLabel("Symbols").fill("solusdt, ethusdt");
    // The lake folders come from the instances (here the btc recorder's).
    await expect(page.getByRole("combobox", { name: "Lake folder", exact: true })).toHaveValue("raw/binance/usdm/btc");
    await page.getByRole("combobox", { name: "Bars", exact: true }).selectOption("1h");
    await page.getByLabel("From").fill("2026-01-01");
    await page.getByLabel("To", { exact: true }).fill("2026-10-01");
    await expect(page.getByTestId("dataset-text")).toContainText("raw/binance/usdm/btc 1h 2026-01-01..2026-10-01");
    await page.getByRole("combobox", { name: "Metric", exact: true }).selectOption("sharpe after fees");
    await page.getByLabel("Parameter 1 name").fill("z_entry");
    await page.getByLabel("Parameter 1 min").fill("1.5");
    await page.getByLabel("Parameter 1 max").fill("4");
    await page.getByLabel("Parameter 1 step").fill("0.5");
    await page.getByRole("button", { name: "+ Parameter" }).click();
    await page.getByLabel("Parameter 2 name").fill("side");
    await page.getByLabel("Parameter 2 kind").selectOption("choices");
    await page.getByLabel("Parameter 2 choices").fill("long, short");
    await page.getByRole("combobox", { name: "It must beat", exact: true }).selectOption("trend-200d-5pct");
    // §3–4: the evidence path is declared here, before the search (fks 028).
    await expect(page.getByRole("radio", { name: /^Trades:/ })).toBeChecked();
    await page.getByRole("radio", { name: /^Low-frequency:/ }).check();
    await page.getByRole("button", { name: "Register, frozen from now" }).click();

    await expect(page).toHaveURL(/\/edges\?hypothesis=7$/);
    expect(body).toEqual({
      idea: "Funding spikes on SOLUSDT mean-revert within a day; fade the extreme.",
      symbols: ["SOLUSDT", "ETHUSDT"],
      dataset: "raw/binance/usdm/btc 1h 2026-01-01..2026-10-01",
      holdout_share: 0.25,
      params: [
        { name: "z_entry", min: 1.5, max: 4, step: 0.5 },
        { name: "side", choices: ["long", "short"] },
      ],
      baseline: "trend-200d-5pct",
      metric: "sharpe after fees",
      costs: { maker_bps: 40, taker_bps: 80, slippage_bps: 5 },
      evidence: "low-frequency",
    });
  });

  test("an edited cost is sent as a number (a number input hands back a number)", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    let body: Record<string, unknown> | null = null;
    await page.route(
      (url) => url.pathname === "/api/spawner/edges/liq-fade/hypotheses",
      async (route: Route) => {
        body = route.request().postDataJSON();
        await route.fulfill({ status: 201, json: { ok: true, hypothesis: { ...LADDER.hypotheses[0], id: 9 } } });
      },
    );
    await page.goto("/edges/new");
    await expect(page.getByRole("combobox", { name: "Edge", exact: true })).toHaveValue("liq-fade");
    await page.getByLabel("One sentence, with the mechanism").fill("Funding spikes on SOLUSDT mean-revert within a day.");
    await page.getByLabel("Symbols").fill("solusdt");
    await page.getByLabel("From").fill("2026-01-01");
    await page.getByLabel("To", { exact: true }).fill("2026-10-01");
    await page.getByLabel("Parameter 1 name").fill("z_entry");
    await page.getByLabel("Parameter 1 min").fill("1.5");
    await page.getByLabel("Parameter 1 max").fill("4");
    await page.getByLabel("Parameter 1 step").fill("0.5");
    await page.getByLabel("Taker bps").fill("60");
    await page.getByRole("button", { name: "Register, frozen from now" }).click();
    await expect(page).toHaveURL(/\/edges\?hypothesis=9$/);
    expect(body).toMatchObject({ costs: { maker_bps: 40, taker_bps: 60, slippage_bps: 5 } });
  });

  test("a CME futures hypothesis: 1m bars, per-contract costs, the session-hold baseline", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    let body: Record<string, unknown> | null = null;
    await page.route(
      (url) => url.pathname === "/api/spawner/edges/liq-fade/hypotheses",
      async (route: Route) => {
        body = route.request().postDataJSON();
        await route.fulfill({ status: 201, json: { ok: true, hypothesis: { ...LADDER.hypotheses[0], id: 8 } } });
      },
    );
    await page.goto("/edges/new");
    await expect(page.getByRole("combobox", { name: "Edge", exact: true })).toHaveValue("liq-fade");
    await page
      .getByLabel("One sentence, with the mechanism")
      .fill("Opening-range breakouts on index and gold futures carry on through the session.");
    await page.getByLabel("Symbols").fill("mes, mnq, mgc");
    await page
      .getByRole("combobox", { name: "Lake folder", exact: true })
      .selectOption("raw/cme/massive-cache+raw/cme/massive/cme");
    await expect(page.getByRole("combobox", { name: "Bars", exact: true })).toHaveValue("1m");
    await expect(page.getByLabel("From")).toHaveValue("2024-09-09");
    await page.getByLabel("To", { exact: true }).fill("2027-05-31");
    await expect(page.getByTestId("dataset-text")).toContainText(
      "raw/cme/massive-cache+raw/cme/massive/cme 1m 2024-09-09..2027-05-31",
    );
    // Futures: the intraday baseline, and costs per contract instead of bps.
    await expect(page.getByRole("combobox", { name: "It must beat", exact: true })).toHaveValue("session-hold");
    await expect(page.getByTestId("futures-costs")).toBeVisible();
    await expect(page.getByLabel("Taker bps")).toHaveCount(0);
    await page.getByLabel("Commission $ / contract, round turn").fill("1.5");
    await page.getByLabel("Slippage ticks / side").fill("1");
    await page.getByRole("combobox", { name: "Metric", exact: true }).selectOption("sharpe after fees");
    await page.getByLabel("Parameter 1 name").fill("orb_minutes");
    await page.getByLabel("Parameter 1 kind").selectOption("choices");
    await page.getByLabel("Parameter 1 choices").fill("5, 10, 15, 30, 60");
    await page.getByRole("button", { name: "+ Parameter" }).click();
    await page.getByLabel("Parameter 2 name").fill("target_r");
    await page.getByLabel("Parameter 2 min").fill("1");
    await page.getByLabel("Parameter 2 max").fill("3");
    await page.getByLabel("Parameter 2 step").fill("0.5");
    await page.getByRole("button", { name: "+ Parameter" }).click();
    await page.getByLabel("Parameter 3 name").fill("exit");
    await page.getByLabel("Parameter 3 kind").selectOption("choices");
    await page.getByLabel("Parameter 3 choices").fill("target, trail");
    await page.getByRole("button", { name: "Register, frozen from now" }).click();

    await expect(page).toHaveURL(/\/edges\?hypothesis=8$/);
    expect(body).toEqual({
      idea: "Opening-range breakouts on index and gold futures carry on through the session.",
      symbols: ["MES", "MNQ", "MGC"],
      dataset: "raw/cme/massive-cache+raw/cme/massive/cme 1m 2024-09-09..2027-05-31",
      holdout_share: 0.25,
      params: [
        { name: "orb_minutes", choices: [5, 10, 15, 30, 60] },
        { name: "target_r", min: 1, max: 3, step: 0.5 },
        { name: "exit", choices: ["target", "trail"] },
      ],
      baseline: "session-hold",
      metric: "sharpe after fees",
      costs: { maker_bps: 0, taker_bps: 0, slippage_bps: 0, commission_usd_rt: 1.5, slippage_ticks: 1 },
      evidence: "trades",
    });
  });

  test("the spawner's refusal is shown line by line", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    await page.route(
      (url) => url.pathname === "/api/spawner/edges/liq-fade/hypotheses",
      (route: Route) =>
        route.fulfill({ status: 400, json: { ok: false, errors: ["params: 13 is more than 12; keep them few (EDGE_PROCESS §2.3)"] } }),
    );
    await page.goto("/edges/new");
    await expect(page.getByRole("combobox", { name: "Edge", exact: true })).toHaveValue("liq-fade");
    await page
      .getByLabel("One sentence, with the mechanism")
      .fill("Funding spikes on SOLUSDT mean-revert within a day; fade the extreme.");
    await page.getByLabel("Symbols").fill("SOLUSDT");
    await page.getByLabel("From").fill("2026-01-01");
    await page.getByLabel("Parameter 1 name").fill("z_entry");
    await page.getByLabel("Parameter 1 min").fill("1");
    await page.getByLabel("Parameter 1 max").fill("4");
    await page.getByRole("button", { name: "Register, frozen from now" }).click();
    await expect(page.getByRole("list", { name: "The spawner refused it" })).toContainText("keep them few");
    await expect(page).toHaveURL(/\/edges\/new/);
  });
});

test.describe("Edges: searching a hypothesis", () => {
  test("Search it opens the search job's form with the hypothesis filled in", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    await page.route(
      (url) => url.pathname === "/api/spawner/templates",
      (route: Route) => route.fulfill({ json: { templates: [JOB_TEMPLATE], errors: [] } }),
    );
    await page.goto("/edges");
    const card = page.locator('[data-testid="hypothesis-card"][data-hypothesis="3"]');
    await expect(card.getByTestId("search-it")).toHaveAttribute(
      "href",
      "/tasks/new?kind=job&template=job.edge-search&hypothesis_id=3",
    );
    await page.goto("/tasks/new?kind=job&template=job.edge-search&hypothesis_id=3");
    await expect(page.locator(".panel-title", { hasText: "Search and validate a hypothesis" })).toBeVisible();
    await expect(page.getByLabel("Hypothesis")).toHaveValue("3");
    await expect(page.getByLabel("Name")).toHaveValue("edge-search-h3");
  });
});

test.describe("Home: the ladder's counts", () => {
  test("Home counts the rungs the way /edges places them", async ({ page }) => {
    await installHome(page);
    await installLadder(page);
    await page.goto("/");
    const ladder = page.getByRole("list", { name: "Edges by stage" });
    await expect(ladder.locator("li").filter({ hasText: "Hypotheses" })).toContainText("1");
    await expect(ladder.locator("li").filter({ hasText: "Searched" })).toContainText("2");
    await expect(ladder.locator("li").filter({ hasText: "Forward (paper)" })).toContainText("2");
    await expect(ladder.locator("li").filter({ hasText: "Retired" })).toContainText("1");
  });
});
