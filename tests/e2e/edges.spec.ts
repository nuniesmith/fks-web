import { test, expect, type Route } from "@playwright/test";
import { installHome } from "./fixtures/home";
import { installLadder, LADDER } from "./fixtures/ladder";

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
    await expect(fix).toContainText("Name at least one symbol");
    await expect(fix).toContainText("a name is lower-case letters");
    expect(posted).toBe(false);
  });

  test("sends the five parts of §2, then shows it on the board", async ({ page }) => {
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
    await page.getByLabel(/Dataset/).fill("raw/binance/usdm/sol 2026-10-27..2027-01-27");
    await page.getByLabel("Parameter 1 name").fill("z_entry");
    await page.getByLabel("Parameter 1 min").fill("1.5");
    await page.getByLabel("Parameter 1 max").fill("4");
    await page.getByLabel("Parameter 1 step").fill("0.5");
    await page.getByRole("button", { name: "+ Parameter" }).click();
    await page.getByLabel("Parameter 2 name").fill("side");
    await page.getByLabel("Parameter 2 kind").selectOption("choices");
    await page.getByLabel("Parameter 2 choices").fill("long, short");
    await page.getByRole("combobox", { name: "It must beat", exact: true }).selectOption("trend-200d-5pct");
    await page.getByRole("button", { name: "Register, frozen from now" }).click();

    await expect(page).toHaveURL(/\/edges\?hypothesis=7$/);
    expect(body).toEqual({
      idea: "Funding spikes on SOLUSDT mean-revert within a day; fade the extreme.",
      symbols: ["SOLUSDT", "ETHUSDT"],
      dataset: "raw/binance/usdm/sol 2026-10-27..2027-01-27",
      holdout_share: 0.25,
      params: [
        { name: "z_entry", min: 1.5, max: 4, step: 0.5 },
        { name: "side", choices: ["long", "short"] },
      ],
      baseline: "trend-200d-5pct",
      metric: "net return after fees",
      costs: { maker_bps: 40, taker_bps: 80, slippage_bps: 5 },
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
    await page.getByLabel(/Dataset/).fill("raw/binance/usdm/sol");
    await page.getByLabel("Parameter 1 name").fill("z_entry");
    await page.getByLabel("Parameter 1 min").fill("1");
    await page.getByLabel("Parameter 1 max").fill("4");
    await page.getByRole("button", { name: "Register, frozen from now" }).click();
    await expect(page.getByRole("list", { name: "The spawner refused it" })).toContainText("keep them few");
    await expect(page).toHaveURL(/\/edges\/new/);
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
