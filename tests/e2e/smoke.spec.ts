import { test, expect, type Page } from "@playwright/test";

/**
 * Press a nav shortcut, then assert where it landed.
 *
 * WHY THE KEYSTROKE IS RE-SENT — measured on this dev server, not assumed.
 * TabBar registers its document-level keydown listener from an `$effect`, so
 * the shortcuts only exist once the shell has HYDRATED, and
 * `waitForLoadState("load")` is NOT that moment: `load` fires at ~95ms while
 * the listener attaches at ~215ms. With the handler temporarily instrumented to
 * record every call, a press sent inside that window never reached it — the
 * recorded call list stayed empty and the URL simply stayed on "/". That is a
 * lost keystroke, not a broken shortcut: over 15 runs of the three shortcut
 * tests, 5 failed and WHICH one failed rotated at random, which is why this
 * read as several unrelated mystery failures on a pristine main.
 *
 * Waiting for a hydration marker instead does not work. SvelteKit's own
 * history stamp (`history.state["sveltekit:history"]`) lands BEFORE the
 * component effects run — gating on it still lost 8 of 24 presses — and the
 * shell paints nothing else that only exists post-hydration.
 *
 * The assertion is unchanged and unweakened: pressing this key must navigate to
 * this route, and no amount of retrying will make a mis-wired or dead shortcut
 * pass. The only thing tolerated is a keystroke aimed at a page that is still
 * hydrating, which the app never promised to honour.
 */
async function pressShortcut(page: Page, key: string, url: RegExp) {
  // Click the body first so no input holds focus — the handler deliberately
  // ignores keys typed into an INPUT/TEXTAREA/SELECT.
  await page.locator("body").click();

  await expect(async () => {
    await page.keyboard.press(key);
    await expect(page).toHaveURL(url, { timeout: 1_000 });
  }).toPass({ timeout: 10_000, intervals: [200] });
}

// Every page in the six-section nav (2026-10-26), with the <title> each should
// render. The futures co-pilot, trading, signals, janus-ai, journal, workspace,
// performance, exchanges and DB pages were removed with their backends; their
// old URLs redirect (see "Moved pages" below).
const routes = [
  { path: "/", title: "Home — FKS Terminal" },
  { path: "/data", title: "Data — FKS Terminal" },
  { path: "/edges", title: "Edges — FKS Terminal" },
  { path: "/tasks", title: "Tasks — FKS Terminal" },
  { path: "/tasks/new", title: "New task — FKS Terminal" },
  { path: "/tasks/advanced", title: "Advanced — Tasks — FKS Terminal" },
  { path: "/money", title: "Money — FKS Terminal" },
  { path: "/charts", title: "Charts — FKS Terminal" },
  { path: "/charts/grid", title: "Multi-chart — FKS Terminal" },
  { path: "/docs", title: "Docs — FKS Terminal" },
  { path: "/monitoring", title: "Monitoring — FKS Terminal" },
  { path: "/settings", title: "Settings — FKS Terminal" },
];

const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });

test.describe("Shell", () => {
  test("renders the tab bar and the status bar", async ({ page }) => {
    await page.goto("/");

    const tabbar = mainNav(page);
    await expect(tabbar).toBeVisible();
    // Home, Data, Edges, Tasks, Money + Settings, Monitoring, Docs.
    expect(await tabbar.locator("a.tab").count()).toBeGreaterThanOrEqual(8);

    await expect(page.locator('footer[role="status"]')).toBeVisible();
  });

  test("keyboard shortcut 2 navigates to data", async ({ page }) => {
    await page.goto("/");
    await expect(mainNav(page)).toBeVisible();
    await pressShortcut(page, "2", /\/data$/);
  });

  test("keyboard shortcut 5 navigates to money", async ({ page }) => {
    await page.goto("/");
    await expect(mainNav(page)).toBeVisible();
    await pressShortcut(page, "5", /\/money$/);
  });

  test("Shift+1 navigates to docs (System group shortcut)", async ({ page }) => {
    await page.goto("/");
    await expect(mainNav(page)).toBeVisible();
    await pressShortcut(page, "Shift+1", /\/docs/);
  });
});

