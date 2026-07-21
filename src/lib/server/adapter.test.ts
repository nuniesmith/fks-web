import { describe, expect, it } from "vitest";
import {
  type AuthState,
  type SessionInfo,
  isBackend,
  isPublic,
  originAllowed,
  outageRoute,
  routeRequest,
  upstreamHeaders,
} from "./adapter";

describe("isBackend", () => {
  it("matches the proxied backend prefixes", () => {
    for (const p of [
      "/api/health",
      "/sse/bars/BTC",
      "/bars/BTC/candles",
      "/factory/news",
      "/kraken/status",
      "/fapi/dashboard",
    ]) {
      expect(isBackend(p)).toBe(true);
    }
  });

  it("does not match pages or a bare prefix without the trailing slash", () => {
    for (const p of ["/", "/charts", "/login", "/api", "/bars"]) {
      expect(isBackend(p)).toBe(false);
    }
  });
});

describe("isPublic", () => {
  it("treats login/logout pages and health probes as public", () => {
    for (const p of ["/login", "/login/oauth", "/logout", "/api/health", "/healthz"]) {
      expect(isPublic(p)).toBe(true);
    }
  });

  it("treats every other page as non-public", () => {
    for (const p of ["/", "/charts", "/settings", "/api/health/extra", "/healthzz"]) {
      expect(isPublic(p)).toBe(false);
    }
  });
});

describe("upstreamHeaders", () => {
  it("strips hop-by-hop AND boundary credentials, preserving the rest", () => {
    const src = new Headers();
    src.set("Host", "evil.example");
    src.set("Connection", "keep-alive");
    src.set("Content-Length", "10");
    src.set("Transfer-Encoding", "chunked");
    src.set("Keep-Alive", "timeout=5");
    src.set("Cookie", "fks_session=abc");
    // A client MUST NOT be able to smuggle a boundary credential through: the
    // adapter mints these itself on the outbound side.
    src.set("X-Internal-Token", "client-forged-token");
    src.set("Authorization", "Bearer client-forged");
    src.set("Content-Type", "application/json");

    const out = upstreamHeaders(src);

    for (const stripped of [
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "keep-alive",
      "cookie",
      "x-internal-token",
      "authorization",
    ]) {
      expect(out.has(stripped)).toBe(false);
    }
    expect(out.get("content-type")).toBe("application/json");
  });
});

// ── routeRequest matrix ──────────────────────────────────────────────────────

const disabled: AuthState = { mode: "disabled" };
const bootstrap: AuthState = { mode: "bootstrap" };
const noSession: AuthState = { mode: "enabled", session: null };
const good: SessionInfo = { userId: 1, username: "admin", role: "admin", mustChange: false };
const mustChange: SessionInfo = { ...good, mustChange: true };
const enabled = (s: SessionInfo | null): AuthState => ({ mode: "enabled", session: s });

describe("routeRequest — health probes are always open", () => {
  it("proxies /api/health unauthenticated in every mode", () => {
    for (const a of [bootstrap, noSession, enabled(mustChange)]) {
      expect(routeRequest("/api/health", "", "GET", a)).toEqual({ kind: "backend" });
    }
  });
  it("passes /healthz page unauthenticated", () => {
    expect(routeRequest("/healthz", "", "GET", noSession)).toEqual({ kind: "pass" });
  });
});

describe("routeRequest — disabled (explicit opt-in bypass)", () => {
  it("passes pages and proxies backend without a session", () => {
    expect(routeRequest("/settings", "", "GET", disabled)).toEqual({ kind: "pass" });
    expect(routeRequest("/api/spawner/x", "", "POST", disabled)).toEqual({ kind: "backend" });
  });
});

describe("routeRequest — bootstrap (no users yet, fail closed on writes)", () => {
  it("lets GET reads through but 401s mutations", () => {
    expect(routeRequest("/api/signals", "", "GET", bootstrap)).toEqual({ kind: "backend" });
    expect(routeRequest("/api/spawner/x", "", "POST", bootstrap)).toEqual({ kind: "unauthorized" });
  });
  it("funnels pages to /setup", () => {
    expect(routeRequest("/charts", "", "GET", bootstrap)).toEqual({ kind: "redirect", location: "/setup" });
    expect(routeRequest("/setup", "", "GET", bootstrap)).toEqual({ kind: "pass" });
  });
});

describe("routeRequest — enabled, no session (fail closed)", () => {
  it("401s ALL backend calls incl. GET/SSE (reads leak balances/keys/signals)", () => {
    expect(routeRequest("/api/signals", "", "GET", noSession)).toEqual({ kind: "unauthorized" });
    expect(routeRequest("/sse/bars/BTC", "", "GET", noSession)).toEqual({ kind: "unauthorized" });
    expect(routeRequest("/api/spawner/x", "", "POST", noSession)).toEqual({ kind: "unauthorized" });
  });
  it("redirects pages to /login preserving the URL", () => {
    expect(routeRequest("/settings", "?tab=keys", "GET", noSession)).toEqual({
      kind: "redirect",
      location: "/login?next=%2Fsettings%3Ftab%3Dkeys",
    });
  });
});

