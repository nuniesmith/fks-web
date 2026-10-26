import { test, expect } from "@playwright/test";
import { installHome } from "./fixtures/home";
import { installRecorder } from "./fixtures/data";

// Playwright tests run in Node.js — process is available at runtime.
declare const process: { env: Record<string, string | undefined> };

/**
 * The pages of the six-section layout (2026-10-26): Home, Data, Tasks (with
 * the New-task form), Money, plus Docs, Settings, Monitoring and the login
 * gate. Hermetic: every backend read a page makes is route-mocked by
 * fixtures/home.ts and fixtures/data.ts, so these run with no spawner, no
 * QuestDB and no janus. (This file replaced workspaces.spec.ts, whose janus-ai,
 * DB explorer, Trading and Overview tests went with those pages.)
 */

// ─── Shared error filter ──────────────────────────────────────────────────────

const IGNORED_ERROR_PATTERNS = [
  "fetch",
  "Failed to fetch",
  "NetworkError",
  "effect_update_depth_exceeded",
];

function isCritical(msg: string): boolean {
  return !IGNORED_ERROR_PATTERNS.some((pat) => msg.includes(pat));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. EmbedPage routes — Docs
// (DOM / Paper / Positions were de-navved Ruby routes, removed in Phase A1.)
// ─────────────────────────────────────────────────────────────────────────────

const EMBED_ROUTES = [
  {
    path: "/docs",
    name: "Docs",
    docTitle: /Docs.*FKS Terminal/i,
    iframeTitle: "FKS Documentation",
  },
] as const;

for (const route of EMBED_ROUTES) {
  test.describe(`${route.name} embed page (${route.path})`, () => {
    test("loads without critical JS errors", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(route.path);
      await page.waitForLoadState("load");

      expect(errors.filter(isCritical)).toHaveLength(0);
    });

    test(".embed-pane wrapper is visible", async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("load");

      await expect(page.locator(".embed-pane")).toBeVisible();
    });

    test("iframe element is attached to the DOM", async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("load");

      await expect(page.locator("iframe")).toBeAttached();
    });

    test("iframe has correct accessible title attribute", async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("load");

      await expect(page.locator("iframe")).toHaveAttribute(
        "title",
        route.iframeTitle,
      );
    });

    test("document <title> contains expected text", async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("load");

      await expect(page).toHaveTitle(route.docTitle);
    });

    test('"Pop Out" link is visible and targets a new tab', async ({
      page,
    }) => {
      await page.goto(route.path);
      await page.waitForLoadState("load");

      const popOut = page.locator("a.pop-out");
      await expect(popOut).toBeVisible();
      await expect(popOut).toContainText("Pop Out");
      await expect(popOut).toHaveAttribute("target", "_blank");
      await expect(popOut).toHaveAttribute("rel", "noopener noreferrer");
    });

    test("iframe has loading=lazy attribute", async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("load");

      await expect(page.locator("iframe")).toHaveAttribute("loading", "lazy");
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Home — driven by the accounts you have set up
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Home", () => {
  test("shows each configured account with the bot that trades it", async ({ page }) => {
    await installHome(page);
    await page.goto("/");

    for (const title of ["Accounts", "Running", "Data capture", "Edges", "Alerts about money"]) {
      await expect(page.locator(".panel-title", { hasText: title })).toBeVisible();
    }
    const card = page.getByTestId("account-card");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-account", "kraken:spot:default");
    await expect(card.getByText("Kraken · spot")).toBeVisible();
    await expect(card.getByText("LIVE")).toBeVisible();
    await expect(card.getByText("$321.20")).toBeVisible();
    await expect(card.getByText("6 holdings", { exact: false })).toBeVisible();
    await expect(card.getByText("lease held by crypto-regime", { exact: false })).toBeVisible();
  });

  test("lists what is running and what is being recorded", async ({ page }) => {
    await installHome(page);
    await page.goto("/");
    const running = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Running" }) });
    await expect(running.getByText("crypto-regime")).toBeVisible();
    await expect(running.getByText("btc", { exact: true })).toBeVisible();
    const capture = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Data capture" }) });
    await expect(capture.getByText("recording")).toBeVisible();
    await expect(capture.getByText("2 coins", { exact: false })).toBeVisible();
  });

  test("with no keys stored, points to Settings instead of inventing an account", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/spawner/secrets/status",
      (r) => r.fulfill({ json: { db_enabled: true, exchanges: [], total: 0 } }),
    );
    await page.route(
      (url) => url.pathname === "/api/spawner/configs",
      (r) => r.fulfill({ json: { db_enabled: true, configs: [], total: 0 } }),
    );
    await page.goto("/");
    await expect(page.getByText("No accounts set up")).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a key" })).toHaveAttribute("href", "/settings");
    await expect(page.getByTestId("account-card")).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Data — recorders and their coverage, janus market data
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Data", () => {
  test("a recorder shows its streams, connections and a 30-day coverage calendar", async ({ page }) => {
    await installHome(page);
    await installRecorder(page);
    await page.goto("/data");

    const card = page.getByTestId("recorder-card");
    await expect(card).toHaveAttribute("data-instance", "btc");
    await expect(card.getByRole("cell", { name: "bookTicker" })).toBeVisible();
    await expect(card.getByText("public connected", { exact: false })).toBeVisible();
    // 30 day cells; the last three days have files, today is open.
    await expect(card.locator(".cal .cell")).toHaveCount(30);
    await expect(card.locator(".cal .cell.open")).toHaveCount(1);
    await expect(card.locator(".cal .cell.complete")).toHaveCount(2);
    await expect(card.getByText("3 days", { exact: false })).toBeVisible();
    await expect(card.getByRole("button", { name: "Stop" })).toBeVisible();
  });

  test("janus candles are listed per coin with completeness", async ({ page }) => {
    await installHome(page);
    await page.goto("/data");
    const table = page.getByRole("table", { name: "Candles janus has recorded" });
    await expect(table.getByRole("link", { name: "BTCUSDT" })).toBeVisible();
    await expect(table.getByText("49,805").first()).toBeVisible();
  });

  test("New recorder opens the recorder form", async ({ page }) => {
    await installHome(page);
    await page.goto("/data");
    await page.getByRole("link", { name: "+ New recorder" }).click();
    await expect(page).toHaveURL(/\/tasks\/new\?kind=recorder/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tasks and the New-task form
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Tasks", () => {
  test("lists the live bot and the recorder once each, live stop behind a confirm", async ({ page }) => {
    await installHome(page);
    await page.goto("/tasks");
    const rows = page.getByTestId("task-row");
    await expect(rows).toHaveCount(2);
    const bot = rows.filter({ hasText: "crypto-regime" });
    await expect(bot.getByText("kraken:spot:default")).toBeVisible();
    // A live bot's Stop is a two-step ConfirmButton: the first click only arms
    // it (the button's text asks; its accessible name stays the aria-label).
    const stop = bot.getByRole("button", { name: /Stop the live bot/ });
    await expect(async () => {
      await stop.click();
      await expect(stop).toHaveText(/Stop LIVE bot\?/, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await expect(rows.filter({ hasText: "recorder" }).getByRole("button", { name: /Delete btc/ })).toBeVisible();
  });
});

test.describe("New task form", () => {
  test("check, then create: the form is the template's, and Create waits for a passing check", async ({ page }) => {
    await installRecorder(page);
    let created: unknown = null;
    await page.route(
      (url) => url.pathname === "/api/spawner/instances/validate",
      async (r) => {
        const req = r.request().postDataJSON();
        await r.fulfill({
          json: {
            ok: true,
            plan: {
              name: req.name,
              template_id: req.template,
              template_version: 1,
              kind: "recorder",
              image: "ghcr.io/nuniesmith/fks-bot-recorder:latest",
              mode: "record",
              env: { RECORDER_SYMBOLS: (req.params.symbols as string[]).join(","), RECORDER_VENUE: "binance-usdm" },
              params: req.params,
              cpu_limit: 2,
              memory_mb: 512,
              data_dir: `/srv/fks-lake/raw/binance/usdm/${req.name}`,
            },
          },
        });
      },
    );
    await page.route(
      (url) => url.pathname === "/api/spawner/instances",
      async (r) => {
        if (r.request().method() !== "POST") return r.fallback();
        created = r.request().postDataJSON();
        await r.fulfill({ json: { ok: true, name: "eth-sol", container_id: "abc" } });
      },
    );

    await page.goto("/tasks/new?kind=recorder");
    // One recorder template: it opens straight away.
    await expect(page.locator(".panel-title", { hasText: "Binance USDⓈ-M futures recorder" })).toBeVisible();
    await page.getByLabel("Symbols *").fill("ethusdt, solusdt");
    await expect(page.getByLabel("Name")).toHaveValue("eth-sol");
    await expect(page.getByText("About", { exact: false }).first()).toContainText("MB");

    const createBtn = page.getByRole("button", { name: "Start recording" });
    await expect(createBtn).toBeDisabled();
    await page.getByRole("button", { name: "Check" }).click();
    await expect(page.getByTestId("instance-plan")).toContainText("/srv/fks-lake/raw/binance/usdm/eth-sol");
    await expect(createBtn).toBeEnabled();

    // Changing the form after a check makes the check stale again.
    await page.getByLabel("Seconds between REST snapshots").fill("600");
    await expect(createBtn).toBeDisabled();
    await page.getByRole("button", { name: "Check" }).click();
    await expect(createBtn).toBeEnabled();

    await createBtn.click();
    await expect(page).toHaveURL(/\/data$/);
    expect(created).toMatchObject({
      template: "recorder.binance-usdm",
      name: "eth-sol",
      mode: "record",
      params: { symbols: ["ETHUSDT", "SOLUSDT"], rest_seconds: 600 },
    });
  });

  test("the spawner's refusal is shown line by line, and nothing is created", async ({ page }) => {
    await installRecorder(page);
    await page.route(
      (url) => url.pathname === "/api/spawner/instances/validate",
      (r) =>
        r.fulfill({
          status: 400,
          json: { ok: false, errors: ["symbols: XYZ is not a Binance USDⓈ-M perpetual"] },
        }),
    );
    await page.goto("/tasks/new?template=recorder.binance-usdm");
    await page.getByLabel("Symbols *").fill("XYZ");
    await page.getByRole("button", { name: "Check" }).click();
    await expect(page.getByRole("alert")).toContainText("XYZ is not a Binance");
    await expect(page.getByRole("button", { name: "Start recording" })).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Money — holdings per account on top of the treasury
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Money", () => {
  test("each exchange account lists its holdings", async ({ page }) => {
    await installHome(page);
    await page.goto("/money");
    const holdings = page.getByRole("table", { name: "Holdings on Kraken · spot" });
    await expect(holdings.locator("tbody tr")).toHaveCount(6);
    await expect(holdings.getByRole("cell", { name: "BTC", exact: true })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Settings and Monitoring panels
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Panel component rendering", () => {
  test("Settings renders its panels, and the futures/janus ones are gone", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("load");
    for (const title of ["API Connections", "Notifications", "System Info", "Observability"]) {
      await expect(page.locator(".panel-title", { hasText: title })).toBeVisible();
    }
    for (const gone of ["Risk Controls", "Janus Optimizer", "Rithmic Accounts"]) {
      await expect(page.locator(".panel-title", { hasText: gone })).toHaveCount(0);
    }
  });

  test("Monitoring page renders panel titles", async ({ page }) => {
    await page.goto("/monitoring");
    await page.waitForLoadState("load");

    await expect(page.locator(".panel-title", { hasText: "System Health" })).toBeVisible();
    await expect(page.locator(".panel-title", { hasText: "PromQL Runner" })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Login flow
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Login flow", () => {
  const authEnabled = !!process.env.WEBUI_SESSION_SECRET;

  test("login page renders the password form", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("load");

    await expect(page).toHaveURL(/\/login/);
    await expect(page).toHaveTitle(/FKS Terminal/);

    const passwordInput = page.locator("#password");
    await expect(passwordInput).toBeVisible();
    await expect(passwordInput).toHaveAttribute("type", "password");
    await expect(passwordInput).toHaveAttribute(
      "autocomplete",
      "current-password",
    );

    const submitBtn = page.locator('.gate button[type="submit"]');
    await expect(submitBtn).toBeVisible();
    await expect(submitBtn).toContainText(/Enter Terminal/);
    await expect(submitBtn).toBeDisabled();
  });

  test("login page heading, subtitle, and footer note are visible", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.waitForLoadState("load");

    await expect(page.locator("h1.title")).toContainText("FKS Terminal");
    await expect(page.locator("p.subtitle")).toContainText(
      /Restricted access/i,
    );
    await expect(page.locator("p.footer-note")).toBeVisible();
  });

  test("typing into the password field enables the submit button", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.waitForLoadState("load");

    const passwordInput = page.locator("#password");
    const submitBtn = page.locator('.gate button[type="submit"]');

    await expect(submitBtn).toBeDisabled();
    await passwordInput.fill("anything");
    await expect(submitBtn).toBeEnabled();
  });

  test("unauthenticated visit to / redirects to /login when auth is active", async ({
    page,
  }) => {
    test.skip(
      !authEnabled,
      "WEBUI_SESSION_SECRET is not set — auth guard is disabled in dev mode",
    );

    await page.goto("/");
    await page.waitForLoadState("load");

    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("#password")).toBeVisible();
  });

  test("unauthenticated visit to /data redirects to /login when auth is active", async ({
    page,
  }) => {
    test.skip(
      !authEnabled,
      "WEBUI_SESSION_SECRET is not set — auth guard is disabled in dev mode",
    );

    await page.goto("/data");
    await page.waitForLoadState("load");

    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("#password")).toBeVisible();
  });

  test("redirect URL preserves ?next= param pointing at the requested route", async ({
    page,
  }) => {
    test.skip(
      !authEnabled,
      "WEBUI_SESSION_SECRET is not set — auth guard is disabled in dev mode",
    );

    await page.goto("/data");
    await page.waitForLoadState("load");

    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test("dev mode: workspace routes are accessible without auth when WEBUI_SESSION_SECRET is unset", async ({
    page,
  }) => {
    test.skip(authEnabled, "Auth is active — this test is for dev mode only");

    await page.goto("/");
    await page.waitForLoadState("load");

    await expect(page).not.toHaveURL(/\/login/);
  });
});

