import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { api, ApiError } from "./client";
import { SESSION_HEADER, SESSION_REQUIRED, sessionExpired } from "$stores/session";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A minimal Response stand-in (the client only touches ok/status/statusText/text).
function res(
  body: unknown,
  init: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: new Headers(init.headers ?? {}),
    text: () => Promise.resolve(text),
  };
}

describe("api client", () => {
  it("GET parses a JSON response", async () => {
    mockFetch.mockResolvedValue(res({ value: 1 }));
    const out = await api.get<{ value: number }>("/api/x");
    expect(out).toEqual({ value: 1 });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/x");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers.Accept).toBe("application/json");
  });

  it("POST serialises the body and sets content-type", async () => {
    mockFetch.mockResolvedValue(res({ ok: true }));
    await api.post("/api/y", { a: 1 });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("throws ApiError carrying status / statusText / body on a non-2xx", async () => {
    mockFetch.mockResolvedValue(
      res("nope", { ok: false, status: 503, statusText: "Service Unavailable" }),
    );
    await expect(api.get("/api/z")).rejects.toBeInstanceOf(ApiError);

    mockFetch.mockResolvedValue(
      res("boom", { ok: false, status: 500, statusText: "Server Error" }),
    );
    try {
      await api.get("/api/z");
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(500);
      expect(err.statusText).toBe("Server Error");
      expect(err.body).toBe("boom");
    }
  });

  it("returns {} for an empty response body", async () => {
    mockFetch.mockResolvedValue(res("", {}));
    expect(await api.get("/api/empty")).toEqual({});
  });

  it("DELETE issues a DELETE with no body", async () => {
    mockFetch.mockResolvedValue(res({}));
    await api.delete("/api/d");
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("passes an AbortSignal so the request can time out", async () => {
    mockFetch.mockResolvedValue(res({}));
    await api.get("/api/x");
    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — session expiry vs a proxied upstream 401.
//
// The adapter is a PROXY: it streams upstream statuses back verbatim, so a
// spawner X-Internal-Token mismatch reaches the browser as a 401 too. Keying
// the banner off a bare 401 would say "sign in again" for a backend credential
// fault that signing in cannot fix — and an operator who has been lied to once
// ignores the banner the month their session actually expires.
// ─────────────────────────────────────────────────────────────────────────────
describe("session-expiry signal", () => {
  beforeEach(() => {
    sessionExpired.set(false);
  });
  afterEach(() => {
    sessionExpired.set(false);
  });

  it("401 + x-fks-auth: session-required sets sessionExpired AND still throws", async () => {
    mockFetch.mockResolvedValue(
      res({ error: "unauthorized" }, {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { [SESSION_HEADER]: SESSION_REQUIRED },
      }),
    );
    // The throw contract is unchanged — callers keep their ApiError.
    await expect(api.get("/api/cockpit/state")).rejects.toBeInstanceOf(ApiError);
    expect(get(sessionExpired)).toBe(true);
  });

  it("a PROXIED upstream 401 (spawner token mismatch) does NOT set it", async () => {
    mockFetch.mockResolvedValue(
      res({ error: "unauthorized" }, {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    await expect(api.get("/api/spawner/bots")).rejects.toBeInstanceOf(ApiError);
    expect(get(sessionExpired)).toBe(false);
  });

  it("403 role_denied and 502 upstream_unreachable do NOT set it", async () => {
    mockFetch.mockResolvedValue(
      res({ error: "forbidden", reason: "role_denied" }, {
        ok: false,
        status: 403,
        statusText: "Forbidden",
      }),
    );
    await expect(api.post("/api/cockpit/rearm", {})).rejects.toBeInstanceOf(ApiError);
    expect(get(sessionExpired)).toBe(false);

    mockFetch.mockResolvedValue(
      res({ error: "upstream_unreachable" }, {
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      }),
    );
    await expect(api.get("/api/health")).rejects.toBeInstanceOf(ApiError);
    expect(get(sessionExpired)).toBe(false);
  });

  it("a 2xx does not clear it — /api/health is PUBLIC and would wipe the banner", async () => {
    // StatusBar polls /api/health through this client every cycle, and the
    // adapter serves it unauthenticated (PUBLIC_EXACT). If a success cleared
    // the flag, the banner would vanish seconds after appearing while the
    // session was still dead. Stickiness is the safe direction.
    sessionExpired.set(true);
    mockFetch.mockResolvedValue(res({ ok: true }));
    await api.get("/api/health");
    expect(get(sessionExpired)).toBe(true);
  });
});