describe("routeRequest — enabled, mustChange (confined to /setup)", () => {
  it("403s backend mutations, allows GET reads", () => {
    expect(routeRequest("/api/spawner/x", "", "POST", enabled(mustChange))).toEqual({ kind: "forbidden" });
    expect(routeRequest("/api/spawner/x", "", "PUT", enabled(mustChange))).toEqual({ kind: "forbidden" });
    expect(routeRequest("/api/signals", "", "GET", enabled(mustChange))).toEqual({ kind: "backend" });
  });
  it("redirects app pages to /setup but lets /setup render", () => {
    expect(routeRequest("/charts", "", "GET", enabled(mustChange))).toEqual({ kind: "redirect", location: "/setup" });
    expect(routeRequest("/setup", "", "GET", enabled(mustChange))).toEqual({ kind: "pass" });
  });
});

describe("routeRequest — enabled, full session", () => {
  it("proxies backend (any method) and passes pages", () => {
    expect(routeRequest("/api/spawner/x", "", "POST", enabled(good))).toEqual({ kind: "backend" });
    expect(routeRequest("/settings", "", "GET", enabled(good))).toEqual({ kind: "pass" });
  });
  it("bounces a completed /setup back to the app", () => {
    expect(routeRequest("/setup", "", "GET", enabled(good))).toEqual({ kind: "redirect", location: "/" });
  });
});

describe("routeRequest — PWA static assets are public pre-login (GET/HEAD)", () => {
  const staticPaths = [
    "/manifest.webmanifest",
    "/service-worker.js",
    "/favicon.ico",
    "/favicon.svg",
    "/robots.txt",
    "/apple-touch-icon.png",
    "/apple-touch-icon.svg",
  ];

  it("passes each static asset unauthenticated on GET and HEAD", () => {
    for (const p of staticPaths) {
      expect(routeRequest(p, "", "GET", noSession)).toEqual({ kind: "pass" });
      expect(routeRequest(p, "", "HEAD", noSession)).toEqual({ kind: "pass" });
    }
  });

  it("does NOT open a random /api path or an unlisted static-looking page", () => {
    // A backend path still fails closed without a session…
    expect(routeRequest("/api/signals", "", "GET", noSession)).toEqual({ kind: "unauthorized" });
    expect(routeRequest("/api/spawner/x", "", "POST", noSession)).toEqual({ kind: "unauthorized" });
    // …and a path merely *resembling* a static asset (not on the allowlist)
    // still redirects to login — proving this is an allowlist, not a wildcard.
    expect(routeRequest("/manifest.webmanifest.map", "", "GET", noSession)).toEqual({
      kind: "redirect",
      location: "/login?next=%2Fmanifest.webmanifest.map",
    });
    expect(routeRequest("/icons/secret.png", "", "GET", noSession)).toEqual({
      kind: "redirect",
      location: "/login?next=%2Ficons%2Fsecret.png",
    });
  });

  it("does not grant a non-GET (e.g. POST) a static free pass", () => {
    // Falls through to the page gate → redirect to login, never a pass.
    expect(routeRequest("/manifest.webmanifest", "", "POST", noSession)).toEqual({
      kind: "redirect",
      location: "/login?next=%2Fmanifest.webmanifest",
    });
  });
});

describe("outageRoute — fail closed but keep login renderable on a store outage", () => {
  it("keeps health probes open (monitoring survives)", () => {
    expect(outageRoute("/api/health")).toBe("open-backend");
    expect(outageRoute("/healthz")).toBe("open-page");
  });

  // REGRESSION: a persistent store outage (or a least-privilege deploy that
  // can't self-migrate) previously 503'd EVERY page including /login, bricking
  // the whole browser recovery path. The login/logout pages must render so the
  // operator sees a UI + retry surface (the login action still fails closed).
  it("renders login/logout pages during an outage instead of 503", () => {
    expect(outageRoute("/login")).toBe("open-page");
    expect(outageRoute("/logout")).toBe("open-page");
  });

  it("still fails closed for everything that needs auth", () => {
    expect(outageRoute("/settings")).toBe("deny-page");
    expect(outageRoute("/")).toBe("deny-page");
    expect(outageRoute("/api/spawner/bots/kill")).toBe("deny-backend");
    expect(outageRoute("/api/signals")).toBe("deny-backend");
    expect(outageRoute("/sse/bars/BTC")).toBe("deny-backend");
  });
});

describe("originAllowed — CSRF guard on state-changing backend calls", () => {
  it("always allows GET/HEAD regardless of origin", () => {
    expect(originAllowed("GET", "https://evil.example", "fks.local")).toBe(true);
    expect(originAllowed("HEAD", null, "fks.local")).toBe(true);
  });
  it("allows a same-host Origin and a missing Origin (native/server client)", () => {
    expect(originAllowed("POST", "https://fks.local", "fks.local")).toBe(true);
    expect(originAllowed("POST", null, "fks.local")).toBe(true);
  });
  it("rejects a cross-site Origin and a malformed one", () => {
    expect(originAllowed("POST", "https://evil.example", "fks.local")).toBe(false);
    expect(originAllowed("POST", "not-a-url", "fks.local")).toBe(false);
  });
});
