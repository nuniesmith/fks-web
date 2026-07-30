import { test, expect, type Page } from "@playwright/test";

/**
 * The three auth gates — /login, /setup, /invite/[token] — each re-declared the
 * same 15 form-control classes, with the M5 scroll-region comment block
 * byte-identical in all three. They had ALREADY drifted: /login grew a grid
 * background and a triple box-shadow the others never got, the card gap went
 * 16 vs 12, the subtitle 10px vs 11px. M-2 step 1 lifts the shared rules into
 * `src/styles/gate.css`.
 *
 * WHY THIS SPEC AND NOT A GateCard COMPONENT TEST:
 * roadmap M5 item 6 says to "assert the gate-card CSS at component level
 * instead". There is no gate-card component, and `playwright.config.ts` runs the
 * suite with WEBUI_AUTH=disabled, under which `/setup` redirects to `/`
 * (`setup/+page.server.ts` requireMustChangeSession → authDisabled ⇒ "/"). So
 * M5's own accepted test plan is currently unimplementable, and these pages had
 * ZERO automated coverage while /setup is the page that bricks first-run
 * bootstrap if it breaks. The first test below pins that reachability fact so
 * nobody has to re-derive it.
 *
 * /login and /invite ARE both hermetically reachable (PUBLIC_PREFIXES; under
 * authDisabled the invite load returns the "invalid" state and renders the same
 * card chrome), so the drift this spec can actually SEE is the login↔invite
 * pair — which covers every axis that had drifted.
 *
 * Each gate is navigated ONCE, in beforeAll, and every rule read in a single
 * evaluate: a first draft that re-navigated per assertion hit
 * net::ERR_INSUFFICIENT_RESOURCES under `fullyParallel`.
 */

const LOGIN = "/login";
// Any token: with auth disabled the invite load short-circuits to "invalid".
const INVITE = "/invite/hermetic-not-a-real-token";

/** The exact axes that had drifted, plus enough neighbours to catch a new one. */
const PROBES = {
  ".gate": [
    "overflow-y",
    "padding-top",
    "background-color",
    "background-image",
    "align-items",
    "min-height",
  ],
  ".panel": [
    "width",
    "row-gap",
    "box-shadow",
    "padding-top",
    "padding-left",
    "border-radius",
    "background-color",
    "border-top-width",
  ],
  ".title": ["font-size", "font-weight", "text-align", "letter-spacing"],
  ".subtitle": ["font-size", "line-height", "color", "text-align", "letter-spacing"],
  ".btn": ["height", "margin-top", "background-color", "border-top-width", "font-size"],
} as const;

type Snapshot = Record<string, Record<string, string>>;

async function snapshot(page: Page, path: string): Promise<Snapshot> {
  await page.goto(path);
  await expect(page.locator(".panel").first()).toBeVisible();
  const snap = await page.evaluate((probes: Record<string, readonly string[]>) => {
    const out: Record<string, Record<string, string>> = {};
    for (const [selector, props] of Object.entries(probes)) {
      const el = document.querySelector(selector);
      if (!el) {
        out[selector] = { MISSING: selector };
        continue;
      }
      const cs = getComputedStyle(el);
      const one: Record<string, string> = {};
      for (const p of props) one[p] = cs.getPropertyValue(p);
      out[selector] = one;
    }
    return out;
  }, PROBES as unknown as Record<string, readonly string[]>);

  // A missing element would make two gates "agree" vacuously.
  for (const [selector, values] of Object.entries(snap)) {
    expect(values, `${path} must render ${selector}`).not.toHaveProperty("MISSING");
  }
  return snap;
}

let login: Snapshot;
let invite: Snapshot;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    login = await snapshot(page, LOGIN);
    invite = await snapshot(page, INVITE);
  } finally {
    await page.close();
  }
});

test.describe("auth gate chrome is shared, not copy-pasted", () => {
  test("/setup is NOT reachable with auth disabled — M5's component test plan cannot run", async ({
    request,
  }) => {
    // Asserted at the HTTP layer: following the redirect would boot the whole
    // app shell for a fact about a header.
    const res = await request.get("/setup", { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expect(res.headers()["location"]).toBe("/");
  });

  test("the gate card resolves identically on /login and /invite", () => {
    // width 360 vs 380, row-gap 16 vs 12, box-shadow triple vs none.
    expect(invite[".panel"]).toEqual(login[".panel"]);
    // Guard the guard: two UNSTYLED cards would also be "identical". These
    // values only exist if the shared sheet actually reached the page.
    expect(login[".panel"]["box-shadow"]).not.toBe("none");
    expect(login[".panel"]["row-gap"]).not.toBe("normal");
    expect(login[".panel"].width).toBe("380px");
  });

  test("the gate scroll region resolves identically on /login and /invite", () => {
    // /login had the grid backdrop; /setup and /invite were flat.
    expect(invite[".gate"]).toEqual(login[".gate"]);
    // M5's reachability fix must survive the lift on BOTH pages: without a
    // scroll region the centred card hides its own submit button when the
    // software keyboard is up.
    expect(login[".gate"]["overflow-y"]).toBe("auto");
    expect(login[".gate"]["background-image"]).not.toBe("none");
  });

  test("title, subtitle and button resolve identically on /login and /invite", () => {
    expect(invite[".title"]).toEqual(login[".title"]);
    // subtitle font-size was 10px on /login, 11px on the other two.
    expect(invite[".subtitle"]).toEqual(login[".subtitle"]);
    expect(login[".subtitle"]["font-size"]).toBe("11px");
    // .btn margin-top was 4px on /login, 10px on the other two.
    expect(invite[".btn"]).toEqual(login[".btn"]);
    expect(login[".btn"].height).toBe("36px");
  });
});
