import { test, expect, type Page } from "@playwright/test";

// Playwright tests run in Node.js — process is available at runtime.
declare const process: { env: Record<string, string | undefined> };

/**
 * Select an InnerTabs tab and prove it took.
 *
 * WHY THE CLICK IS RE-SENT — measured, not assumed. InnerTabs is a plain
 * `<button onclick>`; SSR paints it fully visible and enabled, but the click
 * handler only exists after HYDRATION, and `waitForLoadState("load")` is not
 * that moment (on this dev server `load` fires ~95ms in, component effects run
 * ~215ms in). A click landing in that window hits real, visible, hit-testable
 * DOM and does NOTHING — `aria-selected` stays "false" for the rest of the
 * test. Instrumented on /janus-ai and /db: the FIRST click changed no state, a
 * second click 1.5s later selected the tab and rendered its panels every time.
 *
 * The assertion is unchanged: the tab must end up selected. Verified by stub —
 * with InnerTabs' `onclick` replaced by a no-op, all three tests that use this
 * helper fail, retries and all.
 *
 * What retrying DOES hide, and what therefore has to be caught elsewhere: /db
 * was throwing during render on every load (see the crash fixed in
 * src/routes/db/+page.svelte), and with that bug still in place these tab tests
 * pass through this helper — a later click gets through. That is why the "loads
 * without critical JS errors" test below was strengthened rather than left to
 * these; a swallowed first click is not evidence of a healthy page.
 */
async function selectInnerTab(page: Page, label: string) {
  const tab = page
    .locator('[role="tablist"]')
    .locator('[role="tab"]', { hasText: label });
  await expect(tab).toBeVisible();

  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", {
      timeout: 1_000,
    });
  }).toPass({ timeout: 10_000, intervals: [200] });
}

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
// 1. Page Titles — every route must have the correct <title>
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_TITLES: { path: string; title: RegExp }[] = [
  { path: "/", title: /Overview.*FKS Terminal/ },
  { path: "/charts", title: /Charts.*FKS Terminal/ },
  { path: "/trading", title: /Trading.*FKS Terminal/ },
  { path: "/signals", title: /Signals.*FKS Terminal/ },
  { path: "/performance", title: /Performance.*FKS Terminal/ },
  { path: "/janus-ai", title: /Janus AI.*FKS Terminal/ },
  { path: "/docs", title: /Docs.*FKS Terminal/ },
  { path: "/bots", title: /Bots.*FKS Terminal/ },
  { path: "/journal", title: /Journal.*FKS Terminal/ },
  { path: "/monitoring", title: /Monitoring.*FKS Terminal/ },
  { path: "/db", title: /DB Explorer.*FKS Terminal/ },
  { path: "/settings", title: /Settings.*FKS Terminal/ },
  // Q2: the three auth-gate routes used to read "FKS Terminal — X"; they now
  // lead with the page name like every other route, so a truncated browser tab
  // or history entry shows WHICH page it is rather than the app name twelve
  // times over.
  { path: "/login", title: /Login.*FKS Terminal/ },
];

