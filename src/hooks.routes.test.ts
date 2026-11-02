// API v1 at the hook: the spawner surface is the route registry's, and
// nothing else reaches the spawner. Drives the real dispatcher like
// hooks.sessionHeader.test.ts (env set before a dynamic import).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.SPAWNER_INTERNAL_URL = "http://spawner.test";
process.env.INTERNAL_TOKEN = "trusted-internal-token";

type Proxy = (event: unknown, auth?: unknown) => Promise<Response>;
let proxyBackend: Proxy;
let apiV1Path: (p: string) => string | null;

beforeAll(async () => {
  const mod = (await import("./hooks.server")) as unknown as { proxyBackend: Proxy; apiV1Path: typeof apiV1Path };
  proxyBackend = mod.proxyBackend;
  apiV1Path = mod.apiV1Path;
});

afterEach(() => vi.unstubAllGlobals());

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

const session = (role: string) => ({
  mode: "enabled",
  session: { username: "u", role, mustChange: false, via: "cookie" },
});

function upstream() {
  const f = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", f);
  return f;
}

describe("the spawner surface is the registry's", () => {
  it("an unregistered path is a 404 that never reaches the spawner", async () => {
    const f = upstream();
    const res = await proxyBackend(makeEvent("/api/spawner/events", "POST", { event: "edge_decay" }), session("admin"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_route");
    const odd = await proxyBackend(makeEvent("/api/spawner//ladder"), session("admin"));
    expect(odd.status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it("a registered path with another method is a 405", async () => {
    const f = upstream();
    const res = await proxyBackend(makeEvent("/api/spawner/ladder", "DELETE"), session("admin"));
    expect(res.status).toBe(405);
    expect(f).not.toHaveBeenCalled();
  });

  it("a registered route below its role is refused before the spawner", async () => {
    const f = upstream();
    const res = await proxyBackend(makeEvent("/api/spawner/secrets/kraken", "DELETE"), session("operator"));
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toContain("needs admin");
    expect(f).not.toHaveBeenCalled();
  });

  it("a registered route is forwarded", async () => {
    const f = upstream();
    const res = await proxyBackend(makeEvent("/api/spawner/ladder?x=1"), session("viewer"));
    expect(res.status).toBe(200);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("http://spawner.test/ladder?x=1");
  });

  it("serves the OpenAPI document", async () => {
    const res = await proxyBackend(makeEvent("/api/openapi.json"), session("viewer"));
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/api/v1/spawner/ladder"].get["x-min-role"]).toBe("viewer");
  });

  it("/api/v1/<x> is /api/<x>", () => {
    expect(apiV1Path("/api/v1/spawner/ladder")).toBe("/api/spawner/ladder");
    expect(apiV1Path("/api/v1/openapi.json")).toBe("/api/openapi.json");
    expect(apiV1Path("/api/v1")).toBe("/api/openapi.json");
    expect(apiV1Path("/api/spawner/ladder")).toBeNull();
    expect(apiV1Path("/api/v10/x")).toBeNull();
  });
});
