// R2, server half — the adapter must MARK its own session denials and must NOT
// mark (or let an upstream forge) a proxied 401.
//
// Why this can't be an e2e spec: playwright.config.ts starts the dev server with
// WEBUI_AUTH=disabled, so the adapter's own session denial is unreachable there
// (routeRequest step 3 short-circuits before the enabled-mode branches). The
// browser-side half is covered in tests/e2e/session.spec.ts with route mocks;
// this file drives the real dispatcher.
//
// Mirrors hooks.internalToken.test.ts: env set BEFORE a dynamic import of the
// hook, `proxyBackend` driven directly with a minimal RequestEvent stand-in.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_HEADER, SESSION_REQUIRED } from "$stores/session";

const SPAWNER = "http://spawner.test";
process.env.SPAWNER_INTERNAL_URL = SPAWNER;
process.env.INTERNAL_TOKEN = "trusted-internal-token";

let proxyBackend: (event: unknown, auth?: unknown) => Promise<Response>;

beforeAll(async () => {
  const mod = await import("./hooks.server");
  proxyBackend = (mod as { proxyBackend: typeof proxyBackend }).proxyBackend;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal RequestEvent stand-in: proxyBackend reads only `.url` / `.request`. */
function makeEvent(path: string, method = "GET", body?: unknown): unknown {
  const url = new URL(`http://webui.test${path}`);
  const headers = new Headers();
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return { url, request: new Request(url, init) };
}

describe("the adapter MARKS its own session denial", () => {
  it("POST /api/alerts/ack with no session → 401 + x-fks-auth: session-required", async () => {
    // proxyBackend is also reached on the auth-store outage path WITHOUT an
    // `auth` arg; that defense-in-depth denial is the adapter's own decision, so
    // it must carry the marker the browser banner keys off.
    const res = await proxyBackend(makeEvent("/api/alerts/ack", "POST", { id: "x" }));
    expect(res.status).toBe(401);
    expect(res.headers.get(SESSION_HEADER)).toBe(SESSION_REQUIRED);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("still marks it when auth is present but carries no session", async () => {
    const res = await proxyBackend(makeEvent("/api/alerts/ack", "POST", { id: "x" }), {
      mode: "enabled",
      session: null,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get(SESSION_HEADER)).toBe(SESSION_REQUIRED);
  });
});

describe("a PROXIED upstream 401 is NOT marked", () => {
  /** Stub the upstream so the spawner answers 401, as it does on a bad token. */
  function upstream401(extraHeaders: Record<string, string> = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...extraHeaders },
          }),
      ),
    );
  }

  it("spawner X-Internal-Token mismatch → 401 with NO marker (signing in can't fix it)", async () => {
    upstream401();
    const res = await proxyBackend(makeEvent("/api/spawner/bots"));
    // The status is proxied through unchanged — that behaviour is deliberate.
    expect(res.status).toBe(401);
    // …but it must not claim the operator's session expired.
    expect(res.headers.get(SESSION_HEADER)).toBeNull();
  });

  it("an upstream that ECHOES the marker cannot forge the banner", async () => {
    // The signal means "the adapter itself refused you". upstreamHeaders'
    // strip set (adapter.ts) does not cover x-fks-auth, so `forward` deletes it
    // explicitly — otherwise a misconfigured upstream could raise a false
    // "sign in again" on a proxied 401.
    upstream401({ [SESSION_HEADER]: SESSION_REQUIRED });
    const res = await proxyBackend(makeEvent("/api/spawner/bots"));
    expect(res.status).toBe(401);
    expect(res.headers.get(SESSION_HEADER)).toBeNull();
  });

  it("does not strip other x-fks-* response headers (only the auth marker)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json", "x-fks-thing": "kept" },
          }),
      ),
    );
    const res = await proxyBackend(makeEvent("/api/spawner/bots"));
    expect(res.headers.get("x-fks-thing")).toBe("kept");
  });
});