test.describe("Page Titles", () => {
  for (const route of PAGE_TITLES) {
    test(`${route.path} has correct <title>`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("load");
      await expect(page).toHaveTitle(route.title);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Janus AI workspace (/janus-ai)
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Janus AI workspace (/janus-ai)", () => {
  test("loads without critical JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/janus-ai");
    await page.waitForLoadState("load");

    expect(errors.filter(isCritical)).toHaveLength(0);
  });

  test("page header and h1 title are visible", async ({ page }) => {
    await page.goto("/janus-ai");
    await page.waitForLoadState("load");

    await expect(page.locator(".page-header")).toBeVisible();
    await expect(page.locator("h1.page-title")).toContainText("Janus AI");
  });

  test("'+ New Session' button is always rendered in the header", async ({
    page,
  }) => {
    await page.goto("/janus-ai");
    await page.waitForLoadState("load");

    await expect(
      page.locator("button.btn-accent", { hasText: /New Session/ }),
    ).toBeVisible();
  });

  // Panel component renders titles as .panel-title (previously .panel-lbl)
  test("Janus State panel title is visible in the left pane", async ({
    page,
  }) => {
    await page.goto("/janus-ai");
    await page.waitForLoadState("load");

    const leftPane = page.locator(".pane-left");
    await expect(leftPane).toBeVisible();

    await expect(
      leftPane.locator(".panel-title", { hasText: "Janus State" }),
    ).toBeVisible();
  });

  test("Strategy Affinity panel title is visible in the left pane", async ({
    page,
  }) => {
    await page.goto("/janus-ai");
    await page.waitForLoadState("load");

    const leftPane = page.locator(".pane-left");
    await expect(
      leftPane.locator(".panel-title", { hasText: "Strategy Affinity" }),
    ).toBeVisible();
  });

  test("right pane has Sessions / Live Signals / Memories tab bar", async ({
    page,
  }) => {
    await page.goto("/janus-ai");
    await page.waitForLoadState("load");

    // InnerTabs renders role="tablist" with one button[role="tab"] per tab
    const tablist = page.locator('[role="tablist"]');
    await expect(tablist).toBeVisible();

    await expect(
      tablist.locator('[role="tab"]', { hasText: "Sessions" }),
    ).toBeVisible();
    await expect(
      tablist.locator('[role="tab"]', { hasText: "Live Signals" }),
    ).toBeVisible();
    await expect(
      tablist.locator('[role="tab"]', { hasText: "Memories" }),
    ).toBeVisible();
  });

  test("Sessions tab is active by default", async ({ page }) => {
    await page.goto("/janus-ai");
    await page.waitForLoadState("load");

    const sessionsTab = page
      .locator('[role="tablist"]')
      .locator('[role="tab"]', { hasText: "Sessions" });

    await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
  });

  test("sessions tab body shows content (list, empty-state, skeleton, or error)", async ({
    page,
  }) => {
    await page.goto("/janus-ai");
    await page.waitForLoadState("load");

    const rightPane = page.locator(".pane-right");
    await expect(rightPane).toBeVisible();

    // After the Panel migration, tab content lives inside the Panel's .panel-body.
    // The right pane has exactly one Panel whose body holds the tab content.
    const panelBody = rightPane.locator(".panel-body").first();
    await expect(panelBody).toBeVisible();

    // Give the initial API call a moment to settle
    await page.waitForTimeout(400);

    const sessionsListCount = await rightPane.locator(".sessions-list").count();
    const emptyStateCount = await rightPane.locator(".empty-state").count();
    const errorMsgCount = await rightPane.locator(".error-msg").count();
    const skeletonCount = await rightPane
      .locator('[role="status"][aria-label="Loading"]')
      .count();

    const anyPresent =
      sessionsListCount > 0 ||
      emptyStateCount > 0 ||
      errorMsgCount > 0 ||
      skeletonCount > 0;

    expect(anyPresent).toBe(true);
  });

  test("clicking Live Signals tab switches active tab", async ({ page }) => {
    await page.goto("/janus-ai");
    await page.waitForLoadState("load");

    await selectInnerTab(page, "Live Signals");

    // The tab bar is single-select: the previously active tab must give it up.
    const sessionsTab = page
      .locator('[role="tablist"]')
      .locator('[role="tab"]', { hasText: "Sessions" });
    await expect(sessionsTab).toHaveAttribute("aria-selected", "false");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. EmbedPage routes — Docs
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
// 4. DB Explorer (/db) — tabs, lazy loading, Janus tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe("DB Explorer (/db)", () => {
  test("loads without critical JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/db");
    await page.waitForLoadState("load");

    // `load` is TOO EARLY to see the error this test exists to catch. The three
    // Redis panels fetch on mount and the crash happened while RENDERING the
    // response (~200ms after `load`), so this assertion ran against a page that
    // looked clean and had already died — it passed for the whole time /db was
    // uninteractive. Wait until no panel is still loading: that is the render
    // that used to throw.
    await expect(
      page.locator('[role="status"][aria-label="Loading"]'),
    ).toHaveCount(0);

    expect(errors.filter(isCritical)).toHaveLength(0);
  });

  test("has 4 database tabs: Redis, Postgres, QuestDB, Janus", async ({
    page,
  }) => {
    await page.goto("/db");
    await page.waitForLoadState("load");

    const tablist = page.locator('[role="tablist"]');
    await expect(tablist).toBeVisible();

    await expect(
      tablist.locator('[role="tab"]', { hasText: "Redis" }),
    ).toBeVisible();
    await expect(
      tablist.locator('[role="tab"]', { hasText: "Postgres" }),
    ).toBeVisible();
    await expect(
      tablist.locator('[role="tab"]', { hasText: "QuestDB" }),
    ).toBeVisible();
    await expect(
      tablist.locator('[role="tab"]', { hasText: "Janus" }),
    ).toBeVisible();
  });

  test("Redis tab is active by default", async ({ page }) => {
    await page.goto("/db");
    await page.waitForLoadState("load");

    const redisTab = page
      .locator('[role="tablist"]')
      .locator('[role="tab"]', { hasText: "Redis" });
    await expect(redisTab).toHaveAttribute("aria-selected", "true");
  });

  test("Redis panel titles are visible on initial load", async ({ page }) => {
    await page.goto("/db");
    await page.waitForLoadState("load");

    // Panel component renders .panel-title for each panel header
    await expect(
      page.locator(".panel-title", { hasText: "Redis Info" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Key Browser" }),
    ).toBeVisible();
  });

  test("switching to Postgres tab shows Tables and Query Runner panels", async ({
    page,
  }) => {
    await page.goto("/db");
    await page.waitForLoadState("load");

    await selectInnerTab(page, "Postgres");

    await expect(
      page.locator(".panel-title", { hasText: "Tables" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Query Runner" }),
    ).toBeVisible();

    // Postgres tab should now be selected
    await expect(
      page.locator('[role="tab"]', { hasText: "Postgres" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("switching to QuestDB tab shows Tables and Query Runner panels", async ({
    page,
  }) => {
    await page.goto("/db");
    await page.waitForLoadState("load");

    await selectInnerTab(page, "QuestDB");

    await expect(
      page.locator(".panel-title", { hasText: "Tables" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Query Runner" }),
    ).toBeVisible();
  });

  test("clicking Janus tab shows Brain Health and Services panels", async ({
    page,
  }) => {
    await page.goto("/db");
    await page.waitForLoadState("load");

    await selectInnerTab(page, "Janus");

    await expect(
      page.locator(".panel-title", { hasText: "Brain Health" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Services" }),
    ).toBeVisible();
  });

  test("Janus tab: Brain Health panel shows loading or content", async ({
    page,
  }) => {
    await page.goto("/db");
    await page.waitForLoadState("load");

    await selectInnerTab(page, "Janus");

    // Wait for data load attempt
    await page.waitForTimeout(400);

    // Must show one of: skeleton, error, or content
    const skeletonCount = await page
      .locator('[role="status"][aria-label="Loading"]')
      .count();
    const errorCount = await page.locator(".error-text").count();
    const contentCount = await page.locator(".stat-grid").count();

    expect(skeletonCount + errorCount + contentCount).toBeGreaterThan(0);
  });

  test("Redis tab scan button is present", async ({ page }) => {
    await page.goto("/db");
    await page.waitForLoadState("load");

    // Scan button in the Key Browser panel
    await expect(page.locator("button", { hasText: "Scan" })).toBeVisible();
  });

  test("Postgres query runner has a textarea and Run button", async ({
    page,
  }) => {
    await page.goto("/db");
    await page.waitForLoadState("load");

    await selectInnerTab(page, "Postgres");

    await expect(page.locator("textarea.query-input").first()).toBeVisible();
    await expect(
      page.locator("button", { hasText: /Run/ }).first(),
    ).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Panel component — cross-workspace verification
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Panel component rendering", () => {
  test("Overview page renders panels with .panel-title headings", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("load");

    // Panel component always renders .panel-title when title prop is provided
    await expect(
      page.locator(".panel-title", { hasText: "Market Overview" }),
    ).toBeVisible();
    // M3D (D1) replaced the dead "AI Brief" panel with the "Money" snapshot;
    // (D4) retitled "Active Trades" → "Active Trades (janus paper)".
    await expect(
      page.locator(".panel-title", { hasText: "Money" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Active Trades (janus paper)" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Data Factory" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Recent Signals" }),
    ).toBeVisible();
  });

  test("Overview page: poll badges are rendered for time-bound panels", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("load");

    // Panel renders .poll-badge when badge prop is provided
    const pollBadges = page.locator(".poll-badge");
    expect(await pollBadges.count()).toBeGreaterThan(0);
  });

  test("Settings page renders all section panel titles", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("load");

    // The Ruby/futures-era panels (Data Sources, Rithmic, Analysis
    // Preferences) were removed in the G4 cleanup — only the wired panels
    // remain.
    await expect(
      page.locator(".panel-title", { hasText: "API Connections" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Risk Controls" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "System Info" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Observability" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Janus Optimizer" }),
    ).toBeVisible();
  });

  test("Monitoring page renders panel titles", async ({ page }) => {
    await page.goto("/monitoring");
    await page.waitForLoadState("load");

    await expect(
      page.locator(".panel-title", { hasText: "System Health" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "PromQL Runner" }),
    ).toBeVisible();
  });

  test("Trading page renders chart and order panel titles", async ({
    page,
  }) => {
    await page.goto("/trading");
    await page.waitForLoadState("load");

    await expect(
      page.locator(".panel-title", { hasText: "Chart" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Order Entry" }),
    ).toBeVisible();
    await expect(
      page.locator(".panel-title", { hasText: "Live Signals" }),
    ).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Login flow
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

  test("unauthenticated visit to /janus-ai redirects to /login when auth is active", async ({
    page,
  }) => {
    test.skip(
      !authEnabled,
      "WEBUI_SESSION_SECRET is not set — auth guard is disabled in dev mode",
    );

    await page.goto("/janus-ai");
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

    await page.goto("/janus-ai");
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

// ─────────────────────────────────────────────────────────────────────────────
// An unreachable janus must NOT be reported as an UNHEALTHY janus.
//
// gracefulEmpty answers an unmapped/unreachable read with 200 {}, which is
// TRUTHY. The Brain Health panel accepted it, read healthy === undefined as
// falsy, and painted a RED "Unhealthy" badge on the trading brain — a definite
// alarming verdict manufactured from no data — then threw on
// Object.keys(components). During a measurement window an operator could act on
// that badge.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("/db Brain Health: absent data is not a verdict", () => {
  test("an empty payload reports UNAVAILABLE, never Unhealthy, and does not throw", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // Exactly what gracefulEmpty serves for an unreachable janus.
    await page.route("**/api/janus/brain/health", (route) => route.fulfill({ json: {} }));

    await page.goto("/db");
    await page.waitForLoadState("load");
    await selectInnerTab(page, "Janus");

    const panel = page.locator(".panel", {
      has: page.locator(".panel-title", { hasText: /Brain Health/i }),
    });
    await expect(panel).toBeVisible();

    // The load-bearing assertion: no fabricated VERDICT. Scoped to the badge —
    // the honest error copy legitimately contains the word "unhealthy" while
    // explaining that it is NOT the verdict, so a whole-panel text match would
    // fail on the fix itself.
    await expect(panel.locator(".badge")).toHaveCount(0);
    await expect(panel).toContainText(/unavailable/i);

    // And the render must survive — the crash is what froze the panel before.
    expect(errors.filter((e) => /reading '?(length|components)'?/.test(e)), errors.join(" | ")).toHaveLength(0);
  });
});
