import { describe, expect, it } from "vitest";
import {
  AUTH_DISABLED_BLOCKED_MUTATIONS,
  type AuthState,
  type SessionInfo,
  isBackend,
  isPublic,
  matchesBlockedMutation,
  originAllowed,
  outageRoute,
  roleDenies,
  roleRank,
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
  it("treats login/logout/invite pages and health probes as public", () => {
    for (const p of [
      "/login",
      "/login/oauth",
      "/logout",
      "/invite",
      "/invite/some-opaque-token",
      "/api/health",
      "/healthz",
    ]) {
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
  /// REGRESSION (2026-08-24). `fetch` transparently decompresses a gzipped
  /// upstream response, so the proxied body is plaintext — but the upstream's
  /// `Content-Encoding: gzip` was being copied onto it. The browser tried to
  /// gunzip uncompressed JSON, the fetch rejected, and the page rendered the
  /// failure as "no data": every Prometheus panel on /monitoring was blank
  /// while Prometheus was healthy and answering `sum(up)`=10.
  ///
  /// Prometheus was the only upstream honouring accept-encoding at the time, so
  /// three routes broke and seven more were latent.
  it("strips content-encoding — the body is already decompressed by fetch", () => {
    const src = new Headers();
    src.set("Content-Encoding", "gzip");
    src.set("Content-Type", "application/json");

    const out = upstreamHeaders(src);

    expect(out.get("content-encoding")).toBeNull();
    expect(out.get("content-type")).toBe("application/json");
  });

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
const operator: SessionInfo = { userId: 2, username: "op", role: "operator", mustChange: false };
const viewer: SessionInfo = { userId: 3, username: "vw", role: "viewer", mustChange: false };
const garbage: SessionInfo = { userId: 4, username: "gb", role: "wat", mustChange: false };
const enabled = (s: SessionInfo | null): AuthState => ({ mode: "enabled", session: s });

// The public claim page must render pre-auth in EVERY posture — its load surfaces
// the invite state, and the claim ACTION (a page-path POST) fails closed in the
// service, not at the seam. Bootstrap mode is harmless: isPublic passes before
// the bootstrap branch, and with no users there are no invites → invalid state.
describe("/invite — public claim page across postures", () => {
  const token = "/invite/opaque-token-xyz";
  it("GET load passes for bootstrap, no-session, and full sessions", () => {
    for (const a of [bootstrap, noSession, enabled(good), enabled(operator), enabled(viewer)]) {
      expect(routeRequest(token, "", "GET", a)).toEqual({ kind: "pass" });
    }
  });
  it("the claim action (page-path POST) passes the seam in enabled AND bootstrap", () => {
    expect(routeRequest(token, "", "POST", noSession)).toEqual({ kind: "pass" });
    expect(routeRequest(token, "", "POST", bootstrap)).toEqual({ kind: "pass" });
  });
  it("renders open-page (degraded) during a store outage", () => {
    expect(outageRoute(token)).toBe("open-page");
    expect(outageRoute("/invite")).toBe("open-page");
  });
  it("segment boundary: a path merely SHARING the prefix spelling is NOT public", () => {
    // /invitefoo must not ride /invite's bypass — same for the older prefixes.
    for (const impostor of ["/invitefoo", "/invited", "/invite-admin", "/loginx", "/logoutte"]) {
      expect(routeRequest(impostor, "", "GET", noSession)).toEqual({
        kind: "redirect",
        location: `/login?next=${encodeURIComponent(impostor)}`,
      });
      expect(outageRoute(impostor)).toBe("deny-page");
    }
  });
});

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

// M1 — the WEBUI_AUTH=disabled bypass must NOT expose the money-path config
// mutations (raise exposure / delete a live key / register an exfil webhook),
// exactly like the cockpit kill/re-arm carve-out. These are the backend paths
// routeRequest sees (traced through hooks.server.ts dispatch).
describe("routeRequest — disabled mode blocks money-path mutations (M1)", () => {
  const blocked = [
    "/api/settings/risk", // risk-config PUT (raise max_gross_exposure)
    "/api/settings/exchange-keys", // exchange-keys POST (write live creds)
    "/api/settings/exchange-keys/kraken", // per-exchange DELETE (dynamic segment)
    "/api/settings/kraken-keys", // legacy fixed-venue write
    "/api/settings/kucoin-keys",
    "/api/settings/cryptocom-keys",
    "/api/settings/notifications", // notifications POST (register exfil webhook)
    "/api/settings/notifications/discord", // channel DELETE (segment sub-path)
    "/api/settings/notifications/discord/test", // channel test POST
  ];

  it("403s each money mutation in disabled mode (any non-GET method)", () => {
    for (const p of blocked) {
      for (const m of ["POST", "PUT", "DELETE"]) {
        expect(routeRequest(p, "", m, disabled)).toEqual({
          kind: "forbidden",
          reason: "live_mutation_requires_auth",
        });
      }
    }
  });

  it("still lets the GET read counterparts through in disabled mode", () => {
    // The block is mutation-only: status/list/history reads keep today's
    // disabled-mode behaviour so the dashboard still renders.
    for (const p of [
      "/api/settings/exchange-keys/status",
      "/api/settings/notifications",
      "/api/settings/notifications/history",
    ]) {
      expect(routeRequest(p, "", "GET", disabled)).toEqual({ kind: "backend" });
    }
  });

  it("does not over-match a prefix-sharing sibling path", () => {
    // Segment-boundary match: `/api/settings/riskier` must NOT be blocked just
    // because it shares the `/api/settings/risk` spelling.
    expect(matchesBlockedMutation("/api/settings/riskier")).toBe(false);
    expect(matchesBlockedMutation("/api/settings/risk")).toBe(true);
    expect(matchesBlockedMutation("/api/settings/exchange-keys/kraken")).toBe(true);
  });

  it("in ENABLED mode an admin still reaches the backend for each (auth is the wall, not the path)", () => {
    for (const p of blocked) {
      // Admin, full session → the mutation proxies (routeRequest returns
      // backend; RBAC R2 admin-only is satisfied). Uses DELETE for the
      // delete-shaped paths and POST otherwise so the method is a real one.
      const m = p.endsWith("/kraken") || p.endsWith("/discord") ? "DELETE" : "POST";
      expect(routeRequest(p, "", m, enabled(good))).toEqual({ kind: "backend" });
    }
  });

  it("in ENABLED mode a viewer is denied these mutations (RBAC R2/R3, unchanged)", () => {
    expect(routeRequest("/api/settings/risk", "", "POST", enabled(viewer))).toEqual({
      kind: "forbidden",
      reason: "role_denied",
    });
    expect(routeRequest("/api/settings/exchange-keys", "", "POST", enabled(viewer))).toEqual({
      kind: "forbidden",
      reason: "role_denied",
    });
  });

  it("keeps unrelated backend mutations proxying in disabled mode", () => {
    expect(routeRequest("/api/spawner/x", "", "POST", disabled)).toEqual({ kind: "backend" });
  });

  it("the money paths are present in AUTH_DISABLED_BLOCKED_MUTATIONS", () => {
    for (const p of [
      "/api/settings/risk",
      "/api/settings/exchange-keys",
      "/api/settings/kraken-keys",
      "/api/settings/kucoin-keys",
      "/api/settings/cryptocom-keys",
      "/api/settings/notifications",
    ]) {
      expect(AUTH_DISABLED_BLOCKED_MUTATIONS).toContain(p);
    }
  });
});

describe("routeRequest — bootstrap (no users yet, fail closed on writes)", () => {
  it("lets GET reads through but 401s mutations", () => {
    expect(routeRequest("/api/signals", "", "GET", bootstrap)).toEqual({ kind: "backend" });
    expect(routeRequest("/api/spawner/x", "", "POST", bootstrap)).toEqual({
      kind: "unauthorized",
      reason: "bootstrap",
    });
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

// ── RBAC: roleRank / roleDenies (pure rule table, plan 01 §1.1) ──────────────

describe("roleRank — ordering + fail-closed on unknown", () => {
  it("orders viewer < operator < admin", () => {
    expect(roleRank("viewer")).toBeLessThan(roleRank("operator"));
    expect(roleRank("operator")).toBeLessThan(roleRank("admin"));
  });
  it("treats an unknown/garbage role as viewer (fail closed)", () => {
    expect(roleRank("garbage")).toBe(roleRank("viewer"));
    expect(roleRank("")).toBe(roleRank("viewer"));
    // prototype keys must not resolve to a rank
    expect(roleRank("toString")).toBe(roleRank("viewer"));
    expect(roleRank("constructor")).toBe(roleRank("viewer"));
  });
});

describe("roleDenies — R1-R4 backend rules", () => {
  it("R1: admin-only surfaces deny non-admins on ANY method incl. GET", () => {
    expect(roleDenies("/api/users", "GET", "operator")).toBe(true);
    expect(roleDenies("/api/users/7/role", "POST", "operator")).toBe(true);
    expect(roleDenies("/api/invites", "GET", "viewer")).toBe(true);
    expect(roleDenies("/api/users", "GET", "admin")).toBe(false);
  });
  it("R4: reads (GET/HEAD) are open to every role", () => {
    expect(roleDenies("/api/spawner/status", "GET", "viewer")).toBe(false);
    expect(roleDenies("/sse/bars/BTC", "GET", "viewer")).toBe(false);
    expect(roleDenies("/api/settings/risk", "GET", "viewer")).toBe(false);
  });
  it("R2: admin-only mutations deny operator, allow admin", () => {
    expect(roleDenies("/api/cockpit/rearm", "POST", "operator")).toBe(true);
    expect(roleDenies("/api/settings/exchange-keys", "POST", "operator")).toBe(true);
    expect(roleDenies("/api/settings/kraken-keys", "POST", "operator")).toBe(true);
    expect(roleDenies("/api/settings/notifications/discord/test", "POST", "operator")).toBe(true);
    expect(roleDenies("/api/settings/risk", "POST", "operator")).toBe(true);
    expect(roleDenies("/api/janus/config", "POST", "operator")).toBe(true);
    expect(roleDenies("/api/settings/exchange-keys", "POST", "admin")).toBe(false);
    expect(roleDenies("/api/cockpit/rearm", "POST", "admin")).toBe(false);
  });
  it("R3: kill + other mutations are operator+ (viewer denied)", () => {
    expect(roleDenies("/api/cockpit/kill", "POST", "operator")).toBe(false);
    expect(roleDenies("/api/cockpit/kill", "POST", "admin")).toBe(false);
    expect(roleDenies("/api/cockpit/kill", "POST", "viewer")).toBe(true);
    expect(roleDenies("/api/spawner/spawn", "POST", "operator")).toBe(false);
    expect(roleDenies("/api/spawner/spawn", "POST", "viewer")).toBe(true);
    expect(roleDenies("/api/spawner/configs/x/respawn", "POST", "viewer")).toBe(true);
  });
  it("fail-closed: a garbage role is treated as viewer everywhere", () => {
    expect(roleDenies("/api/spawner/spawn", "POST", "wat")).toBe(true); // viewer denied
    expect(roleDenies("/api/spawner/status", "GET", "wat")).toBe(false); // read ok
    expect(roleDenies("/api/users", "GET", "wat")).toBe(true);
  });
});

describe("routeRequest — RBAC matrix (enabled, full session)", () => {
  const roles = { viewer, operator, admin: good };

  it("admin-only page /users: admin passes, operator/viewer redirect home", () => {
    expect(routeRequest("/users", "", "GET", enabled(good))).toEqual({ kind: "pass" });
    expect(routeRequest("/users", "", "GET", enabled(operator))).toEqual({ kind: "redirect", location: "/" });
    expect(routeRequest("/users", "", "GET", enabled(viewer))).toEqual({ kind: "redirect", location: "/" });
    // garbage role is viewer → redirected too
    expect(routeRequest("/users", "", "GET", enabled(garbage))).toEqual({ kind: "redirect", location: "/" });
  });

  it("non-admin page /cockpit passes for every role", () => {
    for (const s of Object.values(roles)) {
      expect(routeRequest("/cockpit", "", "GET", enabled(s))).toEqual({ kind: "pass" });
    }
  });

  it("backend GET (a read) proxies for every role", () => {
    for (const s of Object.values(roles)) {
      expect(routeRequest("/api/signals", "", "GET", enabled(s))).toEqual({ kind: "backend" });
    }
  });

  it("backend POST (R3 mutation): operator+admin proxy, viewer 403 role_denied", () => {
    expect(routeRequest("/api/spawner/spawn", "", "POST", enabled(good))).toEqual({ kind: "backend" });
    expect(routeRequest("/api/spawner/spawn", "", "POST", enabled(operator))).toEqual({ kind: "backend" });
    expect(routeRequest("/api/spawner/spawn", "", "POST", enabled(viewer))).toEqual({
      kind: "forbidden",
      reason: "role_denied",
    });
  });

  it("admin-path GET (R1): admin proxies, operator/viewer 403 role_denied", () => {
    expect(routeRequest("/api/users", "", "GET", enabled(good))).toEqual({ kind: "backend" });
    expect(routeRequest("/api/users", "", "GET", enabled(operator))).toEqual({
      kind: "forbidden",
      reason: "role_denied",
    });
    expect(routeRequest("/api/users", "", "GET", enabled(viewer))).toEqual({
      kind: "forbidden",
      reason: "role_denied",
    });
  });

  it("kill vs rearm: operator halts (kill) but cannot rearm", () => {
    expect(routeRequest("/api/cockpit/kill", "", "POST", enabled(operator))).toEqual({ kind: "backend" });
    expect(routeRequest("/api/cockpit/rearm", "", "POST", enabled(operator))).toEqual({
      kind: "forbidden",
      reason: "role_denied",
    });
    expect(routeRequest("/api/cockpit/rearm", "", "POST", enabled(good))).toEqual({ kind: "backend" });
  });

  it("R2 exchange-keys mutation: operator 403, admin proxies", () => {
    expect(routeRequest("/api/settings/exchange-keys", "", "POST", enabled(operator))).toEqual({
      kind: "forbidden",
      reason: "role_denied",
    });
    expect(routeRequest("/api/settings/exchange-keys", "", "POST", enabled(good))).toEqual({ kind: "backend" });
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
    "/icon-192.png",
    "/icon-512.png",
    "/icon-maskable-192.png",
    "/icon-maskable-512.png",
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

describe("bootstrap is not an expired session", () => {
  // A first-run operator (users table empty) refused a mutation used to receive
  // the same {kind:"unauthorized"} as someone whose session lapsed. With the R2
  // banner live that renders "Session expired — sign in again" and links to
  // /login, where they CANNOT log in because no account exists. They need
  // /setup. The refusal is right; the explanation was wrong.
  it("tags a bootstrap refusal so the client can say something true", () => {
    const bootstrap: AuthState = { mode: "bootstrap" };
    const r = routeRequest("/api/spawner/x", "", "POST", bootstrap);
    expect(r).toEqual({ kind: "unauthorized", reason: "bootstrap" });
  });

  it("does NOT tag an ordinary session denial", () => {
    // The session banner must still fire for the case it was built for.
    const noSession: AuthState = { mode: "enabled", session: null } as AuthState;
    const r = routeRequest("/api/spawner/x", "", "POST", noSession);
    expect(r).toEqual({ kind: "unauthorized" });
    expect((r as { reason?: string }).reason).toBeUndefined();
  });

  it("still lets harmless bootstrap GETs through — the refusal is unchanged", () => {
    const bootstrap: AuthState = { mode: "bootstrap" };
    expect(routeRequest("/api/signals", "", "GET", bootstrap)).toEqual({ kind: "backend" });
  });
});
