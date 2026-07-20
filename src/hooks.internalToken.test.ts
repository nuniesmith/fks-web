// Regression test for auth-chain H5: #47's `upstreamHeaders` strip-set removed
// the nginx-injected `x-internal-token` at the seam, but the nine DIRECT
// `fetch(${SPAWNER_URL}…)` helpers (exchange-key secrets, notification channels,
// capabilities) re-minted it nowhere — so post-#47 they hit an enforcing spawner
// token-less (401), breaking /settings key rotation + notifications. The fix
// routes each helper's headers through `withInternalToken(SPAWNER_URL, …)`.
//
// This drives every one of those helpers through the exported `proxyBackend`
// dispatcher with a mocked global `fetch`, asserting two things per site:
//   1. the outbound spawner request carries the trusted service token, and
//   2. a client-supplied (forged) `x-internal-token` is stripped at the seam —
//      the outbound value is the minted one, never the smuggled one.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { upstreamHeaders } from "$lib/server/adapter";

const TOKEN = "trusted-internal-token-xyz";
const FORGED = "client-forged-token";
const SPAWNER = "http://spawner.test";

// The hook reads these at module-load, so set them BEFORE the dynamic import.
process.env.INTERNAL_TOKEN = TOKEN;
process.env.SPAWNER_INTERNAL_URL = SPAWNER;

let proxyBackend: (event: unknown) => Promise<Response>;

beforeAll(async () => {
  const mod = await import("./hooks.server");
  proxyBackend = (mod as { proxyBackend: typeof proxyBackend }).proxyBackend;
});

// Captured outbound fetch calls (url + the Headers the helper built).
interface Captured {
  url: string;
  headers: Headers;
  method: string;
}
let calls: Captured[] = [];

function installFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers ?? {});
      calls.push({ url, headers, method: (init?.method ?? "GET").toUpperCase() });
      // Shapes the helpers tolerate: status/notifications list endpoints expect
      // an object with the relevant array; POST/DELETE just check r.ok + parse.
      return new Response(JSON.stringify({ exchanges: [], channels: [], ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Minimal RequestEvent stand-in: `proxyBackend` only reads `.url` and `.request`.
// Every request arrives carrying a FORGED client `x-internal-token` so each case
// also proves the strip-at-the-seam invariant.
function makeEvent(path: string, method: string, body?: unknown): unknown {
  const url = new URL(`http://webui.test${path}`);
  const headers = new Headers({ "x-internal-token": FORGED });
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers.set("content-type", "application/json");
  }
  const request = new Request(url, init);
  return { url, request };
}

// The nine direct spawner helpers, addressed by the route that dispatches to each.
const CASES: { name: string; path: string; method: string; body?: unknown }[] = [
  { name: "exchangeKeysStatusAll", path: "/api/settings/exchange-keys/status", method: "GET" },
  { name: "capabilities", path: "/api/capabilities", method: "GET" },
  { name: "exchangeKeysStatus (legacy)", path: "/api/settings/kraken-status", method: "GET" },
  {
    name: "exchangeKeysPost",
    path: "/api/settings/exchange-keys",
    method: "POST",
    body: { exchange: "kraken", api_key: "k", api_secret: "s" },
  },
  { name: "exchangeKeysDelete", path: "/api/settings/exchange-keys/kraken", method: "DELETE" },
  { name: "notificationsList", path: "/api/settings/notifications", method: "GET" },
  {
    name: "notificationsPost",
    path: "/api/settings/notifications",
    method: "POST",
    body: { name: "chan", url: "https://example.test/hook" },
  },
  { name: "notificationsTest", path: "/api/settings/notifications/chan/test", method: "POST" },
  { name: "notificationsDelete", path: "/api/settings/notifications/chan", method: "DELETE" },
];

describe("H5: direct spawner helpers mint the internal token", () => {
  for (const c of CASES) {
    it(`${c.name} sends X-Internal-Token to the spawner`, async () => {
      installFetch();
      await proxyBackend(makeEvent(c.path, c.method, c.body));
      // Exactly one outbound call, to the spawner base, carrying the token.
      const spawnerCalls = calls.filter((k) => k.url.startsWith(SPAWNER));
      expect(spawnerCalls.length).toBe(1);
      const sent = spawnerCalls[0].headers.get("x-internal-token");
      expect(sent).toBe(TOKEN);
      // The forged client value must not survive the seam.
      expect(sent).not.toBe(FORGED);
    });
  }
});

describe("H5: the seam strips a client-supplied internal token", () => {
  it("upstreamHeaders drops a forged x-internal-token before re-mint", () => {
    const src = new Headers({ "x-internal-token": FORGED, "content-type": "application/json" });
    const out = upstreamHeaders(src);
    expect(out.has("x-internal-token")).toBe(false);
    // Non-boundary headers still pass through.
    expect(out.get("content-type")).toBe("application/json");
  });
});
