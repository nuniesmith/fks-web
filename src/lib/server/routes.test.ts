import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { roleDenies, routeRequest, type Role } from "./adapter";
import { APP_ROUTES, SPAWNER_ROUTES, matchAppRoute, matchSpawnerRoute, openapi, spawnerPathExists } from "./routes";

/** A file's code without its comments (block, line and HTML), so a path
 *  named in prose isn't read as a call. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Every source file under src/, except tests and the server's own code. */
function sources(dir = "src"): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) && !p.includes("lib/server") && !/(^|\/)hooks\./.test(name) ? [p] : [];
  });
}

/** The spawner paths the UI calls: `${BASE}/…` in the client, `/api/spawner/…` anywhere. */
function uiSpawnerPaths(): Set<string> {
  const out = new Set<string>();
  for (const file of sources()) {
    const text = code(readFileSync(file, "utf8"));
    const base = file.endsWith("api/spawner.ts");
    const re = base ? /\$\{BASE\}(\/[^`"'\s]*)/g : /\/api\/spawner(\/[A-Za-z0-9_./${}()-]*)/g;
    for (const m of text.matchAll(re)) {
      let path = m[1]
        .replace(/(?<!\/)\$\{[^}]*\}?/g, "") // interpolated onto a segment: a query string
        .replace(/\$\{[^}]*\}?/g, "x") // an interpolated segment
        .replace(/\{[a-z_]+\}/gi, "x") // a {placeholder} in a comment-free literal
        .split("?")[0]
        .replace(/[^A-Za-z0-9_/.-]+$/, "");
      if (path.endsWith("/")) path = path.slice(0, -1); // a prefix built on (`/api/spawner/` + …)
      if (path) out.add(path);
    }
  }
  return out;
}

describe("the route registry (API v1)", () => {
  it("every spawner call the UI makes is a registered route", () => {
    const calls = uiSpawnerPaths();
    expect(calls.size).toBeGreaterThan(30);
    const missing = [...calls].filter((p) => !spawnerPathExists(p));
    expect(missing).toEqual([]);
  });

  it("each route's role agrees with the prefix rules it replaces (the oracle)", () => {
    const roles: Role[] = ["viewer", "operator", "admin"];
    const disagree: string[] = [];
    for (const route of SPAWNER_ROUTES) {
      const path = "/api/spawner" + route.path.replace(/\{[^}]+\}/g, "x");
      for (const role of roles) {
        const registry = ["viewer", "operator", "admin"].indexOf(role) >= ["viewer", "operator", "admin"].indexOf(route.minRole);
        const prefix = !roleDenies(path, route.method, role);
        if (registry !== prefix) disagree.push(`${route.method} ${route.path} as ${role}: registry ${registry}, rules ${prefix}`);
      }
    }
    expect(disagree).toEqual([]);
  });

  it("is unique, and every route is in the OpenAPI document", () => {
    const keys = SPAWNER_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const doc = openapi() as { paths: Record<string, Record<string, { "x-min-role": string }>> };
    for (const r of SPAWNER_ROUTES) {
      expect(doc.paths[`/api/v1/spawner${r.path}`]?.[r.method.toLowerCase()]?.["x-min-role"]).toBe(r.minRole);
    }
  });

  it("matches one segment per placeholder, the method, and nothing loose", () => {
    expect(matchSpawnerRoute("GET", "/ladder")?.path).toBe("/ladder");
    expect(matchSpawnerRoute("HEAD", "/ladder")?.path).toBe("/ladder");
    expect(matchSpawnerRoute("POST", "/deployments/7/promote")?.guard).toBe("promotion");
    expect(matchSpawnerRoute("GET", "/deployments/7/promote")).toBeNull();
    expect(matchSpawnerRoute("POST", "/events")).toBeNull(); // the bots' ingest stays internal
    expect(matchSpawnerRoute("GET", "/ladder/")).toBeNull();
    expect(matchSpawnerRoute("GET", "//ladder")).toBeNull();
    expect(matchSpawnerRoute("GET", "/container/a/b/logs")).toBeNull();
    expect(matchSpawnerRoute("DELETE", "/secrets/kraken")?.minRole).toBe("admin");
    expect(spawnerPathExists("/deployments/7/promote")).toBe(true);
  });

  it("every other backend call the UI makes is a registered app route", () => {
    const calls = new Set<string>();
    for (const file of sources()) {
      const text = code(readFileSync(file, "utf8"));
      for (const m of text.matchAll(/["'`]((?:\/api|\/bars|\/sse)\/[A-Za-z0-9_./${}()-]*)/g)) {
        if (m[1].startsWith("/api/spawner") || m[1].startsWith("/api/v1/")) continue;
        let path = m[1]
          .replace(/(?<!\/)\$\{[^}]*\}?/g, "")
          .replace(/\$\{[^}]*\}?/g, "x")
          .split("?")[0]
          .replace(/[^A-Za-z0-9_/.-]+$/, "");
        if (path.endsWith("/")) path = path.slice(0, -1);
        calls.add(path);
      }
    }
    expect(calls.size).toBeGreaterThan(10);
    const known = (p: string) => APP_ROUTES.some((r) => matchAppRoute(r.method, p) !== null);
    expect([...calls].filter((p) => !known(p))).toEqual([]);
  });

  it("each app route's role and session rule agree with routeRequest", () => {
    const disagree: string[] = [];
    const order = ["viewer", "operator", "admin"];
    for (const route of APP_ROUTES) {
      const path = route.path.replace(/\{[^}]+\}/g, "1");
      for (const role of order as Role[]) {
        for (const via of ["cookie", "token"] as const) {
          const auth = { mode: "enabled", session: { username: "u", role, mustChange: false, via } } as never;
          const allowed = routeRequest(path, "", route.method, auth).kind === "backend";
          const registry =
            order.indexOf(role) >= order.indexOf(route.minRole) && !(route.sessionOnly && via === "token");
          if (allowed !== registry) disagree.push(`${route.method} ${route.path} ${role}/${via}: ${allowed} vs ${registry}`);
        }
      }
    }
    expect(disagree).toEqual([]);
  });

  it("the document covers the app routes under /api/v1", () => {
    const doc = openapi() as { paths: Record<string, Record<string, unknown>> };
    expect(doc.paths["/api/v1/alerts/ack"]?.post).toBeDefined();
    expect(doc.paths["/bars/{symbol}/candles"]?.get).toBeDefined();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(70);
  });
});
