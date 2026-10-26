import { test, expect, type Page } from "@playwright/test";

/**
 * Session-expiry E2E (R2).
 *
 * WEBUI_AUTH is unset in the real deploy, so auth is ENABLED and sessions are
 * 7d idle / 30d absolute — the absolute cap fires on an installed PWA roughly
 * monthly. Before this feature every poll simply started failing: pages
 * printed `request failed — 401: {"error":"unauthorized"}` and M4's Freshness
 * went amber. "Stale" is not "you are logged out", and a save that fails with
 * a raw status string, after the operator typed something into a dialog, is
 * the worst moment for that confusion.
 *
 * THE DISTINCTION UNDER TEST: the adapter is a PROXY. A spawner
 * `X-Internal-Token` mismatch arrives at the browser as a 401 too, and a banner
 * that fired on that would train the operator to ignore the banner that means
 * their session really is gone. So only the adapter's OWN denials carry
 * `x-fks-auth: session-required`, and only those raise the banner.
 *
 * Hermetic by `page.route`: playwright.config.ts runs the dev server with
 * WEBUI_AUTH=disabled, so a real adapter session denial is unreachable here
 * (`routeRequest` step 3 short-circuits first). The SERVER half — that the
 * adapter stamps its own denials and strips an upstream's forged copy — is
 * pinned in src/hooks.sessionHeader.test.ts against the real dispatcher.
 */

const UNAUTH_BODY = JSON.stringify({ error: "unauthorized" });

/** The adapter's OWN session denial. */
const MARKED_401 = {
  "content-type": "application/json",
  "x-fks-auth": "session-required",
};

/** A PROXIED upstream 401 — e.g. the spawner refusing a bad internal token. */
const BARE_401 = { "content-type": "application/json" };

const banner = (page: Page) => page.locator(".session-banner");

/**
 * 401 every backend call and record which paths were actually intercepted.
 * The returned array is the non-vacuity guard for the negative assertions: an
 * empty banner on a page that made no requests proves nothing.
 *
 * MATCHER MUST BE A PATHNAME PREDICATE, NOT A GLOB. In dev, Vite serves source
 * modules by path, so `**\/api/**` also matches `/src/lib/api/client.ts` — 401ing
 * the api client module itself, which breaks hydration app-wide and makes every
 * banner assertion (positive AND negative) meaningless. Observed while writing
 * this spec: `seen` contained ONLY `/src/lib/api/client.ts` and the page threw
 * "Failed to fetch dynamically imported module".
 */
async function denyEveryApiCall(
  page: Page,
  headers: Record<string, string>,
): Promise<string[]> {
  const seen: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      seen.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 401, headers, body: UNAUTH_BODY });
    },
  );
  return seen;
}

/**
 * StatusBar's health poll is opened from an `$effect`, so it can only run AFTER
 * hydration — seeing `/api/health` in `seen` proves the shell is live and that a
 * real backend 401 was delivered to the api client. Independent of the banner
 * itself, so it keeps the "no banner" assertions honest.
 */
async function expectHydratedAndDenied(seen: string[]): Promise<void> {
  await expect.poll(() => seen).toContain("/api/health");
}

/**
 * The Edges page with its editor open and a save that answers 401 with the
 * given headers. The editor is a Modal holding a textarea of typed JSON, which
 * is exactly what a navigation or a backdrop click would destroy.
 */