test.describe("Page smoke tests", () => {
  for (const route of routes) {
    test(`${route.path} loads with its title + shell, no crash`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(route.path);
      await page.waitForLoadState("load");

      // Correct page rendered (a login redirect would change the title).
      await expect(page).toHaveTitle(route.title);
      // Shell chrome renders on every page.
      await expect(mainNav(page)).toBeVisible();

      // No uncaught JS errors (missing-backend network errors + Svelte effect
      // depth warnings are expected without the live stack).
      const criticalErrors = errors.filter(
        (e) =>
          !e.includes("fetch") &&
          !e.includes("Failed to fetch") &&
          !e.includes("NetworkError") &&
          !e.includes("effect_update_depth_exceeded"),
      );
      expect(criticalErrors).toHaveLength(0);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Q2 — the SSR half. `page.goto` + toHaveTitle only proves the POST-HYDRATION
// title, which was always right. The bug lived in the first painted byte:
// app.html emitted a static <title>FKS Terminal</title> BEFORE
// %sveltekit.head%, so every hard load / cold PWA launch showed the generic
// title until hydration replaced it. Assert on the raw SSR HTML — a duplicate
// <title> can only be seen there.
// ─────────────────────────────────────────────────────────────────────────────
function ssrTitles(html: string): string[] {
  return [...html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/g)].map((m) =>
    m[1].trim(),
  );
}

test.describe("SSR document title", () => {
  for (const route of routes) {
    test(`${route.path} emits exactly one <title>, and it is the route's`, async ({
      request,
    }) => {
      const res = await request.get(route.path);
      expect(res.ok()).toBe(true);

      // Two <title> elements is invalid HTML and the FIRST one wins — which is
      // exactly how the generic title used to beat every route's own.
      const titles = ssrTitles(await res.text());
      expect(titles).toHaveLength(1);
      expect(titles[0]).toBe(route.title);
    });
  }
});

test.describe("Moved pages", () => {
  // Old bookmarks and an installed PWA's history land somewhere real.
  for (const [from, to] of [
    ["/bots", "/tasks"],
    ["/treasury", "/money"],
    ["/exchanges/kraken", "/money"],
    ["/cockpit", "/"],
    ["/db", "/data"],
  ] as const) {
    test(`${from} redirects to ${to}`, async ({ request }) => {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status()).toBe(302);
      expect(res.headers()["location"]).toBe(to);
    });
  }
});

test.describe("Navigation", () => {
  test("tab links navigate between sections", async ({ page }) => {
    await page.goto("/");
    const nav = mainNav(page);

    await nav.getByRole("link", { name: /^Data$/ }).click();
    await expect(page).toHaveURL(/\/data$/);

    await nav.getByRole("link", { name: /^Tasks$/ }).click();
    await expect(page).toHaveURL(/\/tasks$/);

    await nav.getByRole("link", { name: /^Money$/ }).click();
    await expect(page).toHaveURL(/\/money$/);
  });

  test("tab groups are rendered with group labels", async ({ page }) => {
    await page.goto("/");
    const nav = mainNav(page);

    // Each label asserted explicitly: `hasText` is a substring match, so one
    // label must never be trusted to imply another.
    for (const label of ["FKS", "System"]) {
      await expect(nav.locator(".group-lbl", { hasText: label })).toBeVisible();
    }
    // The pre-2026-10-26 groups are gone.
    for (const old of ["Markets", "Trade", "Analysis"]) {
      await expect(nav.locator(".group-lbl", { hasText: old })).toHaveCount(0);
    }
    // And so are the removed pages' tabs.
    for (const old of ["Cockpit", "Futures", "Trading", "Signals", "Janus AI", "Perf", "Workspace"]) {
      await expect(nav.getByRole("link", { name: old, exact: true })).toHaveCount(0);
    }
  });

  test("Docs tab is present in the System group", async ({ page }) => {
    await page.goto("/");
    const docsTab = mainNav(page).getByRole("link", { name: /Docs/ });
    await expect(docsTab).toBeVisible();
    await docsTab.click();
    await expect(page).toHaveURL(/\/docs/);
  });

  test('active tab has aria-current="page", including on a sub-page', async ({ page }) => {
    await page.goto("/tasks/new");
    const activeTab = page.locator('nav.tabbar a.tab[aria-current="page"]');
    await expect(activeTab).toHaveText(/Tasks/);
  });
});

test.describe("Accessibility", () => {
  test("nav has aria-label", async ({ page }) => {
    await page.goto("/");
    await expect(mainNav(page)).toBeVisible();
  });
});