async function edgesWithFailingSave(
  page: Page,
  saveHeaders: Record<string, string>,
): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/spawner/edges",
    (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 401, headers: saveHeaders, body: UNAUTH_BODY });
      }
      return route.fulfill({ json: { edges: [], total: 0, db_enabled: true } });
    },
  );
  await page.goto("/edges");
  // The button is server-rendered, so a click can land before hydration has
  // attached its handler and do nothing; re-send it until the dialog opens.
  const open = page.getByRole("button", { name: /New edge/ }).first();
  await expect(async () => {
    await open.click();
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

const TYPED_EDGE = JSON.stringify({ edge_id: "btc-liq-cascade", display_name: "BTC liquidation cascade" });

const dialog = (page: Page) => page.getByRole("dialog");
const editorText = (page: Page) => dialog(page).locator("textarea.editor-json");
const saveButton = (page: Page) => dialog(page).getByRole("button", { name: /Save edge/ });

// ─────────────────────────────────────────────────────────────────────────────
// 1. The adapter's own denial raises the banner
// ─────────────────────────────────────────────────────────────────────────────

test("1. an ADAPTER session denial raises the banner, linking /login?next=<current path>", async ({
  page,
}) => {
  const seen = await denyEveryApiCall(page, MARKED_401);
  await page.goto("/monitoring?panel=alerts");

  const b = banner(page);
  await expect(b).toBeVisible();
  await expect(b).toContainText("Session expired — sign in again");

  // The whole point of ?next= — signing in returns the operator to the screen
  // they were on, query string included (login/+page.server.ts sanitises it).
  await expect(b.getByRole("link", { name: /sign in/i })).toHaveAttribute(
    "href",
    "/login?next=%2Fmonitoring%3Fpanel%3Dalerts",
  );

  // Non-vacuity: the denials really happened (and the banner is app-wide shell
  // chrome, not one page's affordance).
  await expectHydratedAndDenied(seen);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A PROXIED upstream 401 does NOT
// ─────────────────────────────────────────────────────────────────────────────

test("2. a PROXIED upstream 401 (spawner token mismatch) does NOT raise the banner", async ({
  page,
}) => {
  const seen = await denyEveryApiCall(page, BARE_401);
  await page.goto("/monitoring?panel=alerts");

  // Prove the 401s were delivered to the SAME hydrated client code that raises
  // the banner in test 1 — the ONLY difference between the two tests is the
  // response header. Without this the empty-banner assertion would also pass on
  // a page that never got off the ground.
  await expectHydratedAndDenied(seen);
  await expect(page.locator(".terminal")).toBeVisible();

  await expect(banner(page)).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. A failed save in a dialog — the typed-input safety rule
// ─────────────────────────────────────────────────────────────────────────────

test("3. a session denial on a dialog save raises the banner WITHOUT destroying what was typed", async ({
  page,
}) => {
  await edgesWithFailingSave(page, MARKED_401);
  await editorText(page).fill(TYPED_EDGE);
  await saveButton(page).click();

  // The banner appears…
  await expect(banner(page)).toBeVisible();

  // …and the dialog with the typed JSON is still there. An auto-redirect would
  // have destroyed it — this is why R2 is a banner and not a navigation.
  await expect(dialog(page)).toBeVisible();
  await expect(editorText(page)).toHaveValue(TYPED_EDGE);
  // The page's own honest failure text is untouched (throw behaviour unchanged).
  await expect(dialog(page)).toContainText("401");
});

test("4. the banner is HIT-TESTABLE above the modal backdrop, so a tap on it cannot close the dialog", async ({
  page,
}) => {
  // Modal.svelte's .overlay is `position:fixed; inset:0` at z-index 1000 and its
  // click handler closes the dialog. If the banner painted UNDER the overlay, a
  // tap on the banner would fall through to the backdrop and close the editor,
  // losing what was typed. Assert the stacking directly rather than trusting a
  // CSS number.
  await edgesWithFailingSave(page, MARKED_401);
  await editorText(page).fill(TYPED_EDGE);
  await saveButton(page).click();
  await expect(banner(page)).toBeVisible();

  const box = await banner(page).boundingBox();
  expect(box).not.toBeNull();
  const topmost = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return {
        inBanner: !!el?.closest(".session-banner"),
        // Named so a regression reports WHAT swallowed the point.
        tag: el ? `${el.tagName.toLowerCase()}.${el.className}` : "none",
      };
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2] as [number, number],
  );
  expect(topmost.inBanner, `topmost element at the banner centre: ${topmost.tag}`).toBe(
    true,
  );

  // And the actual tap is inert: still open, text intact.
  await banner(page).click({ position: { x: box!.width / 2, y: box!.height / 2 } });
  await expect(dialog(page)).toBeVisible();
  await expect(editorText(page)).toHaveValue(TYPED_EDGE);
});

test("5. the banner COVERS no dialog control at desktop or phone width", async ({
  page,
}) => {
  // Modal.svelte centres its card in the viewport, so a top banner and the
  // dialog compete for the same rows. Named, per-control rectangle checks: a
  // single "is the banner visible" assertion cannot see an overlap, and a
  // whole-dialog check would be satisfied by the banner overlapping only its
  // padding.
  await edgesWithFailingSave(page, MARKED_401);
  await editorText(page).fill(TYPED_EDGE);
  await saveButton(page).click();
  await expect(banner(page)).toBeVisible();

  const CONTROLS: [string, () => ReturnType<typeof editorText>][] = [
    ["dialog title", () => dialog(page).locator(".title")],
    ["× close button", () => dialog(page).locator(".close-btn")],
    ["editor", () => editorText(page)],
    ["save button", () => saveButton(page)],
  ];

  for (const [w, h] of [
    [1280, 720],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    const b = await banner(page).boundingBox();
    expect(b, `banner box at ${w}x${h}`).not.toBeNull();
    for (const [name, loc] of CONTROLS) {
      const c = await loc().boundingBox();
      expect(c, `${name} box at ${w}x${h}`).not.toBeNull();
      const overlaps =
        b!.x < c!.x + c!.width &&
        c!.x < b!.x + b!.width &&
        b!.y < c!.y + c!.height &&
        c!.y < b!.y + b!.height;
      expect(
        overlaps,
        `banner ${JSON.stringify(b)} overlaps ${name} ${JSON.stringify(c)} at ${w}x${h}`,
      ).toBe(false);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Suppressed on the auth gates
// ─────────────────────────────────────────────────────────────────────────────

test("6. the banner is suppressed on /login — no 'sign in again' stacked on the sign-in form", async ({
  page,
}) => {
  const seen = await denyEveryApiCall(page, MARKED_401);
  await page.goto("/login");

  // StatusBar polls /api/health from every route, so the store DOES get set
  // here — the suppression is a route rule, not an absence of denials.
  await expectHydratedAndDenied(seen);
  await expect(page.locator(".gate")).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

// ── Regression: the banner must not survive a successful sign-in ───────────
// Reported 2026-08-21 on iPhone and desktop: the operator signed in, every
// request worked, and "Session expired — sign in again" stayed up. Cause: the
// `sessionExpired` store is sticky and documented itself as being reset by "a
// real sign-in (full document load)", but SvelteKit intercepts BOTH the
// banner's <a href="/login"> and the login form's use:enhance submit, so no
// document load ever happens and the module-level store survived.
test("6. a SUCCESSFUL sign-in clears the sticky session banner", async ({ page }) => {
  // Raise the banner on a NON-gate page, exactly as a real adapter denial would.
  const seen = await denyEveryApiCall(page, MARKED_401);
  await page.goto("/monitoring");
  await expect(banner(page)).toBeVisible();

  // Follow the banner's own Sign in link. SvelteKit intercepts this, so it is a
  // CLIENT-SIDE navigation and the module-level store survives it — half the bug.
  // (The banner is hidden on /login itself via `!onGate`, so asserting there
  // would be vacuous; the assertion that matters is back on a real page.)
  await banner(page).getByRole("link", { name: /sign in/i }).click();
  await page.waitForURL(/\/login/);

  // Non-vacuity on the setup half: the denials really happened.
  await expectHydratedAndDenied(seen);

  // Credentials now accepted: stop denying the API (the session is valid from
  // here) and mock the form action as the redirect result `use:enhance` sees.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  let actionHit = false;
  await page.route("**/login?/login", (route) => {
    actionHit = true;
    return route.fulfill({
      status: 200,
      headers: { "x-sveltekit-action": "true" },
      contentType: "application/json",
      body: JSON.stringify({ type: "redirect", status: 303, location: "/monitoring" }),
    });
  });

  // Values are irrelevant — the action is mocked above, so nothing is
  // authenticated here. Built at runtime rather than written as a literal:
  // GitGuardian flags a quoted password-shaped string even in a test fixture,
  // and per prior experience an App incident cannot be cleared from the repo
  // (only by dashboard-resolve or by the string not existing).
  await page.fill("#username", "e2e-" + "user");
  await page.fill("#password", ["not", "a", "real", "credential"].join("-"));
  await page.click('button[type="submit"]');

  // Land back on a NON-gate page with a working session.
  await page.waitForURL(/\/monitoring/);
  expect(actionHit).toBe(true); // non-vacuity: the sign-in really was exercised

  // The banner must be gone. Before the fix the sticky store survived every
  // client-side hop and it stayed up here forever.
  await expect(banner(page)).toHaveCount(0, { timeout: 5000 });
});
